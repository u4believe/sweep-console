import "dotenv/config";
import dns from "dns";
// WSL2 cannot reach IPv6 external addresses — prefer IPv4 for all DNS lookups
dns.setDefaultResultOrder("ipv4first");
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { authRouter } from "./routes/auth";
import { plansRouter } from "./routes/plans";
import { mandatesRouter } from "./routes/mandates";
import { chargesRouter } from "./routes/charges";
import { subscriptionsRouter } from "./routes/subscriptions";
import { paymentsRouter } from "./routes/payments";
import { webhooksRouter } from "./routes/webhooks";
import { checkoutRouter } from "./routes/checkout";
import { portalRouter } from "./routes/portal";
import { publicRouter } from "./routes/public";
import { customerPortalRouter } from "./routes/customer-portal";
import { gatewayRouter } from "./routes/gateway";
import { delegationRouter } from "./routes/delegation";
import { authorizeRouter } from "./routes/authorize";
import { devRouter } from "./routes/dev";
import { IS_DEV, DEV_ROUTES_ENABLED } from "./lib/env";
import { circleWebhooksRouter } from "./routes/circle-webhooks";
import { apiLimiter, authLimiter } from "./middleware/rateLimit";
import { startBillingEngine } from "./billing/scheduler";
import { prisma } from "./lib/prisma";
import { isMainnet } from "./lib/gateway/chains";
import { directSettlementEnabled } from "./lib/chain/direct-settlement";

const app = express();
// Railway (and any PaaS) puts a proxy in front, so the client address arrives in
// X-Forwarded-For. Without this, express reports the proxy's address for every
// request and the rate limiters below would bucket the whole world together.
// `1` — trust exactly one hop — rather than `true`, which lets a caller spoof its
// own address by sending the header itself.
app.set("trust proxy", 1);

/**
 * No ETags. They are what kept the dashboard stale.
 *
 * Express hashes every JSON body into an ETag, and `Cache-Control: no-store`
 * does NOT stop a 304: the conditional check compares the request's
 * If-None-Match against that hash and answers 304 when they agree, without
 * consulting the response's cache headers at all. So a browser holding an old
 * copy kept revalidating into 304s and kept rendering the old copy — the
 * balance showed "0.00 USDC … cached" for fifteen hours against a wallet
 * holding 150.58, and adding no-store alone did not break the loop.
 *
 * Nothing this API serves benefits from them. Every response is either
 * per-merchant data that must not be cached, or a small public document where
 * re-sending the body costs less than the bug does.
 */
app.set("etag", false);
// Railway (and most PaaS) inject PORT; API_PORT is the local-dev override.
const PORT = process.env.PORT ?? process.env.API_PORT ?? 4000;

// Configured origins (comma-separated APP_URL / NEXT_PUBLIC_APP_URL).
const allowedOrigins = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// In development the Vite dev server may bind to any free port (3000, 3001, …),
// so allow any localhost/127.0.0.1 origin. Production stays restricted to the
// configured origins above.
const isDev = IS_DEV;
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Preview deployments, by exact suffix — never by wildcard.
 *
 * A Vercel preview gets a hashed host of its own
 * (sweep-console-3qtru0byc-<team>.vercel.app), so it is not APP_URL and was
 * refused. Which is correct by default: these responses carry credentials,
 * and allowing *.vercel.app would let ANY app on Vercel make authenticated
 * requests as a logged-in creator.
 *
 * So the suffix is configured, not inferred, and it must include the team
 * slug — that part is owned by one account and cannot be registered by
 * someone else, where a bare ".vercel.app" is shared by everyone.
 *
 *   CORS_PREVIEW_SUFFIXES=-believes-projects-837cfaa8.vercel.app
 *
 * Comma-separated. A suffix not starting with "." or "-" is rejected at boot
 * rather than quietly matching more than intended: "vercel.app" would admit
 * "evilvercel.app", and the whole point is that this list is narrow.
 */
const previewSuffixes = (process.env.CORS_PREVIEW_SUFFIXES ?? "")
  .split(",")
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);

for (const suffix of previewSuffixes) {
  if (!suffix.startsWith(".") && !suffix.startsWith("-")) {
    throw new Error(
      `CORS_PREVIEW_SUFFIXES entry "${suffix}" must start with "." or "-" so it cannot match a ` +
        `neighbouring domain — "vercel.app" would also admit "evilvercel.app"`
    );
  }
}

function isPreviewOrigin(origin: string): boolean {
  if (previewSuffixes.length === 0) return false;
  let host: string;
  try {
    const u = new URL(origin);
    // https only: a preview served over http would downgrade a credentialed
    // request, and Vercel serves https.
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return previewSuffixes.some((suffix) => host.endsWith(suffix));
}

// Allow the frontend to send cookies (credentials: 'include')
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (isDev && LOCALHOST_RE.test(origin)) return cb(null, true);
    if (isPreviewOrigin(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  // Load-bearing, not defence in depth. An earlier note here claimed the browser
  // never reaches this middleware because VITE_API_URL is the relative "/api" —
  // true in development, where Vite proxies it, and false in production, where
  // the web app is served from Vercel and VITE_API_URL is this absolute host.
  // Every portal request in production is cross-origin and preflighted, which a
  // live OPTIONS confirms: the configured origin gets the headers back and any
  // other origin is refused. So dropping x-step-up-token from this list breaks
  // every step-up replay with a bare "Failed to fetch" that looks exactly like
  // the API being down.
  allowedHeaders: ["Content-Type", "Authorization", "x-step-up-token"],
}));

app.use(cookieParser());

// Circle webhooks must be mounted before express.json() so they can read the raw body
// for asymmetric signature verification (X-Circle-Signature header).
app.use("/circle-webhooks", circleWebhooksRouter);

app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// Auth (signup, email verification, password setup)
app.use("/auth", authLimiter, authRouter);

// Portal (dashboard, settings, plans, subscriptions, payments, webhooks, wallet)
app.use("/portal", portalRouter);

// Public routes (checkout page data, checkout confirm)
app.use("/", publicRouter);

// Standalone customer portal (/manage): cross-merchant, email+OTP gated
app.use("/customer/portal", customerPortalRouter);

// Cross-chain checkout (Circle Gateway): balance scanner + sweep plan/execute
app.use("/", gatewayRouter);

// Tier-2 (ERC-7710): persist a one-time renewal-permission grant from checkout
app.use("/", delegationRouter);

// External rail: the page a subscriber signs a mandate on. Unauthenticated — the
// subscriber has no Sweep account; the link is the credential, as at checkout.
app.use("/", authorizeRouter);

// Dev-only diagnostics (e.g. the grant-test harness). These routes are
// unauthenticated and they seed, delete and settle real subscriptions against
// the shared database, so mounting them takes an explicit ENABLE_DEV_ROUTES=true
// on top of a non-production NODE_ENV — see lib/env.ts for why NODE_ENV is not
// trusted to carry that decision by itself.
if (DEV_ROUTES_ENABLED) {
  console.warn("[boot] dev diagnostics mounted at /dev/* — unauthenticated, ENABLE_DEV_ROUTES=true");
  app.use("/", devRouter);
}

// v1 merchant API (API-key authenticated)
app.use("/v1", apiLimiter);
app.use("/v1/plans", plansRouter);
app.use("/v1/subscriptions", subscriptionsRouter);
app.use("/v1/payments", paymentsRouter);
app.use("/v1/webhooks", webhooksRouter);
app.use("/v1/checkout", checkoutRouter);
// External rail: mandates (the authorization a developer charges against). Every
// route also passes requireExternalRail, so an account that never asked for the
// rail cannot reach it.
app.use("/v1/mandates", mandatesRouter);
app.use("/v1/charges", chargesRouter);
// /v1/passport is retired: the Passport model is superseded by Customer, and the
// activate route never verified the wallet_signature it required.

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: { message: "Not found", code: "not_found" } });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api] unhandled error:", err);
  res.status(500).json({ error: { message: "Internal server error", code: "internal_error" } });
});

async function start() {
  let retries = 5;
  while (retries--) {
    try {
      await prisma.$connect();
      break;
    } catch (e) {
      // Say why. A cold TLS handshake to the pooler and a bad password both
      // land here, and without the reason they read as the same failure.
      const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
      console.warn(`[api] DB connect failed (${why}), ${retries} retries left…`);
      if (retries === 0) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const server = app.listen(PORT, () => {
    console.log(`[api] Sweep Console API running on port ${PORT}`);
    /**
     * The mode and the host links will carry, on the first lines of the log.
     *
     * These two disagreeing is a whole class of fault that presents as a
     * broken feature: a sandbox service carrying the live app URL builds
     * sandbox payment links that open the live frontend, which asks the live
     * API for an id it has never seen and renders "link unavailable". The
     * mismatch is invisible from either side, so it goes in the boot log
     * where a deploy is already being watched.
     */
    const linkHost = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    console.log(
      `[api] mode=${isMainnet() ? "live" : "test"} links=${linkHost} ` +
        `settlement=${directSettlementEnabled() ? "direct" : "bridged"}`
    );
  });

  // Single-service deploys (e.g. one Railway service) run the billing engine
  // in-process: escrow settlement (hourly), renewals (daily), trial transitions,
  // webhook retries. Opt-in so a separate worker can own it instead — never both,
  // or the crons double up. Without this, payments never leave escrow → pending.
  if (process.env.BILLING_IN_PROCESS === "true") {
    startBillingEngine();
  }

  // Release DB connections on shutdown. `tsx watch` SIGTERMs the old process on
  // every file change; without this the connections linger on the pooler and,
  // after enough restarts, exhaust its limit (Prisma P2024: pool timeout).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} — closing server + DB connections`);
    server.close();
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((e) => {
  console.error("[api] failed to start:", e);
  process.exit(1);
});

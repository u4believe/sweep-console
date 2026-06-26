import "dotenv/config";
import dns from "dns";
// WSL2 cannot reach IPv6 external addresses — prefer IPv4 for all DNS lookups
dns.setDefaultResultOrder("ipv4first");
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { authRouter } from "./routes/auth";
import { plansRouter } from "./routes/plans";
import { subscriptionsRouter } from "./routes/subscriptions";
import { paymentsRouter } from "./routes/payments";
import { webhooksRouter } from "./routes/webhooks";
import { checkoutRouter } from "./routes/checkout";
import { passportRouter } from "./routes/passport";
import { portalRouter } from "./routes/portal";
import { publicRouter } from "./routes/public";
import { customerPortalRouter } from "./routes/customer-portal";
import { gatewayRouter } from "./routes/gateway";
import { delegationRouter } from "./routes/delegation";
import { devRouter } from "./routes/dev";
import { circleWebhooksRouter } from "./routes/circle-webhooks";
import { startBillingEngine } from "./billing/scheduler";
import { prisma } from "./lib/prisma";

const app = express();
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
const isDev = process.env.NODE_ENV !== "production";
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Allow the frontend to send cookies (credentials: 'include')
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (isDev && LOCALHOST_RE.test(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
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
app.use("/auth", authRouter);

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

// Dev-only diagnostics (e.g. the grant-test harness) — never in production
if (process.env.NODE_ENV !== "production") {
  app.use("/", devRouter);
}

// v1 merchant API (API-key authenticated)
app.use("/v1/plans", plansRouter);
app.use("/v1/subscriptions", subscriptionsRouter);
app.use("/v1/payments", paymentsRouter);
app.use("/v1/webhooks", webhooksRouter);
app.use("/v1/checkout", checkoutRouter);
app.use("/v1/passport", passportRouter);

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
      console.warn(`[api] DB connect failed, ${retries} retries left…`);
      if (retries === 0) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const server = app.listen(PORT, () => {
    console.log(`[api] Sweep Console API running on port ${PORT}`);
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

import { createHmac } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { isMainnet } from "../lib/gateway/chains";
import { prisma } from "../lib/prisma";
import { err } from "../lib/response";
import type { Merchant } from "@prisma/client";

/**
 * The other deployment's address, for an error that fixes itself.
 *
 * Overridable because a preview deployment is neither of these, and telling a
 * developer to send their key to production would be worse than saying
 * nothing.
 */
const LIVE_API_URL = process.env.LIVE_API_URL ?? "https://api.sweepconsole.xyz";
const SANDBOX_API_URL = process.env.SANDBOX_API_URL ?? "https://api-sandbox.sweepconsole.xyz";

export interface AuthedRequest extends Request {
  merchant: Merchant;
  isTestMode: boolean;
}

/**
 * The filter every merchant-scoped read must carry.
 *
 * A merchant holds a test key and a live key at once, and a query made with
 * one must not see the other's rows. `isTestMode` is written on every row of
 * the six models that have it and was read back by nothing: a live key listed
 * test mandates, and the charge path found a test mandate by id and charged it
 * while labelling the result live.
 *
 * A helper rather than `isTestMode` typed into 37 `where` clauses, because a
 * missed clause fails SILENTLY — nothing errors, no test goes red, a merchant
 * simply sees rows they should not, possibly for months. One greppable call
 * means an endpoint that skipped it is visible in review.
 *
 * Only for models that HAVE the column. Plan and WebhookEndpoint do not, and
 * cannot be scoped until someone decides whether a live merchant sees the
 * plans they built while testing, and whether a webhook endpoint belongs to
 * one mode (its signing secret is per endpoint, so sharing one signs live and
 * test deliveries with the same secret).
 */
export function merchantScope(req: Request): { merchantId: string; isTestMode: boolean } {
  const { merchant, isTestMode } = req as AuthedRequest;
  return { merchantId: merchant.id, isTestMode };
}

export async function verifyApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    err(res, "Missing or malformed Authorization header", 401);
    return;
  }

  const rawKey = authHeader.slice("Bearer ".length).trim();
  if (!rawKey) {
    err(res, "Empty API key", 401);
    return;
  }

  const isTestKey = rawKey.startsWith("test_");
  const isLiveKey = rawKey.startsWith("live_");

  if (!isTestKey && !isLiveKey) {
    err(res, "Invalid API key format", 401);
    return;
  }

  /**
   * A deployment accepts ONE kind of key, and which one follows from the
   * network it runs on.
   *
   * isMainnet() already decides the chain set, the CCTP attestation host, the
   * Arc RPC and the contract addresses. Deriving the accepted prefix from the
   * same switch means the two cannot drift: there is no configuration in which
   * a deployment talks to Base Sepolia and honours live keys.
   *
   * It matters because a key carries no network of its own. A live_ key
   * accepted here would create a mandate on Base SEPOLIA and label it live,
   * and the error for that arrives much later, as a charge that settles
   * nowhere a merchant can find.
   *
   * The message names the other host rather than saying no, because the whole
   * cause is usually one environment variable pointing at the wrong place.
   */
  const liveDeployment = isMainnet();
  if (isLiveKey && !liveDeployment) {
    err(
      res,
      `This is the sandbox, which only accepts test keys. Send live keys to ${LIVE_API_URL}.`,
      403,
      "wrong_environment"
    );
    return;
  }
  if (isTestKey && liveDeployment) {
    err(
      res,
      `This is the live API, which only accepts live keys. Send test keys to ${SANDBOX_API_URL}.`,
      403,
      "wrong_environment"
    );
    return;
  }

  const secret = process.env.PLATFORM_API_SIGNING_SECRET;
  if (!secret) {
    // Not the caller's problem and not the caller's business: they get the same
    // sentence as any other outage, while the log says exactly what is missing.
    console.error("[auth/api-key] PLATFORM_API_SIGNING_SECRET is not set — every API key will be refused");
    err(res, "Something went wrong on our end. Please try again in a moment.", 500);
    return;
  }

  const expected = createHmac("sha256", secret).update(rawKey).digest("hex");

  // Looked up by hash rather than scanned. This used to select every merchant
  // row — including passwordHash and webhookSecret — on every single API request
  // and compare in Node: the whole credential table in process memory, once per
  // call, to authenticate one key. The stored value is a deterministic HMAC of
  // the presented key, so an equality lookup finds the same row and leaks
  // nothing a timing-safe compare was protecting: the attacker would have to
  // guess the HMAC output, not walk it byte by byte, and the comparison happens
  // in the database over a hash of a secret it does not hold.
  const merchant = await prisma.merchant.findFirst({
    where: isLiveKey ? { liveKeyHash: expected } : { testKeyHash: expected },
  });

  if (!merchant) {
    /**
     * Prefix-aware, because "Invalid API key" sends someone hunting for a typo
     * in a key that may never have been issuable.
     *
     * Nothing writes Merchant.liveKeyHash until portal issuance lands, so on a
     * live deployment before that, EVERY live key reaches here. Saying where
     * the key comes from is the difference between a minute and an afternoon.
     */
    err(
      res,
      isLiveKey
        ? "No live key matches. Create one in the dashboard under API Keys — a live key is " +
            "separate from your test key and is shown once."
        : "Invalid API key",
      401
    );
    return;
  }

  if (isLiveKey && !merchant.isLive) {
    err(res, "Live API key is not active for this account", 403);
    return;
  }

  (req as AuthedRequest).merchant = merchant;
  (req as AuthedRequest).isTestMode = isTestKey;
  next();
}

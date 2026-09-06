// Request limits.
//
// Until now nothing in this API was rate limited, which was survivable while the
// worst a caller could do with a stolen API key was read data, cancel a
// subscription, or refund escrow back to the subscriber it came from. Nothing in
// that list enriches an attacker.
//
// That stops being true the moment a charge endpoint exists: a key would then pull
// USDC from every mandate the merchant holds. Limits are cheap now and awkward to
// retrofit under load, so they go in ahead of the endpoint that needs them.
//
// SCOPE: the default store counts in memory, per process. With one instance that
// is exact; with several, the effective ceiling multiplies by the instance count.
// It still turns "unbounded" into "bounded", which is the point — but a shared
// store (Redis, or a Postgres-backed counter) is the upgrade if this ever runs on
// more than one replica AND the limits need to be exact rather than indicative.

import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import type { Request } from "express";

/// Callers are told what happened and when to come back, in the same error shape
/// every other route returns, so a client parses one thing.
function handler(_req: Request, res: Parameters<Options["handler"]>[1]) {
  res.status(429).json({
    error: {
      message: "Too many requests. Wait a moment and try again.",
      code: "rate_limited",
    },
  });
}

const base = {
  standardHeaders: true as const,
  legacyHeaders: false as const,
  handler,
};

/**
 * Key on the API key when there is one, falling back to IP.
 *
 * A merchant behind one NAT should not be throttled by another merchant's traffic,
 * and an attacker rotating IPs should not get a fresh budget per address. Only the
 * hash is kept — never the key itself, which must not sit in a limiter's memory.
 *
 * `ipKeyGenerator` is the library's own helper: it normalises IPv6 to a /56 prefix,
 * so a caller with a routable v6 range cannot mint unlimited keys by varying the
 * host portion of its address.
 */
function byApiKeyOrIp(req: Request): string {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) {
    const key = auth.slice(7).trim();
    // Cheap, non-reversible, and stable per key — enough to bucket by.
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
    return `k:${h}`;
  }
  return `i:${ipKeyGenerator(req.ip ?? "")}`;
}

/// The merchant API. Generous — normal integrations poll, and a limit that trips
/// during ordinary use trains people to retry harder.
export const apiLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
  keyGenerator: byApiKeyOrIp,
});

/**
 * Anything that authenticates a person, sends a code, or verifies one.
 *
 * Tight on purpose: these are the endpoints where a limit is the control that
 * makes the secret behind them small enough to be usable. A six-digit code is only
 * safe while guesses are rationed.
 */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true, // only failures count, so a busy legitimate user is unaffected
});

/**
 * Endpoints that move money on a caller's instruction.
 *
 * Nothing is mounted here yet — the charge endpoint arrives in phase 04. Defined
 * now so the ceiling is a deliberate decision made while thinking about it, rather
 * than one improvised on the day the endpoint ships.
 */
export const chargeLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 60,
  keyGenerator: byApiKeyOrIp,
});

// Cloudflare Turnstile server-side verification.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// A Turnstile widget on the client produces a one-time token; we POST it (plus the
// secret key) to Cloudflare's siteverify endpoint, which confirms the challenge was
// solved for our site. The token is single-use and short-lived.
//
// If TURNSTILE_SECRET_KEY is unset (e.g. local dev), verification is SKIPPED so the
// flow keeps working without configuring Cloudflare. Set the key in production to
// enforce. When the key IS set we fail closed: a missing/invalid token, or an
// unreachable Cloudflare, is rejected.
import type { Request } from "express";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

export type TurnstileVerdict = { ok: true } | { ok: false; reason: string };

export async function verifyTurnstile(
  token: string | undefined,
  remoteIp?: string
): Promise<TurnstileVerdict> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true }; // not configured → skip (dev convenience)
  if (!token) return { ok: false, reason: "missing-token" };

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);

    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as SiteVerifyResponse;
    if (data.success) return { ok: true };
    return { ok: false, reason: (data["error-codes"] ?? ["verification-failed"]).join(",") };
  } catch (e) {
    console.error("[turnstile] verify error:", (e as Error).message);
    return { ok: false, reason: "verify-unreachable" }; // fail closed
  }
}

/** True when Turnstile is configured (and therefore enforced) on this server. */
export function turnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

/** Best-effort client IP for the optional `remoteip` siteverify field. */
export function clientIp(req: Request): string | undefined {
  const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return fwd || req.socket.remoteAddress || undefined;
}

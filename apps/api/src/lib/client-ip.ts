import type { Request } from "express";

// Who the caller actually is, once there are proxies in front of us.
//
// `app.set("trust proxy", 1)` trusts exactly one hop, which was right while
// Railway was the only thing in front of the app. Putting the API behind
// Cloudflare's proxy adds a second: the chain is now client → Cloudflare →
// Railway → app, so the address Express derives is Cloudflare's edge rather
// than the visitor's.
//
// That matters most to the limiter guarding login, signup and the checkout OTP.
// It rations guesses at a six-digit code, and it keys on the address — so if
// every request appears to come from one of a handful of Cloudflare IPs, every
// visitor shares one bucket and twenty failed logins anywhere lock out everyone.
//
// Cloudflare writes `CF-Connecting-IP` itself and overwrites whatever the caller
// sent, so on a proxied host it is authoritative. On a host reachable directly —
// and the generated railway.app domain still is — the same header is just a
// string the caller chose, and trusting it would hand an attacker a fresh
// rate-limit bucket per forged value. So it is trusted per hostname, never
// globally.
const CF_PROXIED_HOSTS = new Set(
  (process.env.CLOUDFLARE_PROXIED_HOSTS ?? "api.sweepconsole.xyz")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

export function clientIp(req: Request): string {
  const host = req.hostname?.toLowerCase();
  if (host && CF_PROXIED_HOSTS.has(host)) {
    const raw = req.headers["cf-connecting-ip"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) return value.trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? "";
}

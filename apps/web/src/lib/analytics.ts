// Privacy-friendly, cookieless web analytics via Umami (self-hosted or Umami
// Cloud), served FIRST-PARTY so ad-blockers can't block it.
//
// Both the tracker script and the event endpoint go through our own origin at
// `/insights/*`, which is proxied to the real Umami host (see vite.config
// server.proxy in dev; replicate as a host rewrite in production). Ad-blocker
// filter lists match the umami domain + script name, not a same-origin path.
//
//   VITE_UMAMI_WEBSITE_ID — the website id Umami gives you (required to load)
//   VITE_UMAMI_SHARE_URL  — the public share dashboard link (Umami → Edit → Share URL)
//   VITE_UMAMI_HOST       — upstream proxied to (build-time, see vite.config; default cloud)

const WEBSITE_ID = import.meta.env.VITE_UMAMI_WEBSITE_ID as string | undefined;

export const UMAMI_SHARE_URL = import.meta.env.VITE_UMAMI_SHARE_URL as string | undefined;

// Same-origin base that proxies to Umami — keeps the tracker invisible to ad-blockers.
const PROXY_BASE = "/insights";

/** Inject the (first-party) Umami tracker once, only when configured. */
export function initAnalytics(): void {
  if (!WEBSITE_ID) return;
  if (document.querySelector(`script[data-website-id="${WEBSITE_ID}"]`)) return;
  const s = document.createElement("script");
  s.async = true;
  s.defer = true;
  s.src = `${PROXY_BASE}/script.js`;
  s.setAttribute("data-website-id", WEBSITE_ID);
  // Send events to our own origin (proxied), not directly to the Umami host.
  s.setAttribute("data-host-url", window.location.origin + PROXY_BASE);
  document.head.appendChild(s);
}

// Recovering from a stale build.
//
// The app is code-split, so a deploy replaces hashed chunks. A page still
// running an older build asks for a file that is no longer deployed, and the
// dynamic import fails with "Failed to fetch dynamically imported module" —
// which reads like a network fault and sends people to check their connection.
//
// It surfaced on the Circle withdrawal, the one screen that imports on demand,
// so the failure lands after step-up has already succeeded, on the button that
// moves real USDC.
//
// A plain reload is not enough to fix it. The SPA shell is served from the CDN
// per-route, and a route whose cached entry carries a Last-Modified older than
// the deploy answers the browser's revalidation with 304 — so the browser keeps
// the stale HTML however many times it is refreshed. Observed in production with
// the Last-Modified moving BACKWARDS between requests (18:35 → 03:47 → 00:23) as
// different edge nodes answered with their own validators. Recovery therefore
// has to request a URL the cache has never seen.
//
// vercel.json is the other half: the shell is served no-store so there is no
// cached copy to go stale, and /assets/* is immutable because those names are
// content-hashed. If you are tempted to make the shell cacheable again, this is
// what it cost — three days of a withdrawal that could not open its own dialog.
// (That file is JSON and cannot carry the reasoning itself.)

const SIGNATURES = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "expected a javascript module script", // a rewrite answering with HTML
];

/// Set for the lifetime of the tab, so a genuinely broken deploy cannot put the
/// page in a reload loop: we try the cache-busting reload exactly once.
const RELOAD_FLAG = "sweep:stale-build-reload";

export function isStaleBuildError(e: unknown): boolean {
  const message = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return SIGNATURES.some((s) => message.includes(s));
}

export const STALE_BUILD_MESSAGE =
  "Sweep Console was updated and this page is still running the old version. " +
  "Reload to continue — nothing was charged or transferred.";

/**
 * Reloads once onto a URL the cache has not seen, returning true if it is doing
 * so. Callers show STALE_BUILD_MESSAGE when it returns false, which means the
 * reload was already tried and did not help — a real fault worth reporting
 * rather than something the reader can fix by refreshing again.
 */
export function recoverFromStaleBuild(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    // Private mode or blocked storage: without somewhere to record the attempt
    // a reload could loop, so decline and let the caller show the message.
    return false;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("v", Date.now().toString(36));
  window.location.replace(url.toString());
  return true;
}

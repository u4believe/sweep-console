// Recognising a stale-build failure.
//
// The app is code-split, so a deploy replaces hashed chunks. A tab that was open
// across that deploy — or a cached index.html — still names the old file, and the
// dynamic import for it fails. The browser's own words are
// "Failed to fetch dynamically imported module", which reads like a network fault
// and sends people to check their connection; nothing has gone wrong except that
// the page is out of date.
//
// It surfaced on the Circle withdrawal, where the SDK is imported on demand at
// the exact moment the merchant has already passed step-up — so the failure lands
// on the highest-stakes button in the portal, after the hardest part succeeded.

const SIGNATURES = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "expected a javascript module script", // the SPA rewrite answering with HTML
];

export function isStaleBuildError(e: unknown): boolean {
  const message = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return SIGNATURES.some((s) => message.includes(s));
}

/// What to say instead. Names the cause and the one action that fixes it — no
/// apology, and no suggestion that their payment or their funds are in doubt.
export const STALE_BUILD_MESSAGE =
  "Sweep Console was updated while this page was open, so part of it could not load. " +
  "Reload the page and try again — nothing was charged or transferred.";

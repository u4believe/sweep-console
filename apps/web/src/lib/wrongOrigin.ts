/**
 * Is this page being served from an origin the deployment is not configured
 * for — a Vercel preview, most often?
 *
 * One bundle serves several hosts. The API's CORS allowlist contains the real
 * domains and, when CORS_PREVIEW_SUFFIXES is set, preview hosts; anything
 * else has every request refused. A page in that state does not look like a
 * configuration problem — it looks like a broken feature, because what the
 * person sees is a wallet error, a missing balance, a grant that will not
 * authorize, or a checkout that says "link unavailable". Nothing points at
 * the address bar.
 *
 * It cost this project days. A checkout reached through the plan page's
 * Preview button inherits the Console's host, because that button is an
 * origin-relative router link while Copy and Open checkout both carry the
 * absolute URL the API built. So a Console opened from a Vercel deployment
 * link silently produced a preview-hosted checkout where nothing worked, and
 * the only trace was a CORS line in a server log nobody was reading.
 *
 * `app_url` from GET /config is what the API builds its OWN links with, so
 * comparing against it answers the question without any new configuration.
 */
export function wrongOriginWarning(appUrl: string | null): string | null {
  if (!appUrl || typeof window === "undefined") return null;
  let expected: string;
  try {
    expected = new URL(appUrl).origin;
  } catch {
    return null;
  }
  const here = window.location.origin;
  if (here === expected) return null;

  /**
   * Localhost is exempt. Development serves the app from 127.0.0.1 or
   * localhost on a port while the API reports the deployed host, and that is
   * normal rather than a fault — the dev server proxies /api.
   */
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(here)) return null;

  return (
    `This page is loaded from ${here}, but this deployment serves ${expected}. ` +
    `API calls from here are refused, so payments and wallet authorization will fail. ` +
    `Open ${expected} instead.`
  );
}

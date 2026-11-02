/**
 * Which deployment this bundle is — sandbox or live.
 *
 * The web app has no VITE_ARC_NETWORK; the API owns that, and every
 * mode-dependent thing inside the console is told by the server (isTestMode on
 * /portal/me, test_mode on a session). That is the right arrangement and this
 * does not change it.
 *
 * But the LANDING page talks about the product before anyone has signed in or
 * called anything, so the only signal available is a build-time one. Rather
 * than add another Vercel variable to keep in step — there are already two
 * that must agree, PLATFORM_FEE_BPS and VITE_PLATFORM_FEE_BPS, and they have
 * disagreed — this reads the API URL the deployment is already pointed at:
 *
 *   live     VITE_API_URL=https://api.sweepconsole.xyz
 *   sandbox  VITE_API_URL=https://api-sandbox.sweepconsole.xyz
 *
 * So the two cannot drift: a bundle that talks to the sandbox API is a sandbox
 * bundle by definition. A local dev build (localhost) counts as sandbox, which
 * is what you want when nothing real can be charged.
 *
 * VITE_SWEEP_MODE overrides it if a deployment ever needs to say so
 * explicitly — a preview branch pointed at live, say.
 */
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const OVERRIDE = import.meta.env.VITE_SWEEP_MODE as string | undefined;

/** True on the sandbox deployment and in local development. */
export function isSandboxBuild(): boolean {
  if (OVERRIDE === "live") return false;
  if (OVERRIDE === "sandbox" || OVERRIDE === "test") return true;
  return /sandbox|localhost|127\.0\.0\.1/i.test(API_URL);
}

/** `test_` on the sandbox, `live_` on live — the prefix ids.apiKey emits. */
export function keyPrefix(): "test_" | "live_" {
  return isSandboxBuild() ? "test_" : "live_";
}

/** `cs_test_` / `cs_live_`, the checkout-session prefix from ids.session. */
export function sessionPrefix(): string {
  return isSandboxBuild() ? "cs_test_" : "cs_live_";
}

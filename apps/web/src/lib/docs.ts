/**
 * Where the documentation lives.
 *
 * It used to be a route in this app. It is now its own VitePress site, so
 * every link to it is a real anchor rather than a react-router <Link> — a
 * <Link> whose `to` is an absolute URL is treated as a relative path and
 * silently navigates to /https:/docs.sweepconsole.xyz.
 *
 * Overridable so a preview deployment can point at a preview of the docs
 * rather than at production.
 */
export const DOCS_URL = import.meta.env.VITE_DOCS_URL ?? "https://docs.sweepconsole.xyz";

/**
 * Old in-page anchors, mapped to the pages they became.
 *
 * /docs was one page with ~23 sections, so every link anyone saved is of the
 * form /docs#rail-quickstart. Sending all of them to the docs home would be
 * the easy thing and would lose the part that made the link worth saving, so
 * the ids that had a section are mapped to the page that now holds it.
 *
 * Anything unrecognised — a renamed section, a typo, a bare /docs — lands on
 * the home page, which is the right answer for "we do not know what you meant".
 */
const SECTION_TO_PAGE: Record<string, string> = {
  // Orientation
  "two-ways": "/",
  // Hosted plans
  "creator-account": "/hosted/account",
  subscribing: "/hosted/subscribing",
  "email-verification": "/hosted/wallets",
  wallets: "/hosted/wallets",
  upgrading: "/hosted/changes",
  "pricing-changes": "/hosted/changes",
  "revenue-split": "/hosted/revenue",
  challenges: "/hosted/support",
  // The rail
  "rail-quickstart": "/rail/quickstart",
  "rail-overview": "/rail/overview",
  "rail-getting-started": "/rail/getting-started",
  "rail-example": "/rail/example",
  "rail-mandates": "/rail/mandates",
  "rail-authorize": "/rail/authorize",
  "rail-charges": "/rail/charges",
  "rail-limits": "/rail/limits",
  "rail-idempotency": "/rail/idempotency",
  "rail-notifications": "/rail/notifications",
  // Webhooks
  webhooks: "/webhooks/setup",
  "webhooks-code": "/webhooks/your-code",
  "webhooks-events": "/webhooks/events",
  "webhooks-payload": "/webhooks/payload",
  "webhooks-verify": "/webhooks/verify",
};

/** The docs URL an old `/docs#section` link should land on. */
export function docsUrlForHash(hash: string): string {
  const id = hash.replace(/^#/, "");
  return DOCS_URL + (SECTION_TO_PAGE[id] ?? "/");
}

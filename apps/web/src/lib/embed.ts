/**
 * The page's half of the embed protocol.
 *
 * `@sweepconsole/js` opens /authorize/:id in an iframe over the merchant's own
 * page and listens for what happens. This is the other end of that: the
 * handshake, the outbound events, and the escape hatch for when a wallet will
 * not talk to a framed page.
 *
 * It is deliberately a plain module rather than a hook with state — the
 * handshake must start as soon as the page loads, before React has decided
 * what to render, or the host sits watching an empty panel.
 *
 * FRAMING POLICY lives in apps/web/vercel.json, which cannot hold comments,
 * so it is explained here:
 *
 *   /authorize/*   frame-ancestors *      — meant to be framed
 *   everything else frame-ancestors 'none' — never
 *
 * The wildcard is deliberate, not an oversight. A merchant's site is any
 * origin and there is no list of them to allow. What makes it safe is that
 * the framed page carries no ambient authority: the mandate link in the URL
 * is the credential, the payer still signs in their own wallet, and the
 * handshake below only ever tells the host something it already knows.
 * Framing this page buys an attacker a page the payer must still sign in.
 *
 * The rest of the app is the opposite — clickjacking a dashboard or a hosted
 * checkout has obvious value and no legitimate use, and saying nothing is
 * what allows it. That half was previously unset.
 */

/** What the host sends and receives. Mirrored in packages/js/src/index.ts. */
type Outbound =
  | { source: "sweep"; type: "ready" }
  | { source: "sweep"; type: "authorized"; mandate: { mandate_id?: string } }
  | { source: "sweep"; type: "cancelled" };

/**
 * Framed by the embed, as opposed to merely being in some iframe.
 *
 * Both halves must be true. `embed=1` alone could be typed into the address
 * bar, and being framed alone happens to anyone the page is embedded by
 * without using the SDK — in neither case is there a host speaking this
 * protocol, and posting into the void is better avoided than handled.
 */
export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  let framed = false;
  try {
    framed = window.top !== window.self;
  } catch {
    // Cross-origin parent: the access throws, which itself proves we are framed.
    framed = true;
  }
  return framed && new URLSearchParams(window.location.search).has("embed");
}

/**
 * Opened by a framed page that could not reach a wallet.
 *
 * Distinct from `isEmbedded`: this window is top-level, so wallets work, but
 * it still has somewhere to report back to.
 */
export function isPopupChild(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("sweep_popup") && !!window.opener;
}

/**
 * The host's origin, once it has identified itself.
 *
 * Null until the handshake completes. Everything outbound waits for it rather
 * than posting to "*": the mandate id is not a secret, but "this payer just
 * authorized" is a message that switches a subscription on, and it should
 * only ever reach the page that opened us.
 */
let hostOrigin: string | null = null;
let started = false;

/**
 * Say hello and remember who answers.
 *
 * Called once, as early as possible. The "ready" goes out to "*" because at
 * that moment we do not yet know who framed us and the message carries
 * nothing — it is a knock on the door. The reply tells us the origin, and
 * every later message is addressed to exactly that.
 */
export function beginEmbedHandshake(): void {
  if (started || !isEmbedded()) return;
  started = true;

  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { source?: string; type?: string } | null;
    if (!msg || msg.source !== "sweep" || msg.type !== "host") return;
    // First answer wins. A second one, from anywhere, is ignored rather than
    // allowed to redirect where our events go.
    if (hostOrigin === null) hostOrigin = e.origin;
  });

  window.parent.postMessage({ source: "sweep", type: "ready" } satisfies Outbound, "*");
}

function post(message: Outbound): void {
  if (!hostOrigin) return;
  window.parent.postMessage(message, hostOrigin);
}

/** Tell the host the payer signed. It closes the panel and calls onAuthorized. */
export function reportAuthorized(mandateId?: string): void {
  if (isPopupChild()) {
    /**
     * A popup reports to the IFRAME that opened it, not to the merchant.
     *
     * The iframe is our opener and it already holds the handshake with the
     * host, so it relays. Going direct would mean this window discovering the
     * merchant's origin for itself, which it has no trustworthy way to do.
     */
    window.opener?.postMessage(
      { source: "sweep", type: "popup-authorized", mandate: { mandate_id: mandateId } },
      window.location.origin
    );
    window.close();
    return;
  }
  post({ source: "sweep", type: "authorized", mandate: { mandate_id: mandateId } });
}

/** Tell the host the payer backed out. */
export function reportCancelled(): void {
  post({ source: "sweep", type: "cancelled" });
}

/**
 * Listen for a popup we opened finishing, and relay it to the host.
 *
 * Same-origin, because the popup is this same page — so the origin check is
 * exact rather than a guess.
 */
export function relayPopupResult(onDone: (mandateId?: string) => void): () => void {
  const handler = (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    const msg = e.data as { source?: string; type?: string; mandate?: { mandate_id?: string } } | null;
    if (!msg || msg.source !== "sweep" || msg.type !== "popup-authorized") return;
    onDone(msg.mandate?.mandate_id);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/**
 * Can this page actually reach a wallet?
 *
 * Only meaningful when framed. A browser extension is not obliged to inject
 * itself into a cross-origin iframe, and when it has not, every connector
 * that depends on an injected provider is a dead end — the payer clicks
 * Connect and nothing happens, with no error to act on.
 *
 * WalletConnect would still work in a frame, so this is not "no wallet
 * possible", it is "the one most payers use is missing". That is enough to
 * offer the popup, which costs a payer who did have MetaMask nothing, because
 * they never see the offer.
 */
export function injectedProviderReachable(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as { ethereum?: unknown }).ethereum;
}

/**
 * Open this same authorization in a real window.
 *
 * Top-level, so every wallet behaves normally. `embed` is dropped and
 * `sweep_popup` added so the new window renders full-page and knows to report
 * back through its opener.
 *
 * Must be called inside a click: a popup opened from a frame outside a user
 * gesture is blocked, and the block is silent.
 */
export function openAuthorizePopup(): Window | null {
  const url = new URL(window.location.href);
  url.searchParams.delete("embed");
  url.searchParams.set("sweep_popup", "1");
  const w = 520;
  const h = 720;
  // Centred on the screen the payer is actually looking at, not on screen 0.
  const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  return window.open(
    url.toString(),
    "sweep_authorize",
    `width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)}`
  );
}

/**
 * @sweepconsole/js — the browser half of the rail.
 *
 * One button. It asks YOUR server for a URL and sends the payer there.
 *
 * It deliberately cannot talk to Sweep. Everything a browser sends is
 * something the person at the browser can change, so a payer id that came from
 * the page is a payer id the customer picked — and on this rail a mandate is
 * standing authority, so a forged one misattributes a recurring charge rather
 * than a single payment. The server half (`@sweepconsole/node`) holds the
 * secret key, reads the id from its own session, and hands back a URL. All this
 * file does is fetch that URL and follow it.
 *
 * No dependencies, no build step for the consumer, and no module system
 * required: it is published as ESM for npm and as a classic script that defines
 * `window.Sweep` for a CDN tag.
 *
 * IMPORTANT, if you edit this file: the CDN build is produced by wrapping tsc's
 * output in an IIFE, which works only while this stays ONE file with no
 * `import` and no `export { … }` block. scripts/build-cdn.mjs asserts both and
 * fails the build rather than shipping something broken.
 */

/** How the button looks. `solid` is the default. */
export type SweepVariant = "solid" | "outline" | "light";

export interface MountOptions {
  /**
   * Your endpoint, which creates the session and returns a URL. Called with
   * POST. Must answer `{ url }` — `checkout_url`, `authorization_url`, and any
   * of those nested under `data`, are also accepted, so an endpoint that simply
   * forwards Sweep's own response works unchanged.
   *
   * A function is also allowed, for a page that already has its own fetching
   * conventions: return the URL (or a promise of it) and nothing is fetched
   * here.
   */
  session: string | (() => string | Promise<string>);
  /**
   * The button's text. Defaults to the element's existing text, or
   * "Subscribe with USDC".
   *
   * Prefer "Subscribe" to "Pay" unless you are charging once. Authorizing on
   * this rail signs a standing permission with a ceiling, and a payer who read
   * "Pay" meets a wallet asking for more than they agreed to.
   */
  label?: string;
  /** Shown while your endpoint is working. Defaults to "Starting…". */
  busyLabel?: string;
  variant?: SweepVariant;
  size?: "md" | "sm";
  /** Fill the container's width, for a checkout column. */
  block?: boolean;
  /** Extra JSON to post to your endpoint. */
  body?: Record<string, unknown>;
  /** Extra headers, e.g. a CSRF token. */
  headers?: Record<string, string>;
  /** Defaults to "same-origin", so your session cookie is sent. */
  credentials?: RequestCredentials;
  /**
   * Set false if your Content-Security-Policy forbids inline styles; link
   * `button.css` from the package instead.
   */
  injectStyles?: boolean;
  /**
   * Called when the session could not be created. The button returns to its
   * resting state first, so the payer can try again. Without one, the error is
   * logged — tell the payer something instead.
   */
  onError?: (error: Error) => void;
  /**
   * Called with the URL just before leaving the page. Return `false` to take
   * over the navigation yourself.
   */
  onRedirect?: (url: string) => void | boolean;
}

export interface SweepButton {
  /** The button element, mounted or created. */
  readonly element: HTMLElement;
  /** Remove the handler and undo what mounting changed. */
  destroy(): void;
}

const STYLE_ID = "sweep-pay-styles";

/* The USDC mark and the busy spinner. Inlined because a button that waits on a
   network request to look like itself is worse than one extra kilobyte. */
const COIN_SVG =
  '<svg class="sweep-pay__mark" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="12" r="11" fill="#2775ca"/>' +
  '<path d="M12 5.3v1.4c2 .2 3.3 1.3 3.5 2.9h-1.8c-.2-.8-.8-1.3-1.7-1.5v3.1c2.2.5 3.7 1.1 3.7 3 0 1.8-1.4 3-3.7 3.2v1.3h-1.3v-1.3c-2.2-.2-3.6-1.4-3.8-3.2h1.8c.2.9.9 1.5 2 1.7v-3.3C8.6 12.1 7.2 11.4 7.2 9.6c0-1.7 1.4-2.8 3.5-3V5.3H12zm-1.3 2.7c-1 .2-1.6.7-1.6 1.5 0 .8.5 1.2 1.6 1.5V8zm1.3 5.1v3.1c1.1-.2 1.7-.7 1.7-1.6 0-.8-.6-1.2-1.7-1.5z" fill="#fff"/>' +
  "</svg>";

const SPINNER_SVG =
  '<svg class="sweep-pay__spin" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="2.5"/>' +
  '<path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
  "</svg>";

/**
 * The stylesheet, also published as `button.css` for anyone who would rather
 * link it. Four custom properties are the whole theming surface, and
 * `font: inherit` means the button never arrives in a typeface the merchant
 * did not choose.
 */
export const BUTTON_CSS = `.sweep-pay{--_bg:var(--sweep-bg,#201e1d);--_fg:var(--sweep-fg,#fff);--_edge:var(--sweep-border,var(--_bg));display:inline-flex;align-items:center;justify-content:center;gap:.625rem;box-sizing:border-box;font:inherit;font-size:.9375rem;font-weight:700;letter-spacing:-.01em;line-height:1.2;text-decoration:none;white-space:nowrap;padding:.8125rem 1.25rem;border:2px solid var(--_edge);border-radius:var(--sweep-radius,0);background:var(--_bg);color:var(--_fg);cursor:pointer;position:relative;transition:transform .12s ease,box-shadow .12s ease,opacity .12s ease}
.sweep-pay:hover{transform:translateY(-2px);box-shadow:0 2px 0 var(--_edge)}
.sweep-pay:active{transform:translateY(0);box-shadow:none}
.sweep-pay:focus-visible{outline:2px solid var(--_bg);outline-offset:3px}
.sweep-pay[aria-busy=true],.sweep-pay[disabled]{opacity:.6;pointer-events:none}
.sweep-pay--outline{--_bg:transparent;--_fg:currentColor;--_edge:currentColor}
.sweep-pay--light{--_bg:#fff;--_fg:#201e1d;--_edge:#201e1d}
.sweep-pay--sm{font-size:.8125rem;padding:.5625rem .875rem;gap:.4375rem}
.sweep-pay--block{display:flex;width:100%}
.sweep-pay__mark,.sweep-pay__spin{flex:none}
.sweep-pay__spin{display:none}
.sweep-pay[aria-busy=true] .sweep-pay__mark{display:none}
.sweep-pay[aria-busy=true] .sweep-pay__spin{display:block;animation:sweep-pay-spin .7s linear infinite}
@keyframes sweep-pay-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.sweep-pay{transition:none}.sweep-pay:hover{transform:none}.sweep-pay[aria-busy=true] .sweep-pay__spin{animation-duration:2.4s}}`;

function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = BUTTON_CSS;
  document.head.appendChild(style);
}

function resolveTarget(target: string | Element): Element {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!el) {
    // Loudly, because the usual cause is a script running before the element
    // exists, and a button that silently never appears is hours of confusion.
    throw new Error(
      `Sweep.mount: nothing matched ${JSON.stringify(target)}. ` +
        `Run it after the element exists, or pass the element itself.`
    );
  }
  return el;
}

/** Liberal on the way in: anything that looks like the URL counts. */
function urlFrom(payload: unknown): string | null {
  if (typeof payload === "string") return payload || null;
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  for (const key of ["url", "checkout_url", "authorization_url", "checkoutUrl", "authorizationUrl"]) {
    const v = o[key];
    if (typeof v === "string" && v) return v;
  }
  // An endpoint that forwards Sweep's reply verbatim nests it under `data`.
  if (o["data"] && typeof o["data"] === "object") return urlFrom(o["data"]);
  return null;
}

async function messageFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const err = body["error"];
    if (err && typeof err === "object") {
      const m = (err as Record<string, unknown>)["message"];
      if (typeof m === "string" && m) return m;
    }
    if (typeof body["message"] === "string" && body["message"]) return body["message"] as string;
  } catch {
    /* not JSON; fall through to the status */
  }
  return `We couldn't start your payment (HTTP ${res.status}).`;
}

async function fetchUrl(opts: MountOptions): Promise<string> {
  if (typeof opts.session === "function") {
    const url = await opts.session();
    if (!url) throw new Error("Sweep.mount: the session function returned no URL.");
    return url;
  }

  const hasBody = !!opts.body;
  const res = await fetch(opts.session, {
    method: "POST",
    credentials: opts.credentials ?? "same-origin",
    headers: {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
  });

  if (!res.ok) throw new Error(await messageFrom(res));

  const url = urlFrom(await res.json().catch(() => null));
  if (!url) {
    throw new Error(
      "Sweep.mount: your endpoint answered without a URL. Return { url } — " +
        "for the external rail that is the mandate's authorizationUrl."
    );
  }
  return url;
}

/**
 * Turn an element into the button, or create one inside a container.
 *
 * A `<button>` or `<a>` is used as-is, so the merchant's own markup and any
 * framework ref survive. Anything else gets a real `<button>` appended —
 * never a styled div, which cannot be reached by keyboard.
 */
export function mount(target: string | Element, opts: MountOptions): SweepButton {
  if (!opts || !opts.session) {
    throw new Error("Sweep.mount: `session` is required — your endpoint that returns a URL.");
  }
  if (opts.injectStyles !== false) injectStyles();

  const found = resolveTarget(target);
  const tag = found.tagName.toLowerCase();
  const reuse = tag === "button" || tag === "a";

  const el = reuse ? (found as HTMLElement) : document.createElement("button");
  if (!reuse) found.appendChild(el);
  if (el.tagName.toLowerCase() === "button" && !el.getAttribute("type")) {
    // Without this it submits any form it happens to sit inside.
    el.setAttribute("type", "button");
  }

  const restore = {
    className: el.className,
    html: el.innerHTML,
  };

  // The merchant's own text wins over our default, and an explicit `label`
  // wins over both. An element with only whitespace in it counts as empty.
  const existing = reuse ? el.textContent?.trim() : "";
  const label = opts.label || existing || "Subscribe with USDC";
  const busyLabel = opts.busyLabel ?? "Starting…";

  el.classList.add("sweep-pay");
  if (opts.variant === "outline") el.classList.add("sweep-pay--outline");
  if (opts.variant === "light") el.classList.add("sweep-pay--light");
  if (opts.size === "sm") el.classList.add("sweep-pay--sm");
  if (opts.block) el.classList.add("sweep-pay--block");

  // Our own constant markup, then the label by textContent — a merchant's
  // string never reaches innerHTML.
  el.innerHTML = COIN_SVG + SPINNER_SVG + '<span class="sweep-pay__label"></span>';
  const labelEl = el.querySelector(".sweep-pay__label") as HTMLElement;
  labelEl.textContent = label;

  let busy = false;

  const onClick = (event: Event) => {
    event.preventDefault();
    // Covers the second click, and Enter on a button CSS has only made
    // pointer-inert.
    if (busy) return;
    busy = true;
    el.setAttribute("aria-busy", "true");
    labelEl.textContent = busyLabel;

    void fetchUrl(opts)
      .then((url) => {
        if (opts.onRedirect && opts.onRedirect(url) === false) {
          busy = false;
          el.removeAttribute("aria-busy");
          labelEl.textContent = label;
          return;
        }
        // assign, not replace: the payer can come back with the back button.
        window.location.assign(url);
      })
      .catch((e: unknown) => {
        busy = false;
        el.removeAttribute("aria-busy");
        labelEl.textContent = label;
        const error = e instanceof Error ? e : new Error(String(e));
        if (opts.onError) opts.onError(error);
        else console.error("[sweep] could not start the payment:", error);
      });
  };

  el.addEventListener("click", onClick);

  return {
    element: el,
    destroy() {
      el.removeEventListener("click", onClick);
      el.removeAttribute("aria-busy");
      if (reuse) {
        el.className = restore.className;
        el.innerHTML = restore.html;
      } else {
        el.remove();
      }
    },
  };
}

/** The global the CDN build defines. Same functions, one name to reach them. */
export const Sweep = { mount, BUTTON_CSS };

# @sweepconsole/js

A **Subscribe with USDC** button for your checkout. It asks your server for a URL and sends the payer there.

~3KB gzipped, no dependencies.

```html
<script src="https://cdn.jsdelivr.net/npm/@sweepconsole/js@0.1.0/dist/sweep.js"></script>
<button id="pay-usdc">Subscribe with USDC</button>

<script>
  Sweep.mount("#pay-usdc", { session: "/api/sweep/session" });
</script>
```

```js
// your server — the payer's id comes from the cookie, never from the page
import Sweep from "@sweepconsole/node";
const sweep = new Sweep(process.env.SWEEP_SECRET_KEY);

// A plan you made in the Sweep portal:
app.post("/api/sweep/session", requireLogin, async (req, res) => {
  const session = await sweep.checkout.sessions.create({
    plan: "plan_pro",
    externalRef: req.user.id,
    successUrl: "https://app.example.com/welcome",
    cancelUrl: "https://app.example.com/pricing",
  });
  res.json({ url: session.url });
});

// Or, on the external rail, where you do the billing yourself:
//   const mandate = await sweep.mandates.create({
//     externalRef: req.user.id,
//     maxAmount: usdc("35.00"),        // the ceiling, with headroom — not the price
//     interval: "monthly",
//     chains: ["base", "arbitrum", "optimism"],
//     expiresAt: addYears(new Date(), 1),
//   });
//   res.json({ url: mandate.authorizationUrl });
```

That is the whole integration. The payer signs in their wallet on Sweep's hosted
page, and `mandate.authorized` arrives on your webhook endpoint.

## Why it will not call Sweep for you

This package has no API key and cannot create a session. Everything a browser
sends is something the person at the browser can change, so an `externalRef`
that came from the page is a user id the customer chose — and on this rail a
mandate is *standing* authority, so a forged one misattributes a recurring
charge rather than one payment. Your server already knows who is logged in.

For a public link — a pricing page, an invoice, a QR code — there is no identity
to protect, and a plain anchor is enough:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@sweepconsole/js@0.1.0/dist/button.css">
<a class="sweep-pay" href="https://pay.sweepconsole.com/pay/plink_a1b2c3?ref=user_42">
  Subscribe with USDC
</a>
```

## Install

```sh
npm i @sweepconsole/js
```

```js
import { mount } from "@sweepconsole/js";
import "@sweepconsole/js/button.css";   // or let mount() inject it

mount("#pay-usdc", { session: "/api/sweep/session" });
```

## Options

| Option | Default | |
| --- | --- | --- |
| `session` | *required* | Your endpoint, POSTed to, answering `{ url }`. A function returning the URL also works. |
| `label` | the element's own text, else `"Subscribe with USDC"` | |
| `busyLabel` | `"Starting…"` | |
| `variant` | `"solid"` | `"solid"`, `"outline"`, `"light"` |
| `size` | `"md"` | `"sm"` for a compact row |
| `block` | `false` | Full width, for a checkout column |
| `body` | — | Extra JSON for your endpoint |
| `headers` | — | Extra headers, e.g. a CSRF token |
| `credentials` | `"same-origin"` | So your session cookie is sent |
| `injectStyles` | `true` | Set `false` under a CSP that forbids inline styles and link `button.css` |
| `onError` | logs | The button returns to rest first, so the payer can retry. Tell them something. |
| `onRedirect` | — | Return `false` to handle the navigation yourself |

`mount()` returns `{ element, destroy() }`.

Your endpoint's reply is read liberally: `url`, `checkout_url`,
`authorization_url`, their camelCase forms, and any of them nested under `data`.
An endpoint that forwards Sweep's own response verbatim works unchanged.

## Theming

Four custom properties, and `font: inherit` so it never arrives in a typeface
you did not choose.

```css
.sweep-pay {
  --sweep-radius: 10px;
  --sweep-bg: #111827;
  --sweep-fg: #fff;
  --sweep-border: #111827;
}
```

## Say "Subscribe", not "Pay"

Authorizing on this rail signs a standing permission with a monthly ceiling, not
a single payment. A payer who read "Pay $29" and then meets a wallet asking for
recurring authority has been misled by the button, and that is the moment they
abandon the checkout. Use "Pay" only if you are charging once and never again.

## What it deliberately does not do

- **No iframe.** The hosted page needs a wallet, and injected providers are
  unreliable inside a cross-origin frame. The button navigates the top level.
- **No wallet detection.** It never probes for `window.ethereum` to decide
  whether to render. A mobile wallet browser fails that test, and the hosted
  page handles a missing wallet better than a hidden button does.
- **No fulfilment signal.** Returning to your site means the payer came back,
  nothing more. Grant access on `mandate.authorized`.

## Tests

```sh
node test/button.test.mjs
```

Runs the built `dist/sweep.js` against a small DOM stub — the redirect, the
error path, the in-flight click guard, and style injection. Build first.

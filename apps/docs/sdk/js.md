# @sweepconsole/js

A **Subscribe with USDC** button for the browser. It asks *your* server for a
URL and sends the payer there.

```html
<script src="https://cdn.jsdelivr.net/npm/@sweepconsole/js@0.1.0/dist/sweep.js"></script>
<button id="pay-usdc">Subscribe with USDC</button>

<script>
  Sweep.mount("#pay-usdc", { session: "/api/sweep/session" });
</script>
```

```ts
// your endpoint — the payer's id comes from your session, never the page
app.post("/api/sweep/session", requireLogin, async (req, res) => {
  const session = await sweep.checkout.sessions.create({
    plan: "plan_pro",
    externalRef: req.user.id,
    successUrl: "https://app.example.com/welcome",
    cancelUrl: "https://app.example.com/pricing",
  });
  res.json({ url: session.url });
});
```

~3KB gzipped, no dependencies. Pin the version: `@latest` would hand your
checkout a release you have not read.

## Why it cannot call Sweep for you

It has no API key and cannot create a session. Everything a browser sends is
something the person at the browser can change, so an `externalRef` that came
from the page is a user id the customer picked — and here that would
misattribute *recurring* authority, not one payment.

For a public link, where there is no identity to protect, a plain anchor is
enough:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@sweepconsole/js@0.1.0/dist/button.css">
<a class="sweep-pay" href="https://pay.sweepconsole.xyz/pay/plink_a1b2c3?ref=user_42">
  Subscribe with USDC
</a>
```

## Options

| | |
| --- | --- |
| `session` | **Required.** Your endpoint, POSTed to, answering `{ url }`. A function returning the URL also works |
| `label` | Defaults to the element's own text, else "Subscribe with USDC" |
| `variant` | `solid`, `outline`, `light` |
| `size` | `sm` for a compact row |
| `block` | Full width, for a checkout column |
| `onError` | The button returns to rest first, so the payer can retry. Tell them something |
| `onRedirect` | Return `false` to handle the navigation yourself |

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

## What it deliberately does not do

- **No iframe.** The hosted page needs a wallet, and injected providers are
  unreliable in a cross-origin frame. It navigates the top level.
- **No wallet detection.** It never probes for `window.ethereum` to decide
  whether to render — a mobile wallet browser fails that test.
- **No fulfilment signal.** Returning to your site means the payer came back,
  nothing more. Grant access on the webhook.

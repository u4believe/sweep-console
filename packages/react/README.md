# @sweepconsole/react

The Sweep Console rail checkout, as a React component. It opens over your own
page rather than navigating away.

```tsx
import { SweepAuthorize } from "@sweepconsole/react";

<SweepAuthorize
  session="/api/sweep/mandate-link"
  onAuthorized={(m) => saveMandate(m.mandate_id)}
>
  Authorize with wallet
</SweepAuthorize>
```

```js
// your server — the payer's id comes from the session cookie, never the page
app.post("/api/sweep/mandate-link", requireLogin, async (req, res) => {
  const mandate = await sweep.mandates.create({
    externalRef: req.user.id,
    maxAmount: usdc("35.00"),   // the ceiling, with headroom — not the price
    interval: "monthly",
    chains: ["base", "arbitrum", "optimism"],
  });
  res.json({ url: mandate.authorizationUrl });
});
```

## Why `session` is a URL on your server

It cannot be the mandate itself. Everything the browser sends is something the
person at the browser can change, and on this rail a mandate is standing
authority — a forged payer reference misattributes a recurring charge, not a
single payment. Your server reads who the payer is from its own session and
asks Sweep for the link.

## Props

| Prop | What it does |
| --- | --- |
| `session` | **Required.** Your endpoint, POSTed to, answering `{ url }`. A function returning the URL also works. |
| `onAuthorized` | Called with the signed mandate. The panel closes first. |
| `onCancelled` | They dismissed it — backdrop, Escape, or the close button. |
| `onError` | The session could not be created. The button returns to rest so they can retry. |
| `mode` | `"modal"` (default), `"popup"`, or `"redirect"` to navigate like the vanilla `mount()`. |
| `variant` `size` `block` | Passed through to the button. |
| `children` | Button text. Defaults to "Authorize payments". |

## This package is deliberately thin

Everything real — the panel, the postMessage protocol, the popup fallback for
wallets that will not inject into a frame — lives in
[`@sweepconsole/js`](https://www.npmjs.com/package/@sweepconsole/js), which is
what the CDN build ships and what a plain `<script>` tag can load. Anything
implemented here instead would be missing for everyone not using React.

What this file does own is the three things React needs and vanilla does not:
mounting against a ref, holding your callbacks in a ref so an inline arrow
function does not rebuild the button mid-click and close an open panel under
the payer, and tearing down on unmount.

## Wallets and frames

A browser extension is not obliged to inject itself into a cross-origin
iframe, and this checkout needs a signature. Where it has not, the framed page
opens its own window for the signing step and reports back through the frame.
Nothing to configure; `onAuthorized` fires the same either way.

# A working integration

Two server routes and a webhook handler. This is Express; the shape is the same
anywhere. Nothing here is pseudo-code.

## 1 · The "Subscribe with USDC" button

A form that posts to your own server, exactly like a Stripe Checkout session.
The secret key never reaches the browser.

```html
<form method="POST" action="/subscribe/usdc">
  <button type="submit">Subscribe with USDC</button>
</form>
```

::: warning Label it Subscribe, not Pay
What your payer signs is a standing permission with a ceiling, not a single
payment. Someone who reads "Pay $15" and then meets a wallet asking for
recurring authority abandons the checkout, and is right to.
:::

## 2 · Create the mandate and redirect

::: code-group
```ts [SDK]
app.post("/subscribe/usdc", async (req, res) => {
  const mandate = await sweep.mandates.create({
    externalRef: req.user.id,
    email: req.user.email,
    maxAmount: usdc("15.00"),
    interval: "monthly",
    chains: ["base", "arbitrum", "optimism"],
    expiresAt: new Date("2027-01-01"),
  });

  await db.users.update(req.user.id, { sweepMandate: mandate.id });
  res.redirect(mandate.authorizationUrl!);
});
```
```js [fetch]
const SWEEP = "https://api.sweepconsole.xyz";

app.post("/subscribe/usdc", async (req, res) => {
  const user = req.user;

  const r = await fetch(`${SWEEP}/v1/mandates`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SWEEP_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      external_ref: user.id,          // YOUR id — echoed on every event
      email: user.email,
      max_amount: 15_000_000,         // 15.00 USDC ceiling, NOT the price
      interval: "monthly",
      chains: ["base", "arbitrum", "optimism"],
      expires_at: "2027-01-01T00:00:00Z",
    }),
  });

  const { data } = await r.json();
  await db.users.update(user.id, { sweepMandate: data.id });
  res.redirect(data.authorization_url);
});
```
:::

## 3 · The webhook handler

```ts
app.post(
  "/webhooks/sweep",
  express.raw({ type: "application/json" }),
  sweep.webhooks.express(process.env.SWEEP_WEBHOOK_SECRET!, {
    "mandate.authorized": async (e) => {
      // Start YOUR clock here, not on the return_url — they can close the tab.
      await db.users.update(e.externalRef, {
        usdcActive: true,
        chains: e.data.chain_ids,     // what they actually signed
        nextChargeOn: addMonths(new Date(), 1),
      });
    },

    "charge.succeeded": async (e) => {
      await db.users.update(e.externalRef, { paidUntil: addMonths(new Date(), 1) });
    },

    "charge.failed": async (e) => {
      // Your policy, not ours. insufficient_funds is usually an empty wallet.
      await db.users.update(e.externalRef, { dunning: e.data.failure_code });
    },

    "mandate.revoked": async (e) => {
      await db.users.update(e.externalRef, { usdcActive: false });
    },
  })
);
```

## 4 · Charge on your own schedule

```ts
// whenever your billing says so — a cron, a usage threshold, an invoice
await sweep.charges.create(
  {
    mandate: user.sweepMandate,
    amount: usdc("9.00"),
    description: "Pro plan — October",   // the only text the payer sees
  },
  { idempotencyKey: `inv_${invoice.id}` }
);
```

That is the whole integration. There is no renewal endpoint to call and no
schedule to configure — charging monthly means calling this once a month.

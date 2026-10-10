# @sweepconsole/node

The server-side client. Holds your secret key, so it never goes near a browser.

```sh
npm install @sweepconsole/node
```

```ts
import Sweep, { usdc } from "@sweepconsole/node";

const sweep = new Sweep(process.env.SWEEP_API_KEY!);
```

Zero runtime dependencies. It refuses an `http://` base URL, because every
request carries `Authorization: Bearer <your key>`.

## Hosted plans

```ts
// start a checkout for a plan you made in the dashboard
const session = await sweep.checkout.sessions.create({
  plan: "plan_pro",
  externalRef: req.user.id,
  successUrl: "https://app.example.com/welcome",
  cancelUrl: "https://app.example.com/pricing",
});

// is this person a subscriber right now? null when nothing is live
const sub = await sweep.subscriptions.status(req.user.id);

// from your admin panel
await sweep.subscriptions.cancel(sub.id, { reason: "requested by support" });
```

Also `checkout.sessions.retrieve`, `checkout.sessions.expire`,
`subscriptions.retrieve`, `subscriptions.list`.

## The rail

```ts
const mandate = await sweep.mandates.create({ /* … */ });
await sweep.charges.create({ mandate, amount: usdc("9.00") },
                           { idempotencyKey: `inv_${invoice.id}` });
```

Also `mandates.retrieve`, `mandates.list`, `mandates.revoke`,
`charges.retrieve`, `charges.list`.

## Webhooks

Every one of the thirteen event types is typed, so a mistyped field is a compile
error:

```ts
sweep.webhooks.express(process.env.SWEEP_WEBHOOK_SECRET!, {
  "subscription.created": async (e) => {
    await grant(e.data.subscriber_email, e.data.plan_id);
  },
  "mandate.revoked": async (e) => {
    if (e.data.revoked_by === "payer") await winback(e.externalRef);
  },
});
```

`verify` and `construct` are available separately if you are not on Express.

## Errors

One class per refusal, so `catch` can ask which it is without parsing a string:

```ts
import { MandateExists, PeriodCapExceeded } from "@sweepconsole/node";

try {
  await sweep.mandates.create({ externalRef: user.id, /* … */ });
} catch (e) {
  if (e instanceof MandateExists && e.authorizationUrl) {
    return email(user, e.authorizationUrl);   // resend, do not recreate
  }
  throw e;
}
```

`RailNotEnabled`, `MandateNotFound`, `MandateRevoked`, `MandateNotActive`,
`MandateExists`, `AmountOverCap`, `PeriodCapExceeded`, `IdempotencyKeyRequired`,
`IdempotencyKeyReused`, `IdempotencyKeyInFlight`, `ChargeConflict`,
`WebhookSignatureError` — all extending `SweepError`.

## Money

```ts
usdc("15.00")   // 15000000
```

Amounts are USDC micro-units everywhere. `usdc()` exists so you never do that
conversion by hand.

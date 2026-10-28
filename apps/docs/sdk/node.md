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

**The key picks the host.** A `test_` key reaches
`https://api-sandbox.sweepconsole.xyz`, a `live_` key reaches
`https://api.sweepconsole.xyz`, and each API refuses the other's keys. Going
live is one environment variable and nothing else — no `baseUrl` to remember,
no second client to construct.

Pass `baseUrl` only for a tunnel, a preview or a self-hosted deployment. A key
that begins with neither prefix is refused in the constructor, rather than
guessed onto a host that would answer `401`.

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

## Which network am I on

```ts
const cfg = await sweep.config();
// { mode: "live", platformFeeBps: 200, minChargeUsdc: "1.00",
//   sourceChains: [{ key: "base", name: "Base" }, …], … }
```

The key's prefix implies the answer, but the **deployment** decides it, so
asking beats inferring. Two things it is worth reading rather than
hardcoding: `minChargeUsdc`, which moves with gas and is `null` on testnet,
and `sourceChains`, which is what a payer will actually be offered.

Unauthenticated on the server, so it answers before a key is valid — useful in
a health check that should fail loudly when a staging deployment has somehow
been handed a live key.

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
`MandateExists`, `AmountOverCap`, `PeriodCapExceeded`, `AmountBelowMinimum`,
`WrongEnvironment`, `IdempotencyKeyRequired`, `IdempotencyKeyReused`,
`IdempotencyKeyInFlight`, `ChargeConflict`, `WebhookSignatureError` — all
extending `SweepError`.

`AmountBelowMinimum` is the one worth catching rather than logging: you can
round the amount up and retry.

```ts
try {
  await sweep.charges.create({ mandateId, amount: usdc("0.50") });
} catch (e) {
  if (e instanceof AmountBelowMinimum) {
    const { minChargeUsdc } = await sweep.config();
    // charge minChargeUsdc instead, or batch until it is worth collecting
  }
  throw e;
}
```

Two refusals come from the environment rather than the request:

| code | status | what it means |
| --- | --- | --- |
| `wrong_environment` | 403 | a `test_` key reached the live API, or the reverse. The message names the host to use |
| `payout_wallet_missing` | 409 | the merchant has no payout wallet **for this mode**. A wallet is configured per environment, so a test one does not serve live charges |
| `amount_below_minimum` | 422 | the amount is under the mainnet floor, 2.00 USDC by default. `details.amount` names the floor and what you sent. Testnet has no floor |

Neither is retryable — both mean a configuration mismatch, not a transient
failure.

## Money

```ts
usdc("15.00")   // 15000000
```

Amounts are USDC micro-units everywhere. `usdc()` exists so you never do that
conversion by hand.

# @sweepconsole/node

Charge a USDC wallet from your own app. Your billing logic, your schedule — Sweep
moves the money and enforces the ceiling the payer signed.

```bash
npm install @sweepconsole/node
```

Requires Node 20+. You need a Sweep account with the **payment rail** enabled
(portal → Payment rail → Request access) and a payout wallet linked.

## The whole integration

```ts
import { Sweep, usdc } from "@sweepconsole/node";

const sweep = new Sweep(process.env.SWEEP_API_KEY!);
// baseUrl defaults to the hosted API; override it for a tunnel or self-hosting.
```

**1 — when a user subscribes, create a mandate and send them to sign it**

```ts
app.post("/subscribe/usdc", async (req, res) => {
  const mandate = await sweep.mandates.create({
    externalRef: req.user.id,              // YOUR id — echoed on every event
    email: req.user.email,
    maxAmount: usdc("15.00"),              // the CEILING, not the price
    interval: "monthly",
    chains: ["base", "arbitrum", "optimism"],
    expiresAt: new Date("2027-01-01"),
    returnUrl: "https://shop.example.com/thanks",
  });

  await db.users.update(req.user.id, { sweepMandate: mandate.id });
  res.redirect(mandate.authorizationUrl!);
});
```

**2 — react to what happens**

```ts
app.post("/webhooks/sweep",
  express.raw({ type: "application/json" }),        // raw, not json — see below
  sweep.webhooks.express(process.env.SWEEP_WEBHOOK_SECRET!, {
    "mandate.authorized": (e) => db.users.activate(e.externalRef),
    "charge.succeeded":   (e) => db.users.extend(e.externalRef),
    "charge.failed":      (e) => db.users.dun(e.externalRef, e.data.failure_code),
    "mandate.revoked":    (e) => db.users.deactivate(e.externalRef),
  }));
```

**3 — charge on your own clock**

```ts
for (const user of await db.users.dueForCharge()) {
  try {
    await sweep.charges.create(
      { mandate: user.sweepMandate, amount: usdc("9.00"), description: "Pro plan — September" },
      { idempotencyKey: `${user.id}:${thisPeriod}` },
    );
  } catch (e) {
    if (e instanceof Sweep.PeriodCapExceeded) continue;   // already collected
    if (e instanceof Sweep.MandateRevoked) await db.users.deactivate(user.id);
    else throw e;
  }
}
```

That's it. No plans, no schedule, no renewal engine — those stay yours.

## The four things that trip people up

**Amounts are micro-units.** `usdc("9.00")` is 9000000. The branded return type
means a bare number will not compile where an amount is expected, so the factor
of 10⁶ cannot reach production.

**Webhook signatures are over the raw bytes.** If `express.json()` parses the
body first, the bytes you hash are not the bytes that were signed. Mount with
`express.raw`. `sweep.webhooks.express()` also handles the `sha256=` prefix and
the constant-time compare, which are the other two ways this goes wrong.

**`charges.create` resolves on 202, not on settlement.** The charge row exists
immediately; the money arrives seconds to minutes later, cross-chain. The
outcome comes from `charge.succeeded` / `charge.failed`, or `charges.retrieve`.

**`idempotencyKey` is required.** Use a natural key — an invoice id, or
`${userId}:${period}` — so that a retry after a timeout collects once.

## Errors

Every refusal is a class, so `catch` can ask which one it is:

| Class | Means |
|---|---|
| `RailNotEnabled` | The account has not been granted the rail |
| `MandateRevoked` / `MandateNotActive` | The payer withdrew it, or it was never signed |
| `AmountOverCap` | This charge is larger than `maxAmount` |
| `PeriodCapExceeded` | Fits the cap, but not what is left this period |
| `IdempotencyKeyReused` | That key was used with a different body |
| `ChargeConflict` | Two charges raced. Retry with the same key |

All extend `SweepError`, which carries `code`, `status`, and — on a server-side
failure — a `reference` to quote to support.

## Reference

```ts
sweep.mandates.create(params)              // → Mandate
sweep.mandates.retrieve(id)                // → Mandate
sweep.mandates.list({ status?, limit? })   // → Mandate[]
sweep.mandates.revoke(id)                  // → Mandate

sweep.charges.create(params, { idempotencyKey })  // → Charge (status "pending")
sweep.charges.retrieve(id)                        // → Charge
sweep.charges.list({ mandate?, status?, limit? }) // → Charge[]

sweep.webhooks.verify(rawBody, signature, secret)     // throws, or returns void
sweep.webhooks.construct(rawBody, signature, secret)  // → WebhookEvent
sweep.webhooks.express(secret, handlers)              // → express handler

usdc("9.00")      // → 9000000, branded
format(9000000)   // → "9.00"
```

Amounts are USDC, 6 decimals. Dates are `Date`. Fields are camelCase; the wire
is snake_case and the client translates.

# @sweepconsole/node

Charge a USDC wallet from your own app. Your billing logic, your schedule — Sweep
moves the money and enforces the ceiling the payer signed.

```bash
npm install @sweepconsole/node
```

Requires Node 20+. You need a Sweep account with the **payment rail** enabled
(portal → Payment rail → Request access) and a payout wallet linked.

## Two rails, one webhook endpoint

**Hosted plans** — you made the plan in the portal. Start a checkout, send the
payer to it, and act on the webhook:

```ts
// your endpoint. externalRef comes from your session, never from the page.
app.post("/api/checkout", requireLogin, async (req, res) => {
  const session = await sweep.checkout.sessions.create({
    plan: "plan_pro",
    externalRef: req.user.id,
    successUrl: "https://app.example.com/welcome",
    cancelUrl: "https://app.example.com/pricing",
  });
  res.json({ url: session.url });
});
```

```ts
// is this person a subscriber right now? null when nothing is live.
const sub = await sweep.subscriptions.status(req.user.id);

// from your admin panel
await sweep.subscriptions.cancel(sub.id, { reason: "requested by support" });
```

**The external rail** — you create mandates and charge them yourself, with your
own billing logic. That is `sweep.mandates` and `sweep.charges` below.

Either way the webhook is what grants access. These types cover both:

```ts
sweep.webhooks.express(process.env.SWEEP_WEBHOOK_SECRET!, {
  "subscription.created": async (e) => {
    // With a payment link you did not set an external_ref, so the envelope
    // carries one we generated. Identify on the email, or on customer_id,
    // which is stable across every wallet this person pays from.
    await grantAccess(e.data.subscriber_email, e.data.plan_id);
  },
  "subscription.renewed": async (e) => {
    await extendTo(e.data.subscription_id, e.data.current_period_end);
  },
  "subscription.cancelled": async (e) => {
    await revoke(e.data.subscription_id, e.data.cancel_reason);
  },
});
```

A payment link needs no API call at all: the link is the checkout, and the
webhook is the whole integration. Verification is an HMAC over the raw body,
which the docs show in fifteen lines of `node:crypto` — so you can handle
hosted plans without this package. Install it for the payload types, the
dispatch, and the calls above.

## Refunds

There is no refund method, because there is no refund. A charge settles by
minting your share straight into your wallet, so there is never a moment when
this platform holds the money and could return it. `POST /v1/subscriptions/:id/refund`
still answers, with that explanation, so an old integration gets a reason
instead of a 404. Cancel stops the next charge; returning a past one is between
you and your payer.

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

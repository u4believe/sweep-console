# Hosted plans

You create a plan in the dashboard, share a link, and Sweep runs everything
after that: the checkout page, the schedule, renewals, trials, retries when a
payment fails, and a portal where subscribers manage what they pay for.

**You write no billing code.** The only thing you build is a webhook handler
that tells your app who subscribed. A link and a webhook handler need no API
key; calling Sweep from your own server does — see
[Do you need an API key?](#do-you-need-an-api-key) below.

## The shape of it

1. Create a plan with one or more tiers — name, price, interval, trial, features.
2. Share the payment link (`/pay/<id>`), or send people to a checkout session you
   create from your own server.
3. Handle `subscription.created` to unlock whatever they bought.
4. Handle `subscription.renewed` and `subscription.cancelled` to keep it in step.

That is the integration. Everything else is Sweep's problem.

## Do you need an API key?

Only for step 2's second half, and for reading anything back.

| What you are doing | API key |
| --- | --- |
| Share a payment link (`/pay/<id>`) | **no** |
| Receive webhooks | **no** — verification uses the webhook *signing secret*, which is a different credential |
| Create a checkout session from your server | **yes** |
| Read or change anything over the API — subscriptions, plans, payments, webhook endpoints | **yes** |

Everything under `/v1` takes a key. Nothing else does.

So "you write no billing code" holds for the link-and-webhook integration,
and that genuinely needs no key. The moment your server calls Sweep —
to open a session for a signed-in user, or to ask what a subscriber's
state is rather than waiting to be told — you need one. Issue it under
**API keys**.

## One plan, several tiers

Each account has **one active plan** with optional tiers. Creating a second is
refused with `409 plan_exists` until the first is deleted — tiers are how you
cover several price points within the one plan.

::: warning A tier's interval is fixed
The price is editable; the interval is not. The billing period is baked into
every subscriber's signed permission, so changing it would mean re-collecting
consent from all of them. A new tier is the honest way to do that.
:::

## Two ways to send someone to checkout

**A payment link** is the whole integration for a public page: it is a URL, and
appending `?ref=<your user id>` carries your id through to every webhook.

**A checkout session** is the right call inside a logged-in app, because the id
comes from your session rather than a URL the payer can edit:

```ts
const session = await sweep.checkout.sessions.create({
  plan: "plan_pro",
  externalRef: req.user.id,
  successUrl: "https://app.example.com/welcome",
  cancelUrl: "https://app.example.com/pricing",
});
res.json({ url: session.url });
```

Whichever you use, `external_ref` is the **one** value that reaches your
webhook handler — it is a top-level envelope field, and on a checkout session
it is required. `metadata` does not travel on events; see
[the payload](/webhooks/payload#envelope-fields).

Use your immutable internal user id, not an email or a username. It is what
your entitlement logic will key on, and a user who changes their email should
not change what they are entitled to.

## Upgrading the account

Handle `subscription.created`, look the user up by `external_ref`, and grant
what `data.tier_id` says they bought:

```ts
app.post("/webhooks/sweep", verifySignature, async (req, res) => {
  const { event_type, external_ref, data } = req.body;

  if (event_type === "subscription.created") {
    await db.users.update(external_ref, { tier: data.tier_id });
  }
  if (event_type === "subscription.cancelled" || event_type === "subscription.past_due") {
    await db.users.update(external_ref, { tier: null });
  }
  res.sendStatus(200);
});
```

Handle the cancellations as seriously as the upgrade. An entitlement nothing
ever revokes is a paid plan being given away.

## Do not depend on delivery alone

A webhook can be missed — your server restarts, your host has a bad minute.
Reconcile on sign-in:

```ts
const sub = await sweep.subscriptions.status(req.user.id);
// => the subscription for that external_ref, or null
```

That is `GET /v1/subscriptions/status?external_ref=…` and it needs an API key.
It turns a missed event into a one-page-load delay rather than a subscriber
who paid and never got what they paid for.

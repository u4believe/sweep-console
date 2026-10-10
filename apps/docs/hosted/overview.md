# Hosted plans

You create a plan in the dashboard, share a link, and Sweep runs everything
after that: the checkout page, the schedule, renewals, trials, retries when a
payment fails, and a portal where subscribers manage what they pay for.

**You write no billing code.** The only thing you build is a webhook handler
that tells your app who subscribed.

## The shape of it

1. Create a plan with one or more tiers — name, price, interval, trial, features.
2. Share the payment link (`/pay/<id>`), or send people to a checkout session you
   create from your own server.
3. Handle `subscription.created` to unlock whatever they bought.
4. Handle `subscription.renewed` and `subscription.cancelled` to keep it in step.

That is the integration. Everything else is Sweep's problem.

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

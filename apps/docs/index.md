---
layout: home

hero:
  name: Sweep Console
  text: Recurring USDC, straight from a wallet
  tagline: Hosted plans with no billing code, or a rail you drive yourself. Paid on Base, Arbitrum or Optimism; settled on Arc.
  image:
    src: /logo.svg
    alt: Sweep Console
  actions:
    - theme: brand
      text: Hosted plans
      link: /hosted/overview
    - theme: alt
      text: Payment rail
      link: /rail/quickstart
    - theme: alt
      text: Webhooks
      link: /webhooks/setup

features:
  - title: One signature, then nothing
    details: The payer signs once in their wallet. Every renewal after that is gasless — the platform submits each transaction and covers the gas and the bridge fee.
  - title: Paid anywhere, settled on Arc
    details: They pay from Base, Arbitrum or Optimism. It arrives in your payout wallet on Arc, bridged over CCTP, netting you the same amount whichever chain it came from.
  - title: You keep the ceiling honest
    details: What a payer signs is a cap per period, not a price. Charge under it as often as your billing says; go over it and we ask them to re-authorize rather than charge them anyway.
---

## Which one do I want?

These docs are for the person **integrating** Sweep. "You" is you, the developer;
the person paying is "your subscriber" or "the payer". Where a step happens in
the dashboard rather than in code, it says so.

There are two ways to take money, and the difference is **who owns the billing
clock**.

### Hosted plans

You create a plan, share a link, and Sweep runs everything after that — the
checkout page, the schedule, renewals, trials, retries when a payment fails, and
a portal where subscribers manage what they pay for. **You write no billing
code**; a webhook handler tells your app who subscribed.

Start here unless you already have a billing system.

### The payment rail

Your app already knows what to charge and when. Sweep is only the thing that
moves USDC out of a wallet. You create a mandate, the payer signs it once, and
from then on your code calls `POST /v1/charges` whenever your own logic says it
is time. No plans, no schedule, no renewal engine.

Choose this for usage-based pricing, your own tiers, or a billing system you are
not replacing.

| | Hosted plans | The rail |
| --- | --- | --- |
| Who owns the billing clock | Sweep decides when a subscription is due and collects it | You. Nothing here has a schedule of its own |
| Who sets the price | A plan you create in the dashboard, with optional tiers | Your app, on every call |
| How a charge happens | Automatically, once per period, until cancelled | You call `POST /v1/charges`, as often as you like under the ceiling |
| Trials | `trial_days` on the plan | Don't charge yet. A mandate costs the payer nothing until you do |
| What you write | A webhook handler | A webhook handler, plus the calls that charge |

One account can run both. Mandates are invisible to the renewal engine, so the
two never collide.

::: warning Two things to know before you build on either
**Live API keys are not issued yet**, so both are test-mode today — the SDK
refuses a key beginning `live_`.

**Neither has refunds.** Every charge settles straight to your payout wallet, so
there is nothing held that could be returned. Refunding is a transfer you make
yourself; cancelling stops future charges without reversing past ones.
:::

## A naming note

The dashboard calls your account a **creator** account. The API and every
webhook call it a **merchant** — `merchant_id`. Same thing, two words, and these
docs use whichever matches the screen or the payload in front of you.

## The fee

The platform takes <Fee /> of every settled charge, so you keep <Fee keeps />.
That figure is read live from the API as this page loads, not written into it,
so it cannot quietly disagree with what you are actually charged.

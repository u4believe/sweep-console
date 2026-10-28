# Your account

## Sign up

Go to [Sign up](https://www.sweepconsole.xyz/signup) and choose email or Google.

- **Email**: you verify via a link, where you set a password.
- **Google**: you are signed in straight away, with no link to open.

## Set up your authenticator

On the live dashboard, four things need an authenticator app on the account
before you can use them:

| Action | What it needs |
| --- | --- |
| Create a plan | an authenticator **enrolled** — no code typed |
| Request rail access | an authenticator **enrolled** — no code typed |
| Issue an API key | a **code**, every time |
| Withdraw from a Sweep wallet | a **code**, every time |

The first two ask only that the second factor exists. The last two hand over a
credential or move money, so they ask you to prove it each time — and they do
not accept an emailed code, because the inbox is also where password resets
land.

Settings → Security, about a minute. You get recovery codes for if you lose
the phone; keep them somewhere other than the phone.

**None of this applies on the sandbox.** Test mode moves no real USDC and
issues no key that can, so nothing there asks you to confirm anything. Set up
your plans and integration freely, and enrol when you go live.

## Create your plan

In the dashboard. One plan per account, with optional tiers — name, price,
interval, trial, features. You can add tiers later, and reprice them.

The **interval is fixed** once a tier exists. A monthly tier cannot become
yearly, because the billing period is part of what every subscriber's wallet
signed. Create a new tier instead.

**The minimum price on live is 2.00 USDC**, per plan and per tier. Collecting
a payment costs roughly the same in network fees whatever its size — three
transactions across two chains, measured at $0.016 on Base and $0.043 on
Arbitrum — and the payer chooses the chain, not you. Below 2.00 the fee on
the dearer chain would take more than the payment is worth, and a subscription
renews itself, so it would keep doing so.

Existing tiers priced below it keep working; only new ones and edits are held
to it. **Test mode has no minimum**, so you can still try a 1-cent plan to see
how the product behaves.

## Link a payout wallet

Connect one, or create a Circle user-controlled Programmable Wallet from the
dashboard. **USDC settles here**, on Arc.

Do this early. On the rail especially, a mandate will be created and authorized
without one, and then the first charge fails with `no_payout_wallet` — after the
payer has already signed.

**One wallet per mode.** The test and live dashboards are separate sites, and a
payout wallet belongs to the one it was created on: a Circle wallet made in
test does not exist to the live environment, and the chains differ too (Arc
testnet against Arc). So linking a wallet in test does not give you one for
live — do it again at
[www.sweepconsole.xyz](https://www.sweepconsole.xyz) before your first live
charge, or that charge fails with `no_payout_wallet` for the same reason.

## Then

Share your payment link (`/pay/<id>`), and optionally generate API keys and
register a webhook endpoint.

::: info Test and live are separate
A `test_` key works only against `https://api-sandbox.sweepconsole.xyz` and a
`live_` key only against `https://api.sweepconsole.xyz`. Each refuses the
other with a `403` naming the right host, and the Node client picks for you
from the key's prefix.

Your plans, keys, webhook endpoints and payout wallet are tracked separately
per mode, so what you set up in test does not carry across.
:::

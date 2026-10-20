# Your account

## Sign up

Go to [Sign up](https://www.sweepconsole.xyz/signup) and choose email or Google.

- **Email**: you verify via a link, where you set a password.
- **Google**: you are signed in straight away, with no link to open.

## Create your plan

In the dashboard. One plan per account, with optional tiers — name, price,
interval, trial, features. You can add tiers later, and reprice them.

The **interval is fixed** once a tier exists. A monthly tier cannot become
yearly, because the billing period is part of what every subscriber's wallet
signed. Create a new tier instead.

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

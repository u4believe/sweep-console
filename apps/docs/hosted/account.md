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

## Then

Share your payment link (`/pay/<id>`), and optionally generate API keys and
register a webhook endpoint.

::: info Live keys are not issued yet
Everything is test mode today. The SDK refuses a key beginning `live_` rather
than letting you discover it three calls later.
:::

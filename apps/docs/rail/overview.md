# What the rail is

Hosted plans are Sweep's other half: you create a plan, we run the checkout, and
we own the billing clock. The rail inverts that. **Your app keeps its own plans,
prices and schedule**, and uses Sweep only to move USDC out of a payer's wallet
on a standing authorization.

## Two objects

A **mandate** is one payer's signed, capped permission for one merchant.
A **charge** is one pull against it.

You decide when to charge. Nothing here has a schedule of its own, and the
renewal cron never touches a mandate.

| | |
| --- | --- |
| `POST /v1/mandates` | Mint a pending authorization and get a URL to send the payer to |
| `POST /v1/charges` | One pull, whenever your billing logic says so. Answers `202` |
| `DELETE /v1/mandates/:id` | Stop accepting charges against it. Idempotent |

## It is an entitlement, not a setting

`/v1/mandates` and `/v1/charges` answer `403 rail_not_enabled` until your
account is granted access. Access is granted rather than switched on, because
the rail decides whether an account may solicit recurring wallet authorizations
at all — and unlike a card network, there is no chargeback to unwind one.

::: danger Your API key moves your customers' money
This is the first place where a leaked key matters that much. Not to the thief —
a charge always settles to your payout wallet, and changing that wallet needs
your authenticator. But anyone holding the key can charge **every mandate you
have, up to its cap**. Treat it like a payment credential, because here that is
exactly what it is.
:::

# Limits & refusals

## The ceiling belongs to the mandate, not to a chain

A payer who signs on two chains has two independent on-chain caps. Sweep **sums
charges across them**, so `max_amount` per `interval` means what it says.

The period is a fixed window anchored at the moment the payer authorized — not a
rolling one.

A pending charge holds its share of the ceiling while it settles. A charge that
fails releases it.

## Refusals you should expect

| | |
| --- | --- |
| `amount_over_cap` | **422.** This single charge is larger than `max_amount` |
| `period_cap_exceeded` | **422.** It fits under `max_amount` but not under what is left this period. The message names what is committed, what remains, and when the period resets |
| `mandate_revoked` | **409.** The payer withdrew it, or you did. Stop charging |
| `mandate_not_active` | **409.** Never authorized, or no longer active |
| `grant_disabled` | The payer disabled the permission in their own wallet. Found at charge time, and the row is revoked locally |
| `no_payout_wallet` | You never linked one. Fix it in the dashboard and retry |

## Raising a price past the ceiling

`max_amount` is **fixed for the life of a mandate**. It is the number the payer's
wallet enforces, and nothing on your side or ours can raise it.

So a price increase past that ceiling is not an edit — it is a fresh
authorization:

1. Create a **second** mandate at the new amount.
2. Send the payer its `authorization_url`.
3. Charge the new one once `mandate.authorized` arrives.
4. **Then** revoke the old one.

::: warning Revoke last, not first
Revoke before they sign and you have cancelled a working authorization while
waiting on a signature that may never come. Until they sign, keep collecting on
the old mandate at the old amount — a payer who ignores the email keeps their
subscription working rather than silently lapsing.
:::

Charging **below** the cap needs none of this. Every `POST /v1/charges` names
its own amount, so lowering a price is simply charging less, with no
authorization change and nothing for the payer to do.

## A failed charge does not cancel anything

The mandate stays `active`. Nothing about the rail cancels an authorization on
your behalf — only the payer, from their wallet, or you, via
`DELETE /v1/mandates/:id`, which is idempotent and fires `mandate.revoked` with
`revoked_by: "merchant"`.

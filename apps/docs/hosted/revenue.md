# Revenue & settlement

## The split

The platform fee is <Fee />, so you keep <Fee keeps /> of every charge.

```
fee       = amount × platformFeeBps / 10000
you get   = amount − fee
```

Your share goes to your payout wallet on Arc; the fee goes to the platform
treasury. The split is computed **off-chain as the charge settles** and paid out
in the same bridge, so your share never sits in a contract.

The platform absorbs gas and bridge costs out of its share, which is why a
cross-chain charge nets you the same amount as a local one.

::: tip That percentage is live
It is read from the API as this page loads, not written into it. A number baked
into a docs site is a promise that goes stale the day the rate changes.
:::

## No escrow, no refund window

Every charge — the first one included — is pushed to your payout wallet as it
settles. Nothing is held back.

So there is **no automatic refund path**. Once a charge has settled, refunding
it is a transfer you make from your own wallet. Cancelling stops future charges;
it does not reverse past ones.

## Renewals

Each cycle the relayer redeems one period of the subscriber's grant on the
source chain, splits it, and bridges your share to Arc.

A failed renewal is retried **daily for about seven days** before the
subscription is closed. Each failure fires `subscription.past_due` and
`payment.failed`; the final one fires `subscription.cancelled` with
`cancel_reason`.

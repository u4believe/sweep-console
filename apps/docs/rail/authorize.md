# The authorization page

Send the payer to `authorization_url`. They connect a wallet and sign one
**ERC-7715 permission per chain**.

They may sign **fewer chains than you asked for**. The grants are the truth
about what is redeemable, and a skipped chain can be added later by reopening
the link while it is still valid.

## What it costs them

Signing needs an ERC-7715-capable wallet — MetaMask today. The first grant on a
chain also performs that wallet's one-time smart-account setup, which the wallet
submits itself and costs the payer a few cents of gas on that chain.

Every charge after that is **gasless** for them.

## When you may start charging

When at least one chain is signed, the mandate becomes `active` and
`mandate.authorized` fires with the `chain_ids` that were actually granted.

**That event is your signal** — not the redirect, which the payer can close.

```ts
"mandate.authorized": async (e) => {
  // chain_ids is what they really signed, which may be fewer than you asked for
  await db.users.activate(e.externalRef, { chains: e.data.chain_ids });
}
```

## The email they prove

The page asks the payer to verify an email with a 6-digit code before they can
sign. If you supplied one on the mandate it is **prefilled, not locked** — an
address you hold is eventually a stale address, and pinning it would turn a typo
in your CRM into a payer who cannot authorize at all.

What they proved comes back as `verified_email`, beside the `email` you sent.
When the two differ, that is the fact worth reconciling, and receipts go to the
proved one.

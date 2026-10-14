# Events

Pick only what you need — you receive just those types.

## Hosted plans

A plan you made in the dashboard, paid through Sweep's checkout or a payment
link. You call no API for these; the webhook is the whole integration.

| | |
| --- | --- |
| `checkout.session.completed` | A hosted checkout was paid and verified on-chain |
| `subscription.created` | A subscriber completed checkout and billing began. **This is the one that grants access** |
| `subscription.renewed` | A recurring charge succeeded. Carries `current_period_end` — use it rather than adding a month yourself |
| `subscription.past_due` | A renewal failed. Not cancelled yet; retried daily for seven days |
| `subscription.cancelled` | Billing stopped — by the subscriber, by you, or by a closed plan. `cancel_reason` says why |
| `payment.succeeded` | USDC settled on Arc for a charge |
| `payment.failed` | A renewal charge could not be collected. Carries `attempt` and `reason`, and arrives alongside `subscription.past_due` — subscribe to whichever you act on |

## The payment rail

These only fire for accounts the rail is enabled on.

| | |
| --- | --- |
| `mandate.authorized` | A payer signed. Carries the `chain_ids` actually granted — start charging on this, not on the redirect. Also `verified_email` and `wallet_reused` |
| `mandate.revoked` | The authorization is **finished** — nothing left to charge on any chain. Stop serving. `revoked_by` is `"merchant"` or `"payer"`; `on_chain` is always false |
| `grant.revoked` | A payer withdrew **one chain's** permission in their wallet. The authorization survives on the rest — read `remaining_chains` before you act |
| `grant.added` | A payer authorized an **extra chain** on a live mandate, from the link or their portal. More ways for a charge to succeed; nothing to stop. Carries `granted_chains` |
| `mandate.expiring` | Within the warning window of `expires_at` (7 days by default). Carries `days_remaining`. Sent once, not daily |
| `mandate.expired` | Passed its expiry and can no longer be charged. Sent once |
| `charge.succeeded` | A pull settled on Arc. Carries `source_chain` and the Arc `tx_hash` |
| `charge.failed` | A pull could not be collected. Carries `failure_code` — `insufficient_funds`, `mandate_period_consumed` and so on |

## On `mandate.revoked` and `grant.revoked`

**Only one of these means stop serving.** A payer can authorize you on three
chains and later disable one in their wallet; the other two still pay. That is
`grant.revoked`, and deactivating the customer on it cuts off someone who is
still paying you.

`mandate.revoked` fires when the last chain goes — or when you `DELETE` the
mandate, or the payer stops it from their portal. Nothing is left to charge.

Both carry the same two fields, so one handler covers either:

| | |
| --- | --- |
| `remaining_chains` | Chain keys still chargeable. `[]` on `mandate.revoked` |
| `mandate_still_active` | `false` only when the authorization is finished |

```ts
// One handler, both events. Act on the field, not the event name.
const onRevoke = async (e) => {
  if (e.data.mandate_still_active) {
    // One chain left the set. Still chargeable — Sweep picks from what remains.
    await db.mandates.setChains(e.data.mandate_id, e.data.remaining_chains);
    return;
  }
  if (e.data.revoked_by === "payer") await winback(e.externalRef);
  await db.users.deactivate(e.externalRef);
};

"grant.revoked":   onRevoke,
"mandate.revoked": onRevoke,
```

You do not have to choose a chain yourself — a charge picks from whatever is
still granted and funded. `remaining_chains` is there so your own records match
ours, and so an empty one is unmistakable.

## On `grant.added`

The mirror of `grant.revoked`: a payer authorized a chain they skipped earlier,
either by reopening the authorization link or from their Sweep portal. Nothing
to stop and no action required — it means one more way for your charges to
succeed.

It carries `granted_chains`, the whole chargeable set after the change, so the
same write works for either direction:

```ts
"grant.added":   async (e) => db.mandates.setChains(e.data.mandate_id, e.data.granted_chains),
"grant.revoked": async (e) => db.mandates.setChains(e.data.mandate_id, e.data.remaining_chains),
```

It does **not** fire during the first authorization — a payer signing three
chains at checkout produces one `mandate.authorized` carrying all three in
`chain_ids`, and three `grant.added` beside it would describe the same thing
twice. Nor on a re-signature, which replaces a grant rather than adding one.

`revoked_by` matters on `mandate.revoked`: your own `DELETE` and your payer
walking away want different handling, and without it the two are
indistinguishable. It is absent on `grant.revoked`, which only ever comes from
the payer's wallet.

Revoking never disables anything on chain. `disableDelegation` is
`onlyDeleGator`, so only the payer's own wallet can remove the permission —
which is why `on_chain` is always `false`. What a revoke guarantees is that
Sweep will not redeem it again.

A wallet-side withdrawal is invisible to us until we look, so `grant.revoked`
arrives after the daily reconciliation rather than the moment the payer acts.
A charge attempted in between fails with `mandate_period_consumed` or an
on-chain refusal, not silently.

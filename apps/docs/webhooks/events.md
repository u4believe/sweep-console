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

These four only fire for accounts the rail is enabled on.

| | |
| --- | --- |
| `mandate.authorized` | A payer signed. Carries the `chain_ids` actually granted — start charging on this, not on the redirect. Also `verified_email` and `wallet_reused` |
| `mandate.revoked` | An authorization stopped being redeemable. `revoked_by` is `"merchant"` or `"payer"`; `on_chain` is always false |
| `mandate.expiring` | Within the warning window of `expires_at` (7 days by default). Carries `days_remaining`. Sent once, not daily |
| `mandate.expired` | Passed its expiry and can no longer be charged. Sent once |
| `charge.succeeded` | A pull settled on Arc. Carries `source_chain` and the Arc `tx_hash` |
| `charge.failed` | A pull could not be collected. Carries `failure_code` — `insufficient_funds`, `mandate_period_consumed` and so on |

## On `mandate.revoked`

Revoking never disables anything on chain. `disableDelegation` is
`onlyDeleGator`, so only the payer's own wallet can remove the permission —
which is why `on_chain` is always `false`. What a revoke guarantees is that
Sweep will not redeem it again.

`revoked_by` matters: your own `DELETE` and your payer walking away want
different handling, and without it the two are indistinguishable.

```ts
"mandate.revoked": async (e) => {
  if (e.data.revoked_by === "payer") await winback(e.externalRef);
  await db.users.deactivate(e.externalRef);
}
```

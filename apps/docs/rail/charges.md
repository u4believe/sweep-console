# Charges

One pull, when your billing logic says it is time. An `Idempotency-Key` header
is **required**, not advisory.

::: code-group
```ts [SDK]
const charge = await sweep.charges.create(
  {
    mandate: "mdt_44d0a31d527ab8cda253",
    amount: usdc("2.00"),
    description: "Pro plan — September",
  },
  { idempotencyKey: "invoice_2026_09_user_8412" }
);
```
```sh [curl]
curl -X POST https://api.sweepconsole.xyz/v1/charges \
  -H "Authorization: Bearer $SWEEP_API_KEY" \
  -H "Idempotency-Key: invoice_2026_09_user_8412" \
  -H "Content-Type: application/json" \
  -d '{
    "mandate": "mdt_44d0a31d527ab8cda253",
    "amount": 2000000,
    "description": "Pro plan — September"
  }'
```
:::

```json
// 202 Accepted
{ "id": "chg_7ed2374c97ea164c4e27", "status": "pending", "amount": 2000000 }
```

## It answers 202, never 200

Every charge is cross-chain — Arc cannot back a mandate — so collecting is a
pull, a burn, an attestation and a mint: seconds to minutes.

The charge row exists the moment we answer. **The money arrives later.** Learn
the outcome from `charge.succeeded` / `charge.failed`, or by polling
`GET /v1/charges/:id`.

## Which chain pays

You do not choose. Sweep takes the mandate's active grants, drops any whose
signed cap cannot cover the amount, drops any already redeemed this period,
scans live balances, and collects from one that can pay.

## Write the description for the payer

It is the only text they see on their receipt. Sweep cannot know your plan
names, so "Pro plan — September" is useful to them and `inv_8412_retry2` is not.

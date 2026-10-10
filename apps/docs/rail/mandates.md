# Mandates

A mandate cannot be created server-to-server, because the permission is a wallet
signature. Creating one mints a `pending` row and returns a hosted URL for the
payer to open — the same redirect shape as a hosted checkout.

::: code-group
```ts [SDK]
const mandate = await sweep.mandates.create({
  externalRef: "user_8412",
  email: "ada@example.com",
  maxAmount: usdc("5.00"),
  interval: "daily",
  chains: ["base", "arbitrum", "optimism"],
  expiresAt: new Date("2027-09-12"),
  metadata: { plan: "pro" },
});
```
```sh [curl]
curl -X POST https://api.sweepconsole.xyz/v1/mandates \
  -H "Authorization: Bearer $SWEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_ref": "user_8412",
    "email": "ada@example.com",
    "max_amount": 5000000,
    "interval": "daily",
    "chains": ["base", "arbitrum", "optimism"],
    "expires_at": "2027-09-12T00:00:00.000Z",
    "metadata": { "plan": "pro" }
  }'
```
:::

## The fields that matter

| | |
| --- | --- |
| `max_amount` | USDC in micro-units — `5000000` is 5 USDC. An integer, because a float here is a rounding bug that ends in someone being charged the wrong amount |
| `interval` | `daily`, `weekly`, `monthly` or `yearly` — the period the ceiling applies to |
| `chains` | Where the payer may authorize. `arc` is rejected: recurring authority there is a permit to a contract, not the wallet permission this rail redeems |
| `external_ref` | **Your** id for this payer. Echoed on every webhook, so you never store ours |
| `email` | Prefilled on the authorization page, and the payer may change it. Omit it and they supply their own |

## Two expiries, and they are not the same

The response carries `authorization_url` and, separately,
`authorization_url_expires_at`.

- The **link** lasts 24 hours.
- The **mandate** lasts until `expires_at`.

Conflating them ships a broken email. Once the mandate is authorized,
`authorization_url` comes back `null`.

## One live mandate per payer

A second live mandate under the same `external_ref` is refused with
`409 mandate_exists`, carrying the existing `mandate_id` and — when it is still
pending — its `authorization_url`, so a create retried after a timeout hands you
the link back instead of a duplicate.

Two live mandates for one payer are two independent delegations with independent
period enforcers: their ceilings **add up**, and both can be charged.

Sharing a wallet across *different* `external_ref`s is allowed — one person
paying for two seats, or a household wallet, is legitimate, and each payer proved
their own email. `mandate.authorized` carries `wallet_reused` so you can apply
your own rule.

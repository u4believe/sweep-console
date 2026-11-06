# What a subscriber does

The flow your payers go through on the hosted checkout. You build none of it.

1. **They open your link** and pick a tier.

2. **They verify their email** with a 6-digit code. A returning subscriber may
   not be asked again — email is the identity anchor on each merchant, and the
   wallet is the payment method attached to it.

3. **They connect a wallet.** Never automatically; connecting is always an
   explicit action.

4. **They pay in USDC on Base, Arbitrum, Optimism or Monad** — gasless. One
   signature authorizes the recurring charge; the platform submits the
   transaction and pays the gas. The money goes straight to your payout
   wallet on that same chain.

5. **The first charge settles to you immediately.** A trial starts free and
   takes nothing. After that, renewals are automatic and gasless, with no
   further signatures.

## What you get told

`subscription.created` fires when billing begins, carrying who subscribed:

```json
{
  "subscription_id": "sub_…", "plan_id": "plan_pro", "plan_name": "Pro",
  "tier_name": "Monthly", "amount": 29000000, "currency": "USDC",
  "interval": "monthly", "status": "active",
  "customer_id": "cus_…", "subscriber_email": "ada@example.com",
  "wallet_address": "0x…", "chain": "base", "settlement_chain": "base"
}
```

`settlement_chain` is the chain the money actually landed on, and `tx_hash` is
a transaction on it. On deployments that still bridge to Arc it reads `"arc"`
and the hash is the Arc mint, so look it up there instead. `GET /config` says
which applies: `settlement_model` is `"direct"` or `"bridged"`.

`customer_id` is stable across every wallet that person ever pays from, which
makes it the better key if you are storing one.

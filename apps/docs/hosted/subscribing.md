# What a subscriber does

The flow your payers go through on the hosted checkout. You build none of it.

1. **They open your link** and pick a tier.

2. **They verify their email** with a 6-digit code. A returning subscriber may
   not be asked again — email is the identity anchor on each merchant, and the
   wallet is the payment method attached to it.

3. **They connect a wallet.** Never automatically; connecting is always an
   explicit action.

4. **They pay in USDC on Base, Arbitrum or Optimism** — gasless. One signature
   authorizes the recurring charge; the platform submits the transaction, pays
   the gas, and bridges to Arc over CCTP.

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
  "wallet_address": "0x…", "chain": "base", "settlement_chain": "arc"
}
```

`customer_id` is stable across every wallet that person ever pays from, which
makes it the better key if you are storing one.

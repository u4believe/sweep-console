# SweepConsole Contracts

Solidity smart contracts for the SweepConsole subscription billing platform, built with **Foundry**.

## Setup

```bash
# Install Foundry (if not already installed)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Install OpenZeppelin (from inside packages/contracts/)
forge install OpenZeppelin/openzeppelin-contracts --no-commit

# Compile
forge build

# Run tests
forge test -vv

# Run tests with gas report
forge test --gas-report

# Run fuzz tests with more runs
forge test --fuzz-runs 10000
```

## Contract: SubscriptionManager

| Function | Who Can Call | Description |
|---|---|---|
| `subscribe()` | Subscriber | Activates a plan. First payment collected immediately (or deferred for trials). |
| `cancel()` | Subscriber or Platform | Cancels the subscription on-chain. |
| `claimFunds()` | Merchant | Pulls accumulated USDC out of the contract. |
| `renew()` | Platform only | Billing engine calls this each cycle to collect recurring payment. |
| `refund()` | Platform only | Issues a pro-rated refund from the merchant's balance. |

## Deploy

```bash
# Copy env
cp .env.example .env
# Fill in PRIVATE_KEY, USDC_ADDRESS, PLATFORM_TREASURY, PLATFORM_FEE_BPS

# Deploy to Arc testnet
forge script script/Deploy.s.sol --rpc-url arcTestnet --broadcast --verify -vvvv
```

## ABI

After `forge build`, the ABI is at:
`out/SubscriptionManager.sol/SubscriptionManager.json`

Copy the `abi` field into `apps/web/src/lib/chain/abis/SubscriptionManager.ts` for use with viem.

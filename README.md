# SweepConsole

A Stripe-like **stablecoin subscription platform** built on **Arc** (Circle's L1) with **USDC** settlement. Creators define a plan (with tiers), share a checkout/payment link, and get paid in USDC to a non-custodial wallet. Subscribers pay on Arc — or **from USDC on other chains** (Base / Arbitrum / Optimism) bridged to Arc via Circle's **CCTP V2**. Recurring renewals are handled by an off-chain billing engine against an on-chain `SubscriptionManager` contract.

This README covers **(1) how to set the project up locally** and **(2) how the Circle tooling is integrated** (Programmable Wallets, CCTP V2, and Webhooks).

---

## Table of contents

- [Why Sweep Console](#why-sweep-console)
- [Architecture](#architecture)
- [Circle integration](#circle-integration)
  - [1. Programmable Wallets (creator payout wallets)](#1-programmable-wallets-creator-payout-wallets)
  - [2. CCTP V2 (cross-chain checkout & renewals)](#2-cctp-v2-cross-chain-checkout--renewals)
  - [3. Webhooks (deposit notifications)](#3-webhooks-deposit-notifications)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running the project](#running-the-project)
- [Environment variables](#environment-variables)
- [Scripts reference](#scripts-reference)
- [Local development notes](#local-development-notes)

---

## Why Sweep Console

For decades, developers have billed a global audience in US dollars over card and bank rails — which quietly breaks down the moment a user is outside the US or a developer wants to keep their full revenue. Sweep Console denominates everything in **USDC**, settles on **Arc**, and moves funds cross-chain via **Circle CCTP V2**, solving these problems at the rail level rather than papering over them.

### For subscribers

**1. Exchange-rate volatility & conversion costs.** Outside the US, weak and volatile local currencies mean the same ~$50 of subscriptions can cost a different amount every billing cycle once banks re-convert and add a margin.
→ **Sweep prices every plan in USDC.** A $50 plan is 50 USDC, every cycle — pulled directly on-chain, with no bank re-converting at a fresh rate and no conversion margin skimmed on top.

**2. Hidden card fees & failed renewals.** Banks layer foreign-transaction and conversion fees onto every charge, and a recurring charge dies the moment the account isn't pre-funded.
→ **No card network means no surprise fees** — only the subscription amount moves. The user authorizes once; a failed charge is **retried daily for ~7 days** before anything is cancelled, and Sweep can pull the renewal from **any chain where the user holds USDC**, so a shortfall on one network doesn't break the subscription.

**3. No real refund mechanism.** Traditional rails offer users little path to a refund; where one exists, it commonly takes 3–5 business days and returns less than was paid once fees are taken out.
→ **On-chain escrow with instant refunds.** First payments are held in escrow for a settlement window (24h by default); cancelling within it returns **100% of the funds in the same transaction** — instant, full amount, nothing deducted — self-serve from the customer portal.

**4. Regional exclusion.** Card and bank rails (SWIFT, Visa, Mastercard) can lock entire regions out of global services overnight.
→ **Open stablecoin rails.** Anyone with an internet connection and a USDC balance can subscribe — no dependency on correspondent banking or card issuers that arbitrarily exclude a region.

**5. Crypto payments are usually broken.** Most crypto billing has no real auto-renewal, makes users pay their own gas, and forces risky manual bridging.
→ **Sweep fixes all three:** a single capped, revocable permission enables **true set-and-forget renewals** (no per-cycle signatures); the platform relayer pays **all gas** (users only sign free off-chain messages); and **CCTP V2** lets users pay from the chain they already hold USDC on, bridged to Arc automatically with the **full amount preserved** (the platform absorbs the bridge fee).

### For developers

**1. Unpredictable, eroding revenue.** Card processors take ~2.9% + a fixed fee, climbing to 4–6% on international cards, before VAT/tax obligations.
→ **A flat 2% protocol fee, enforced on-chain** — creators keep **98%** of every payment, the same every time, with no per-card surcharge, FX margin, or climbing "international" rate.

**2. Exposure to crypto volatility.** Accepting volatile crypto means $100 paid can settle as $90 by the time it lands.
→ **Everything settles in USDC** — $100 settles as 100 USDC, with no drift between payment and settlement. Dollar-denominated, forecastable revenue.

**3. Juggling wallets across chains.** No single wallet supports every chain, forcing a patchwork of payout wallets, reconciliation headaches, and extra security surface.
→ **One payout wallet.** A single **Circle Programmable Wallet on Arc** receives all revenue — whatever chain the customer paid from is bridged via CCTP and settled to that one address.

---

## Architecture

A pnpm monorepo with three workspaces:

```
SweepConsole/
├── apps/
│   ├── api/          # Express + TypeScript backend (REST API, billing engine, Circle/CCTP integration)
│   └── web/          # Vite + React frontend (creator portal + subscriber checkout)
└── packages/
    └── contracts/    # Foundry (Solidity) — SubscriptionManager on Arc
```

| Layer | Stack |
|---|---|
| **Frontend** (`apps/web`) | Vite, React, TypeScript, Tailwind, wagmi + RainbowKit, Circle Web SDK |
| **Backend** (`apps/api`) | Node, Express, TypeScript (`tsx`), Prisma, viem |
| **Database** | PostgreSQL (Prisma schema lives in `apps/web/prisma/schema.prisma`) |
| **Contracts** (`packages/contracts`) | Foundry, Solidity `0.8.24`, OpenZeppelin |
| **Chain** | Arc testnet/mainnet (USDC is the native gas token on Arc) |

**Core on-chain contract** — `SubscriptionManager` (Arc): settlement-window escrow for first payments, allowance-based renewals (`renewFromAllowance`), gasless `subscribeWithPermit`, owner-callable `cancelSubscription` (refunds escrow), and push settlement to creator + platform treasury.

**Billing engine** (`apps/api/src/billing`, run via `pnpm --filter @sweep/api billing:run`): a cron process that, each cycle, charges due subscriptions **Arc-first** (`processRenewals`) and then **cross-chain** (`runDelegatedRenewalsOnce`) for subscribers whose Arc balance is short. A per-`(subscription, period)` claim guarantees one charge per cycle even with liquidity on multiple chains.

---

## Circle integration

The platform integrates **three** Circle products. All HTTP calls go through small helpers in [`apps/api/src/lib/circle.ts`](apps/api/src/lib/circle.ts) (auth via `Authorization: Bearer ${CIRCLE_API_KEY}`, plus `X-User-Token` for user-scoped calls), with the base URL set by `CIRCLE_BASE_URL` (sandbox vs production).

### 1. Programmable Wallets (creator payout wallets)

Creators who don't bring their own wallet can **"Create a wallet"** — a Circle **user-controlled** Programmable Wallet that receives their USDC payouts. The PIN/biometric stays with the creator; the platform never holds keys.

**Flow** (backend helpers in `circle.ts`, portal routes in `apps/api/src/routes/portal.ts`):

| Step | Circle endpoint | Helper |
|---|---|---|
| Register the merchant as a Circle user | `POST /v1/w3s/users` | `createCircleUser(userId)` |
| Mint a short-lived user session token | `POST /v1/w3s/users/token` → `{ userToken, encryptionKey }` | `getCircleUserToken(userId)` |
| First-time setup: PIN challenge + wallet (EOA) | `POST /v1/w3s/user/initialize` | `createCircleWalletChallenge(userToken)` |
| Additional wallet (user already has a PIN) | `POST /v1/w3s/user/wallets` | `createCircleWalletForExistingUser(userToken)` |
| Read wallets / balances | `GET /v1/w3s/user/wallets`, `GET /v1/w3s/wallets/{id}/balances` | `getCircleWallets`, `getCircleWalletBalances` |
| **Withdraw** USDC out of the wallet | `POST /v1/w3s/user/transactions/transfer` | `createCircleTransferChallenge(...)` |

The backend returns `{ userToken, encryptionKey, challengeId, appId }` to the frontend, which drives the **Circle Web SDK** to collect the PIN and complete the `challengeId` (wallet creation or transfer signing). The chain is set by `CIRCLE_BLOCKCHAIN` (`ETH-SEPOLIA` in sandbox; `ARC-TESTNET` where supported), and the W3S app is identified by `NEXT_PUBLIC_CIRCLE_APP_ID` / `VITE_CIRCLE_APP_ID`.

> **Gotcha we hit:** the transfer endpoint needs a **top-level `feeLevel`** (`"LOW" | "MEDIUM" | "HIGH"`) for dynamic gas estimation. Omit it and Circle demands explicit `gasPrice`/`gasLimit` and returns `400 API parameter invalid`. Deposits never hit this path, which is why deposits worked but withdrawals failed until `feeLevel: "MEDIUM"` was added.

### 2. CCTP V2 (cross-chain checkout & renewals)

When a subscriber's USDC is on another chain, the platform bridges it to Arc with **Cross-Chain Transfer Protocol V2** (`apps/api/src/lib/gateway/cctp.ts`). Supported source testnets: **Base, Arbitrum, Optimism Sepolia** (`SUPPORTED_SOURCE_CHAINS`). BNB is excluded — CCTP V2 doesn't carry USDC there.

**Bridge flow:**
1. Burn on the source chain — `TokenMessengerV2.depositForBurn(...)` (Fast Transfer: soft finality + a small `maxFee`, capped by `CCTP_FAST_MAX_FEE_BPS`).
2. Fetch the attestation from Circle's **Iris** API (`CCTP_IRIS_URL`, default `https://iris-api-sandbox.circle.com`).
3. Mint on Arc — `MessageTransmitterV2.receiveMessage(message, attestation)`, minting USDC to the subscriber on Arc.

CCTP V2 testnet contracts share one address across chains, so addresses are baked in and only need overriding (`CCTP_TOKEN_MESSENGER_*`, `CCTP_MESSAGE_TRANSMITTER_ARC`) if Circle rotates them. This same bridge powers both the **first cross-chain payment** and **cross-chain renewals** (the relayer pulls one period from a source chain via a one-time ERC-7715 delegation, then CCTP-bridges it to Arc).

### 3. Webhooks (deposit notifications)

Inbound/outbound transaction notifications are received at `POST /circle-webhooks` ([`apps/api/src/routes/circle-webhooks.ts`](apps/api/src/routes/circle-webhooks.ts)) so the portal reflects deposits without polling.

- Subscribe: `POST /v2/notifications/subscriptions` for `transactions.inbound` / `transactions.outbound` — `registerWebhookSubscription(url)`, runnable via `pnpm --filter @sweep/api circle:register-webhook`.
- Verify: each delivery carries an ECDSA signature; the route fetches the signing key with `GET /v2/notifications/publicKey/{keyId}` (`getWebhookPublicKey`, base64-DER SPKI, cached) and verifies before acting.

In local dev, expose the API with a tunnel (e.g. ngrok) and set `CIRCLE_WEBHOOK_URL` to `https://<tunnel>/circle-webhooks`.

---

## Prerequisites

- **Node** ≥ 20 and **pnpm** ≥ 9 (`packageManager: pnpm@9.15.0`)
- **PostgreSQL** database (e.g. a Supabase project — gives pooled `DATABASE_URL` on `:6543` + direct `DIRECT_URL` on `:5432`)
- **Foundry** (`forge`) to compile/deploy the contract — https://book.getfoundry.sh/getting-started/installation
- A **Circle Developer account** (https://console.circle.com): an **API key**, a **W3S App ID** (for user-controlled wallets), and access to **CCTP** testnet
- A **WalletConnect** project ID (https://cloud.walletconnect.com) for the frontend wallet connectors
- SMTP credentials for transactional email (OTP / receipts)

---

## Setup

```bash
# 1. Clone + install
git clone <your-repo-url> SweepConsole
cd SweepConsole
pnpm install

# 2. Configure environment
cp .env.example apps/api/.env     # backend (see env table below)
cp .env.example apps/web/.env     # frontend — only VITE_* are read here
#   then edit both files with your values

# 3. Database — generate the Prisma client + create the schema
pnpm --filter @sweep/api db:generate
pnpm --filter @sweep/api db:push          # applies apps/web/prisma/schema.prisma

# 4. Deploy the SubscriptionManager contract to Arc
cd packages/contracts
forge build
forge script script/Deploy.s.sol --rpc-url <arc-testnet-rpc> --broadcast -vvvv
#   put the deployed address into SUBSCRIPTION_MANAGER_ADDRESS in apps/api/.env
cd ../..

# 5. Register the Circle webhook (optional — needs a public URL / tunnel)
pnpm --filter @sweep/api circle:register-webhook
```

The deploy script reads `PRIVATE_KEY`, `USDC_ADDRESS`, `PLATFORM_TREASURY`, `PLATFORM_FEE_BPS` (see `packages/contracts/.env`).

---

## Running the project

Three processes, each in its own terminal:

```bash
# Backend API  → http://localhost:4000
pnpm --filter @sweep/api dev

# Frontend     → http://localhost:3000   (strict port)
pnpm --filter web dev      # or: pnpm dev

# Billing engine (cron: renewals, settlement, retries)
pnpm --filter @sweep/api billing:run
```

The frontend pins port **3000** (`strictPort`), because payment links are generated as `http://localhost:3000/pay/...` via `NEXT_PUBLIC_APP_URL`. If 3000 is taken, free it rather than letting the dev server drift.

---

## Environment variables

Backend (`apps/api/.env`) — the most important:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Postgres (pooled / direct). Prisma uses the direct URL for migrations. |
| `JWT_SECRET`, `PLATFORM_API_SIGNING_SECRET` | Session JWT + API-key/OTP signing |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID — verifies "Continue with Google" sign-ins (anti-replay). Same value as `VITE_GOOGLE_CLIENT_ID`. |
| `CIRCLE_API_KEY` | Circle API key (`TEST_API_KEY:...` for sandbox) |
| `CIRCLE_BASE_URL` | `https://api-sandbox.circle.com` (sandbox) or `https://api.circle.com` |
| `NEXT_PUBLIC_CIRCLE_APP_ID` | W3S App ID for user-controlled wallets |
| `CIRCLE_BLOCKCHAIN` | Wallet chain (`ETH-SEPOLIA` sandbox / `ARC-TESTNET`) |
| `CIRCLE_WEBHOOK_URL` | Public URL Circle posts notifications to (`…/circle-webhooks`) |
| `ARC_NETWORK`, `ARC_TESTNET_RPC_URL`, `ARC_MAINNET_RPC_URL` | Arc RPC selection |
| `PLATFORM_PRIVATE_KEY` | Platform/relayer key (arbiter of the contract; submits renewals) |
| `PLATFORM_TREASURY_ADDRESS`, `PLATFORM_FEE_BPS` | Fee split |
| `SUBSCRIPTION_MANAGER_ADDRESS` | Deployed contract address on Arc |
| `SETTLEMENT_WINDOW_HOURS`, `BILLING_CRON_SCHEDULE` | Escrow window + cron schedule |
| `SUPPORTED_SOURCE_CHAINS` | `base,arbitrum,optimism` |
| `CCTP_IRIS_URL`, `CCTP_FAST_MAX_FEE_BPS` | CCTP attestation API + Fast-transfer fee cap |
| `SMTP_*` | Transactional email |

Frontend (`apps/web/.env`):

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Backend URL (`http://localhost:4000`) |
| `VITE_CIRCLE_APP_ID` | W3S App ID (Circle Web SDK) |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID (same value as `GOOGLE_CLIENT_ID`) — enables the Google sign-in buttons |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect connectors |
| `VITE_TIER2_DELEGATION` | Enable the in-checkout "automatic cross-chain renewals" option |

See [`.env.example`](.env.example) for the complete, commented list.

---

## Scripts reference

| Command | What it does |
|---|---|
| `pnpm dev` | Run the frontend (`apps/web`) |
| `pnpm dev:api` | Run the backend (`apps/api`) |
| `pnpm --filter @sweep/api billing:run` | Run the billing cron (renewals / settlement / retries) |
| `pnpm --filter @sweep/api circle:register-webhook` | Register the Circle notification subscription |
| `pnpm db:push` | Apply the Prisma schema to the database |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm --filter contracts test` | Run the Foundry contract tests |
| `pnpm build` / `pnpm typecheck` | Build / typecheck the frontend (+ contracts typecheck) |

---

## Local development notes

- **Circle sandbox first.** Use `CIRCLE_BASE_URL=https://api-sandbox.circle.com` and a `TEST_API_KEY`. Keep `CIRCLE_BLOCKCHAIN=ETH-SEPOLIA` unless your account has Arc enabled for W3S.
- **Webhooks need a public URL.** Tunnel the API (ngrok / cloudflared) and point `CIRCLE_WEBHOOK_URL` at `https://<tunnel>/circle-webhooks`, then run `circle:register-webhook`.
- **Contract redeploys reset state.** A fresh `SubscriptionManager` has no subscriptions; rows that referenced the old address are stranded. Create new subscriptions after a redeploy.
- **Supabase pooler.** The transaction pooler (`:6543`) backs the app; the direct connection (`:5432`) backs Prisma migrations. Both can be briefly flaky — a `db push` failure is usually transient, just retry.

---

Built with Arc, USDC, and Circle's developer platform.

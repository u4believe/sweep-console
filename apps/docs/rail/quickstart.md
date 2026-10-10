# Quickstart

The whole integration, in the order you write it. Four moves: create a mandate,
send the payer to sign it, listen for what happens, charge when your billing
says so. Everything after this page explains the pieces — you do not need any of
it to get a first charge working.

## Install

::: code-group
```sh [npm]
npm install @sweepconsole/node
```
```sh [pnpm]
pnpm add @sweepconsole/node
```
```sh [yarn]
yarn add @sweepconsole/node
```
:::

## The base URL

`https://api.sweepconsole.xyz` — the API is its own origin.

`www.sweepconsole.xyz` is the website, and it answers every path with the page
you are reading, so a client pointed there gets a `200` full of HTML rather than
JSON. The Node client already knows the right one, and refuses an `http://`
override so your key cannot go over plaintext.

## The whole thing

```ts
import { Sweep, usdc } from "@sweepconsole/node";
import express from "express";

const sweep = new Sweep(process.env.SWEEP_API_KEY!);
const app = express();

// 1 ─ a user subscribes: create the mandate, send them to sign it
app.post("/subscribe/usdc", async (req, res) => {
  const mandate = await sweep.mandates.create({
    externalRef: req.user.id,              // YOUR id — echoed on every event
    email: req.user.email,                 // prefilled for them, and editable
    maxAmount: usdc("15.00"),              // the CEILING, not the price
    interval: "monthly",
    chains: ["base", "arbitrum", "optimism"],
    expiresAt: new Date("2027-01-01"),
  });

  await db.users.update(req.user.id, { sweepMandate: mandate.id });
  res.redirect(mandate.authorizationUrl!);  // they sign in their wallet
});

// 2 ─ react to what happens. express.raw, not express.json — the signature is
//     over the raw bytes, and parsing first destroys them.
app.post(
  "/webhooks/sweep",
  express.raw({ type: "application/json" }),
  sweep.webhooks.express(process.env.SWEEP_WEBHOOK_SECRET!, {
    "mandate.authorized": async (e) => {
      // Start YOUR clock here, not on the return_url — they can close the tab.
      await db.users.update(e.externalRef, { usdcActive: true });
    },
    "charge.succeeded": async (e) => {
      await db.users.extend(e.externalRef, e.data.amount);
    },
    "charge.failed": async (e) => {
      await db.users.dunning(e.externalRef, e.data.failure_code);
    },
  })
);

// 3 ─ charge, whenever your own billing says to
await sweep.charges.create(
  { mandate: mandateId, amount: usdc("9.00"), description: "Pro — October" },
  { idempotencyKey: `inv_${invoice.id}` }
);
```

That is the integration. The rest is detail.

## What the payer signs

A **ceiling per period**, not a price. `maxAmount: usdc("15.00")` with
`interval: "monthly"` means you may take up to 15 USDC in any one month — in a
single charge or several — and not a cent more without asking again.

Give it headroom. A mandate at exactly your current price leaves you no room for
a plan change, and raising the ceiling needs a second signature.

::: tip Label the button "Subscribe", not "Pay"
What they are signing is standing authority with a ceiling. Someone who reads
"Pay $15" and then meets a wallet asking for recurring permission abandons the
checkout, and is right to.
:::

## Without the SDK

Every call is plain HTTP, so any stack works:

::: code-group
```sh [curl]
curl -X POST https://api.sweepconsole.xyz/v1/mandates \
  -H "Authorization: Bearer $SWEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_ref": "user_42",
    "email": "ada@example.com",
    "max_amount": 15000000,
    "interval": "monthly",
    "chains": ["base", "arbitrum", "optimism"],
    "expires_at": "2027-01-01T00:00:00Z"
  }'
```
```js [fetch]
const r = await fetch("https://api.sweepconsole.xyz/v1/mandates", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.SWEEP_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    external_ref: user.id,
    email: user.email,
    max_amount: 15_000_000,        // USDC micro-units: 15.00
    interval: "monthly",
    chains: ["base", "arbitrum", "optimism"],
    expires_at: "2027-01-01T00:00:00Z",
  }),
});
const { data } = await r.json();
res.redirect(data.authorization_url);
```
:::

Amounts are **USDC micro-units** — six decimal places, so `15_000_000` is 15.00.
The SDK's `usdc("15.00")` exists so you never do that conversion by hand at two
in the morning.

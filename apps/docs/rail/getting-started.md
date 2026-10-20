# Getting started

Five steps before you write any code, then three things to wire into your app.

Everything below is test mode, at
[sandbox.sweepconsole.xyz](https://sandbox.sweepconsole.xyz) against
`https://api-sandbox.sweepconsole.xyz`. Live works the same way with a `live_`
key against `https://api.sweepconsole.xyz` — see
[the base URL](./quickstart#the-base-url). The differences that matter are
called out below.

## Before any code

1. **Create an account and verify your email.** The same signup as any creator.

2. **Link a payout wallet** — Dashboard → Settings → Payout wallet. An Arc
   address, verified by signing a nonce.

   ::: warning Do this before anything else
   A mandate will be created and authorized perfectly happily without one, and
   then the first charge fails with `no_payout_wallet`. It fails **late** — after
   the payer has already signed.
   :::

3. **The rail — nothing to do in test.** It is open to every account on
   testnet. Create a key and start charging.

   ::: warning On mainnet this is the one step that is not self-serve
   Live rail access is granted per account: Dashboard → Payment rail → Request
   access. `/v1/charges` answers `403 rail_not_enabled` until it is. Ask early
   — it is the only part of this list that waits on someone else.

   Testnet access says nothing about live. They are tracked separately, so an
   account charging happily in test still needs granting before its first real
   charge.
   :::

4. **Create an API key** — Dashboard → API Keys → Regenerate. You will be
   asked to confirm it is you. The key is shown once; copy it then.

   The key carries its own mode: a `test_` key only works against the sandbox
   API and a `live_` key only against the live one, each refusing the other
   with a `403` that names the right host.

5. **Register a webhook endpoint** — Dashboard → Webhooks → Add endpoint,
   subscribed to `mandate.authorized`, `mandate.revoked`, `grant.revoked`,
   `grant.added`, `charge.succeeded` and `charge.failed`.

   The two `grant.*` events are the ones people miss. A payer can disable one
   chain and keep paying on the others, or add one they skipped — only
   `mandate.revoked` means stop serving.

   It must be a public `https://` URL. `localhost` is refused, and the address is
   re-checked before every delivery, so use a tunnel while developing.

## Then, in your app

| | |
| --- | --- |
| **Create** | `POST /v1/mandates`, and store the returned `mdt_…` against that user |
| **Redirect** | Send them to the `authorization_url` from that response |
| **Activate** | On the `mandate.authorized` webhook — **not** on the redirect. A payer can close the tab before it returns |

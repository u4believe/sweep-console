# Getting started

Five steps before you write any code, then three things to wire into your app.
Everything below is test mode — live keys are not issued yet.

## Before any code

1. **Create an account and verify your email.** The same signup as any creator.

2. **Link a payout wallet** — Dashboard → Settings → Payout wallet. An Arc
   address, verified by signing a nonce.

   ::: warning Do this before anything else
   A mandate will be created and authorized perfectly happily without one, and
   then the first charge fails with `no_payout_wallet`. It fails **late** — after
   the payer has already signed.
   :::

3. **Ask us to enable the rail** — Dashboard → Payment rail → Request access.
   The one step that is not self-serve. Once granted, that screen becomes your
   mandates and charges instead, which is how you know it worked.

4. **Create a test API key** — Dashboard → API Keys → Regenerate. You will be
   asked to confirm it is you. The key is shown once; copy it then.

5. **Register a webhook endpoint** — Dashboard → Webhooks → Add endpoint,
   subscribed to `mandate.authorized`, `mandate.revoked`, `charge.succeeded` and
   `charge.failed`.

   It must be a public `https://` URL. `localhost` is refused, and the address is
   re-checked before every delivery, so use a tunnel while developing.

## Then, in your app

| | |
| --- | --- |
| **Create** | `POST /v1/mandates`, and store the returned `mdt_…` against that user |
| **Redirect** | Send them to the `authorization_url` from that response |
| **Activate** | On the `mandate.authorized` webhook — **not** on the redirect. A payer can close the tab before it returns |

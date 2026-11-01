# Payload & headers

Every event is a JSON `POST` with the same envelope. The `data` object varies by
event type.

```http
POST /webhooks/sweep
Content-Type: application/json
X-Sweep-Event: payment.succeeded
X-Sweep-Event-Id: evt_8f3a2c...
X-Sweep-Signature: sha256=2b9c4e7a...

{
  "event_id": "evt_8f3a2c...",
  "event_type": "payment.succeeded",
  "created_at": "2026-06-27T10:15:00.000Z",
  "merchant_id": "XXXX-XXXX-XXXX",
  "external_ref": "your-user-id-123",
  "data": {
    "subscription_id": "sub_abc123",
    "plan_id": "plan_pro",
    "amount": 5000000,
    "currency": "USDC"
  }
}
```

## Headers

| | |
| --- | --- |
| `X-Sweep-Event` | The event type, so you can route without parsing the body |
| `X-Sweep-Event-Id` | Stable across every retry of the same event. **Dedupe on this** |
| `X-Sweep-Signature` | `sha256=` followed by the hex HMAC of the raw body |

## Envelope fields

`external_ref` is **your** id — the one you supplied when creating the mandate
or checkout session. Use it to map the event back to your own user.

::: warning With a payment link you did not set one
The hosted link generates an `external_ref` for you, so it will not match
anything in your database. For hosted plans, identify on
`data.subscriber_email` or `data.customer_id`, which is stable across every
wallet that person pays from — or append `?ref=<your user id>` to the link,
which the hosted page forwards.

Do not trust a `?ref=` for anything that matters: the payer can edit a URL.
:::

Amounts are **USDC micro-units**, six decimals. `5000000` is 5.00 USDC.

::: danger `metadata` is never sent on a webhook
The envelope is exactly `event_id`, `event_type`, `created_at`, `merchant_id`,
`external_ref` and `data`. Whatever you passed as `metadata` when creating a
checkout session, a mandate or a charge is **not** in it, on either path.

It is stored, and it comes back on the **read** endpoints:

| You set it on | You read it back from |
| --- | --- |
| `checkout.sessions.create` | `GET /v1/checkout/sessions/:id` |
| `rail.mandates.create` | `GET /v1/rail/mandates` |
| `rail.charges.create` | `GET /v1/rail/charges` |

So `metadata` is for your own later reference, not for routing an event. If a
value has to reach your webhook handler, it belongs in **`external_ref`** —
which is required on a checkout session and is a top-level envelope field.

Build an entitlement check on `metadata` and it will read `undefined` every
time.
:::

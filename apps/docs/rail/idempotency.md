# Idempotency

Send a unique `Idempotency-Key` per charge. A natural one — your invoice id —
beats a random one.

The key is claimed **before the mandate is read**, so two identical requests
racing each other cannot both reach it.

| | |
| --- | --- |
| Same key, same body | Replays the original response. `202`, same charge id, no second pull |
| Same key, different body | `422 idempotency_key_reused`. A new charge needs a new key |
| Same key, still in flight | `409 idempotency_key_in_flight`. Retry shortly |
| No key at all | `400 idempotency_key_required` |

## A replay is a copy, not a status check

A replay returns the response **as it was when the charge was created** —
typically `status: "pending"` with a null `tx_hash`, even if the charge has since
settled.

That is deliberate. For current state use `GET /v1/charges/:id`.

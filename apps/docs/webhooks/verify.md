# Verify & respond

**Always verify the signature** before trusting an event. It proves the request
came from Sweep and was not tampered with.

Compute an HMAC-SHA256 over the **raw request body** using your endpoint's
signing secret, and compare it to `X-Sweep-Signature`.

```js
import crypto from "crypto";
import express from "express";

const app = express();
const SECRET = process.env.SWEEP_WEBHOOK_SECRET;

// Verify against the RAW body, so capture it as a Buffer.
app.post("/webhooks/sweep", express.raw({ type: "application/json" }), (req, res) => {
  const signature = String(req.headers["x-sweep-signature"] ?? "");
  const expected =
    "sha256=" + crypto.createHmac("sha256", SECRET).update(req.body).digest("hex");

  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.status(400).send("bad signature");

  const event = JSON.parse(req.body.toString("utf8"));
  // … act on event.event_type …

  res.status(200).send("ok");   // acknowledge fast
});
```

## Three traps, all of them silent

Each produces the same "bad signature" symptom:

1. **The HMAC is over the raw bytes.** If `express.json()` has already parsed the
   body, re-serialising it gives different bytes — key order, spacing, unicode
   escapes — and nothing downstream can recover them.
2. **The header is `sha256=<hex>`, not bare hex.** Comparing the two fails
   forever, and looks exactly like a wrong secret.
3. **The comparison must be constant-time**, or it leaks the expected value a
   byte at a time to anyone willing to send enough requests.

The SDK's `sweep.webhooks.verify` handles all three.

## Responding & retries

Return any `2xx` within **10 seconds**. Do slow work — emails, provisioning —
*after* you respond, or hand it to a queue.

If you do not return `2xx`, Sweep retries with backoff: after **5 min, 30 min,
2 h, 5 h, then 10 h**.

## Make your handler idempotent

Retries reuse the same `X-Sweep-Event-Id`. Record the ones you have processed
and skip duplicates — otherwise one slow response extends the same subscriber
five times.

::: tip Why there is no short timestamp tolerance
Because deliveries retry for up to eleven hours, replaying the original payload.
The five-minute window other rails use would reject this platform's own retries.
`eventId` dedupe is the defence; the SDK exposes an opt-in `toleranceSeconds` if
you want an age check as well.
:::

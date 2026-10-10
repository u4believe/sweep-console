# What your app must have

Saving a URL in the dashboard tells us **where** to send events. It does not
create the thing that receives them — that part is yours to write. A URL has to
be served by something, and when nothing is listening we retry into the void for
eleven hours.

For a plan you made in the dashboard, this handler **is** the integration: you
call no API, poll nothing, and write no billing logic.

## Four requirements

| | |
| --- | --- |
| **1 · A route** | A public `POST` endpoint at the URL you saved. HTTPS. |
| **2 · The raw body** | Capture it as bytes (`express.raw`). The signature covers the exact bytes we sent; once `express.json` has parsed and re-serialised them they no longer match, and nothing downstream can recover them. |
| **3 · A signature check** | HMAC-SHA256 of that body with your signing secret, compared against `X-Sweep-Signature` in constant time. Skip it and anyone who learns your URL can grant themselves a subscription. |
| **4 · A fast 2xx** | Within **10 seconds**, before you do slow work. Otherwise we treat it as failed and resend. |

None of them is optional.

## The whole file

Copy it, change the two database calls, and you are done.

```js
import express from "express";
import crypto from "crypto";

const app = express();
const SECRET = process.env.SWEEP_WEBHOOK_SECRET;   // from Dashboard → Webhooks

// express.raw, NOT express.json — see requirement 2.
app.post("/webhooks/sweep", express.raw({ type: "application/json" }), async (req, res) => {
  // ── verify ───────────────────────────────────────────────────────────────
  const signature = String(req.headers["x-sweep-signature"] ?? "");
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(req.body).digest("hex");
  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.status(400).send("bad signature");

  const event = JSON.parse(req.body.toString("utf8"));

  // ── skip anything already handled ────────────────────────────────────────
  // Retries reuse the same event_id, and a retry is not an attack: we resend
  // whenever you do not answer 2xx. Without this, one slow response can extend
  // the same subscriber five times.
  if (await db.sweepEvents.exists(event.event_id)) return res.status(200).send("ok");

  // ── act ──────────────────────────────────────────────────────────────────
  const d = event.data;
  switch (event.event_type) {
    case "subscription.created":
      // Who subscribed. With a payment link you set no external_ref, so the
      // envelope carries one we generated — identify on the email, or on
      // customer_id, which is stable across every wallet this person pays from.
      await db.users.activate(d.subscriber_email, {
        plan: d.plan_id,                      // "plan_pro"
        tier: d.tier_name,                    // "Monthly"
        sweepSubscriptionId: d.subscription_id,
      });
      break;

    case "subscription.renewed":
      // Use current_period_end rather than adding a month yourself — a retry
      // may have moved it.
      await db.users.setActiveUntil(d.subscription_id, d.current_period_end);
      break;

    case "subscription.past_due":
      await email.dunning(d.subscription_id, d.reason);   // not cancelled yet
      break;

    case "subscription.cancelled":
      await db.users.revoke(d.subscription_id, d.cancel_reason);
      break;
  }

  await db.sweepEvents.record(event.event_id);
  res.status(200).send("ok");                 // requirement 4
});
```

## With the SDK

It does requirements 2 to 4 for you, and types every payload — so a mistyped
field is a compile error rather than `undefined` at three in the morning.

```ts
import Sweep from "@sweepconsole/node";
const sweep = new Sweep(process.env.SWEEP_API_KEY!);

app.post(
  "/webhooks/sweep",
  express.raw({ type: "application/json" }),
  sweep.webhooks.express(process.env.SWEEP_WEBHOOK_SECRET!, {
    "subscription.created": async (e) => {
      await db.users.activate(e.data.subscriber_email, { plan: e.data.plan_id });
    },
    "subscription.cancelled": async (e) => {
      await db.users.revoke(e.data.subscription_id, e.data.cancel_reason);
    },
    onError: (err) => log.error(err),
  })
);
```

You still write the route and the raw-body line. Everything else — the
constant-time compare, the 2xx, the dispatch — it handles.

## And if you write no code at all?

Nothing happens. Your plan still sells, the payer is still charged, and the
money still reaches your wallet — you are simply not told, and your app unlocks
nothing.

If you would rather configure than code, point the URL at Zapier, Make or n8n
and have it write to your database. Check that the tool can verify an HMAC
signature first, or you have skipped requirement 3 by another route.

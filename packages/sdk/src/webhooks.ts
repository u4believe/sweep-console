import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookSignatureError } from "./errors.js";
import type { WebhookEvent, WebhookEventType } from "./types.js";

/**
 * Webhook verification, which is where this integration goes wrong most often.
 *
 * Three traps, all of them silent, all of them producing the same "bad
 * signature" symptom:
 *
 *   1. The HMAC is over the RAW bytes. If `express.json()` has already parsed
 *      the body, re-serializing it gives different bytes — key order, spacing,
 *      unicode escapes — and nothing you do downstream can recover them.
 *   2. The header is `sha256=<hex>`, not bare hex. Comparing the two fails
 *      forever, and the failure looks exactly like a wrong secret.
 *   3. The comparison must be constant-time, or it leaks the expected value a
 *      byte at a time to anyone willing to send enough requests.
 *
 * `verify` handles all three. Give it the raw body as a Buffer or string.
 */
export function verify(rawBody: Buffer | string, signature: string | undefined, secret: string): void {
  if (!signature) {
    throw new WebhookSignatureError("No X-Sweep-Signature header on the request.");
  }

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookSignatureError(
      "Signature did not verify. Check that you are hashing the RAW request body " +
        "(express.raw, not express.json) and using this endpoint's signing secret."
    );
  }
}

/** Verify, then parse. Returns the event with Dates and camelCase fields. */
export function construct(rawBody: Buffer | string, signature: string | undefined, secret: string): WebhookEvent {
  verify(rawBody, signature, secret);
  const raw = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")) as {
    event_id: string;
    event_type: WebhookEventType;
    created_at: string;
    merchant_id: string;
    external_ref: string;
    data: Record<string, unknown>;
  };
  return {
    eventId: raw.event_id,
    eventType: raw.event_type,
    createdAt: new Date(raw.created_at),
    merchantId: raw.merchant_id,
    externalRef: raw.external_ref,
    data: raw.data,
  };
}

type Handler = (event: WebhookEvent) => void | Promise<void>;

/** Minimal shapes, so this package needs no dependency on Express's types. */
interface Req {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  send(body: string): unknown;
}

/**
 * An Express handler that verifies, routes, and acknowledges.
 *
 * Mount it with `express.raw` — the whole point is that the raw bytes survive:
 *
 *   app.post("/webhooks/sweep",
 *     express.raw({ type: "application/json" }),
 *     sweep.webhooks.express(process.env.SWEEP_WEBHOOK_SECRET!, {
 *       "charge.succeeded": (e) => db.users.extend(e.externalRef),
 *     }));
 *
 * It answers 2xx before running your handler, because Sweep gives you 10
 * seconds and retries otherwise. A handler that throws is logged, not
 * re-raised: the event was accepted, and failing the response would earn a
 * retry of something you have already recorded.
 */
export function expressHandler(
  secret: string,
  handlers: Partial<Record<WebhookEventType, Handler>> & { onError?: (e: unknown) => void }
) {
  return (req: Req, res: Res) => {
    let event: WebhookEvent;
    try {
      event = construct(req.body as Buffer, header(req, "x-sweep-signature"), secret);
    } catch (e) {
      handlers.onError?.(e);
      res.status(400).send("bad signature");
      return;
    }

    res.status(200).send("ok");

    const handler = handlers[event.eventType];
    if (!handler) return;
    void (async () => {
      try {
        await handler(event);
      } catch (e) {
        handlers.onError?.(e);
      }
    })();
  };
}

function header(req: Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

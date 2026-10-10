import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookSignatureError } from "./errors.js";
import type { WebhookEvent, WebhookEventType, TypedWebhookEvent } from "./types.js";

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

export interface ConstructOptions {
  /**
   * Reject an event whose `created_at` is older than this many seconds.
   *
   * OFF by default, and that is deliberate: deliveries here retry at 5, 30,
   * 120, 300 and 600 minutes with the original payload, so any tolerance
   * shorter than about 11 hours would reject the platform's own retries — the
   * five-minute window other rails use does not fit this delivery schedule.
   *
   * `created_at` is inside the signed body, so it cannot be edited by whoever
   * replays it. That makes this a real check if you want one; it is just not a
   * substitute for the next paragraph.
   *
   * REPLAY DEFENCE: dedupe on `eventId`. It is stable across every retry of the
   * same event, so storing the ones you have processed makes a replayed body
   * harmless however old it is, and makes your handler safe to run twice —
   * which it must be regardless, since a retry is not an attack.
   */
  toleranceSeconds?: number;
}

/** Verify, then parse. Returns the event with Dates and camelCase fields. */
export function construct(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string,
  opts: ConstructOptions = {}
): WebhookEvent {
  verify(rawBody, signature, secret);
  const raw = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")) as {
    event_id: string;
    event_type: WebhookEventType;
    created_at: string;
    merchant_id: string;
    external_ref: string;
    data: Record<string, unknown>;
  };
  checkAge(raw.created_at, opts.toleranceSeconds);
  return {
    eventId: raw.event_id,
    eventType: raw.event_type,
    createdAt: new Date(raw.created_at),
    merchantId: raw.merchant_id,
    externalRef: raw.external_ref,
    data: raw.data,
  };
}

function checkAge(createdAt: string, toleranceSeconds: number | undefined): void {
  if (toleranceSeconds === undefined) return;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) {
    throw new WebhookSignatureError(`Event created_at is not a date: ${JSON.stringify(createdAt)}`);
  }
  const ageSeconds = Math.abs(Date.now() - t) / 1000;
  if (ageSeconds > toleranceSeconds) {
    throw new WebhookSignatureError(
      `Event is ${Math.round(ageSeconds)}s old, outside the ${toleranceSeconds}s tolerance. ` +
        `Note that deliveries retry for up to 11 hours, so a short tolerance rejects genuine retries.`
    );
  }
}

/**
 * Each handler receives its own event type, so `event.data` is the payload for
 * that event rather than Record<string, unknown>. A typo in a field name is a
 * compile error now instead of undefined at 3am.
 */
type Handler<K extends WebhookEventType> = (
  event: TypedWebhookEvent<K>
) => void | Promise<void>;

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
  handlers: { [K in WebhookEventType]?: Handler<K> } & {
    onError?: (e: unknown) => void;
    /** See ConstructOptions. Off by default, for the retry schedule's sake. */
    toleranceSeconds?: number;
  }
) {
  return (req: Req, res: Res) => {
    let event: WebhookEvent;
    try {
      event = construct(req.body as Buffer, header(req, "x-sweep-signature"), secret, {
        toleranceSeconds: handlers.toleranceSeconds,
      });
    } catch (e) {
      handlers.onError?.(e);
      res.status(400).send("bad signature");
      return;
    }

    res.status(200).send("ok");

    // The one place the runtime key and the static types meet. Looking a
    // handler up by event.eventType is correct at runtime, but the union of
    // every Handler<K> has an intersection for its parameter, so TypeScript
    // reduces it to never. Erase it here rather than in the signature, where
    // it is what gives each handler its own payload type.
    const handler = handlers[event.eventType] as
      | ((e: WebhookEvent) => void | Promise<void>)
      | undefined;
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

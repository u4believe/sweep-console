/**
 * @sweepconsole/node — charge a USDC wallet from your own app.
 *
 * The whole integration is four calls:
 *
 *   import { Sweep, usdc } from "@sweepconsole/node";
 *   const sweep = new Sweep(process.env.SWEEP_API_KEY!);
 *
 *   // 1 — when a user subscribes
 *   const mandate = await sweep.mandates.create({
 *     externalRef: user.id,
 *     email: user.email,
 *     maxAmount: usdc("15.00"),          // the CEILING, not the price
 *     interval: "monthly",
 *     chains: ["base", "arbitrum", "optimism"],
 *     expiresAt: new Date("2027-01-01"),
 *   });
 *
 *   // 2 — send them to sign it
 *   res.redirect(mandate.authorizationUrl!);
 *
 *   // 3 — react to what happens (mount with express.raw)
 *   app.post("/webhooks/sweep", express.raw({ type: "application/json" }),
 *     sweep.webhooks.express(process.env.SWEEP_WEBHOOK_SECRET!, {
 *       "mandate.authorized": (e) => db.users.activate(e.externalRef),
 *       "charge.succeeded":   (e) => db.users.extend(e.externalRef),
 *     }));
 *
 *   // 4 — charge on your own clock
 *   await sweep.charges.create(
 *     { mandate: user.sweepMandate, amount: usdc("9.00"), description: "Pro — September" },
 *     { idempotencyKey: `${user.id}:2027-01` },
 *   );
 *
 * Sweep owns no schedule. Your app decides when to charge; this moves the money
 * and enforces the ceiling the payer signed.
 */

import { Sweep as SweepClient, type SweepOptions } from "./client.js";
import { construct, expressHandler, verify } from "./webhooks.js";
import type { WebhookEventType } from "./types.js";

export { usdc, format } from "./money.js";
export type { SweepOptions } from "./client.js";
export type {
  Chain, Charge, ChargeStatus, CreateChargeParams, CreateMandateParams, FailureCode,
  Interval, Mandate, MandateStatus, Usdc, WebhookEvent, WebhookEventType,
} from "./types.js";
export {
  AmountOverCap, ChargeConflict, IdempotencyKeyInFlight, IdempotencyKeyRequired,
  IdempotencyKeyReused, MandateNotActive, MandateNotFound, MandateRevoked,
  PeriodCapExceeded, RailNotEnabled, SweepError, WebhookSignatureError,
} from "./errors.js";

/// The client, with `webhooks` attached. Verification needs no API key — it is
/// a function of the raw body and your endpoint's signing secret — but hanging
/// it here means one import and one object to find it on.
export class Sweep extends SweepClient {
  readonly webhooks = {
    verify,
    construct,
    express: expressHandler,
  } as {
    verify: typeof verify;
    construct: typeof construct;
    express: (
      secret: string,
      handlers: Partial<Record<WebhookEventType, (e: ReturnType<typeof construct>) => void | Promise<void>>> & {
        onError?: (e: unknown) => void;
      }
    ) => ReturnType<typeof expressHandler>;
  };

  constructor(apiKey: string, options: SweepOptions = {}) {
    super(apiKey, options);
  }
}

export default Sweep;

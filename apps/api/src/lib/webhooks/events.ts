// The one list of webhook events, shared by the type that fireWebhook accepts,
// the schema that validates a subscription, and the picker in the portal.
//
// It used to live in three places and had drifted: the portal offered eight
// events with all eight pre-selected, the API's zod enum accepted six, so the
// default "Add endpoint" submission failed a 422 that only said "Validation
// failed". Anything added here must be an event some call site actually fires —
// a subscribable event that never arrives is a silent failure, which is worse
// than a loud one. Deliberately absent for that reason:
// subscription.trial_started and subscription.trial_ending, which the public
// API used to offer even though no call site has ever fired them, and
// payment.refunded, which the retired contract's escrow return was the only
// thing that ever produced — a charge now settles straight to the merchant's
// wallet, so the platform never holds funds it could give back. Add them here
// when something does fire them.

export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "subscription.created",
  "subscription.renewed",
  "subscription.past_due",
  "subscription.cancelled",
  "payment.succeeded",
  "payment.failed",
  "mandate.authorized",
  "mandate.revoked",
  "charge.succeeded",
  "charge.failed",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/// One line of plain English per event, shown beside the checkbox in the portal.
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventType, string> = {
  "checkout.session.completed": "A hosted checkout was paid and verified on-chain.",
  "subscription.created": "A subscriber completed checkout and billing began.",
  "subscription.renewed": "A recurring charge succeeded and the period rolled forward.",
  "subscription.past_due": "A renewal failed; the subscription is awaiting payment.",
  "subscription.cancelled": "Billing stopped — by the subscriber, by you, or by a closed plan.",
  "payment.succeeded": "USDC settled on Arc for a charge.",
  "payment.failed": "A charge could not be collected.",
  "mandate.authorized":
    "A subscriber authorized recurring payments from their wallet on the external rail.",
  "mandate.revoked":
    "A subscriber withdrew a renewal authorization in their wallet — future charges on that chain will fail.",
  "charge.succeeded": "USDC settled on Arc for a charge you requested.",
  "charge.failed": "A charge could not be collected.",
};

/// The events that only exist on the external payment rail.
///
/// Kept next to the list itself so the grouping cannot drift from it — the
/// original sin this file was written to fix was three copies of "which events
/// exist" disagreeing with each other.
export const RAIL_EVENTS = [
  "mandate.authorized",
  "mandate.revoked",
  "charge.succeeded",
  "charge.failed",
] as const satisfies readonly WebhookEventType[];

export type WebhookEventGroup = "subscriptions" | "rail";

const RAIL_EVENT_SET = new Set<string>(RAIL_EVENTS);

export function eventGroup(event: WebhookEventType): WebhookEventGroup {
  return RAIL_EVENT_SET.has(event) ? "rail" : "subscriptions";
}

/// Events this merchant could actually receive. An account without the rail can
/// never be sent a mandate or charge event, so offering them is the same silent
/// failure as listing an event no call site fires: the developer subscribes,
/// nothing arrives, and there is nothing anywhere to explain why.
export function subscribableEvents(opts: { externalRailEnabled: boolean }): WebhookEventType[] {
  return WEBHOOK_EVENTS.filter((e) => opts.externalRailEnabled || eventGroup(e) !== "rail");
}

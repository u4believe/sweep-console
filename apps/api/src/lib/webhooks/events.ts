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
// API used to offer even though no call site has ever fired them. Add them here
// when something does.

export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "subscription.created",
  "subscription.renewed",
  "subscription.past_due",
  "subscription.cancelled",
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "mandate.revoked",
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
  "payment.refunded": "Escrowed funds were returned on-chain.",
  "mandate.revoked":
    "A subscriber withdrew a renewal authorization in their wallet — future charges on that chain will fail.",
};

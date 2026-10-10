// The wire shapes, as the API actually serializes them.
//
// Field names here are camelCase while the API speaks snake_case. That is the
// one liberty this client takes with the protocol, and it is deliberate: the
// alternative is a developer writing `external_ref` in a TypeScript file where
// every other property is camelCase, getting it wrong, and finding out from a
// 422 rather than from their editor.

/** USDC in micro-units (6 decimals). Build one with `usdc()` — see money.ts. */
export type Usdc = number & { readonly __brand: "usdc-micro" };

export type Interval = "daily" | "weekly" | "monthly" | "yearly";

/** Chains a payer may authorize. `arc` is refused: it is the settlement chain. */
export type Chain = "base" | "arbitrum" | "optimism";

export type MandateStatus = "pending" | "active" | "revoked" | "expired";
export type ChargeStatus = "pending" | "succeeded" | "failed";

/** Why a charge that was accepted could not be collected. Arrives by webhook. */
export type FailureCode =
  | "insufficient_funds"
  | "mandate_period_consumed"
  | "mandate_expired"
  | "no_payout_wallet";

export interface Mandate {
  id: string;
  mode: "external";
  status: MandateStatus;
  externalRef: string;
  /** What YOU sent. Never overwritten — see `verifiedEmail`. */
  email: string | null;
  /**
   * The address the payer actually proved on the authorization page, by
   * answering a code sent to it. Null until they have.
   *
   * It need not equal `email`. Yours is prefilled for them and they may change
   * it, because an address you hold is eventually a stale one and pinning it
   * would turn that into a payer who cannot authorize at all. When the two
   * differ, this is the inbox a human answered: receipts go here, and it is
   * what links them to a Sweep customer record.
   */
  verifiedEmail: string | null;
  /** Null until the payer signs — which wallet authorizes is unknown before then. */
  walletAddress: string | null;
  maxAmount: Usdc;
  currency: "USDC";
  interval: Interval;
  periodDuration: number;
  chains: string[];
  testMode: boolean;
  /** When the authorization stops being redeemable. */
  expiresAt: Date;
  /** Where to send the payer. Null once the mandate is no longer pending. */
  authorizationUrl: string | null;
  /** The LINK's lifetime (24h), not the mandate's. Do not conflate them. */
  authorizationUrlExpiresAt: Date;
  authorizedAt: Date | null;
  revokedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface Charge {
  id: string;
  mandate: string;
  status: ChargeStatus;
  amount: Usdc;
  currency: "USDC";
  description: string | null;
  externalRef: string;
  metadata: Record<string, unknown> | null;
  testMode: boolean;
  /** The chain the funds came FROM. */
  sourceChain: string | null;
  /** Always "arc" once settled — tx_hash is the Arc mint, not a source-chain tx. */
  settlementChain: "arc" | null;
  txHash: string | null;
  failureReason: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface CreateMandateParams {
  /** YOUR id for this payer. Echoed on every webhook, so you never store ours. */
  externalRef: string;
  /**
   * Prefilled on the authorization page, and the payer may replace it. Omit and
   * they supply their own — what they prove comes back as `verifiedEmail`, and
   * receipts go there. Omitting it only costs you a receipt if they never
   * verify either.
   */
  email?: string;
  /** The ceiling per interval — NOT the price. Give it headroom. */
  maxAmount: Usdc;
  interval: Interval;
  chains: Chain[];
  expiresAt: Date;
  returnUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateChargeParams {
  /** A mandate id (`mdt_…`), or a Mandate. */
  mandate: string | Mandate;
  amount: Usdc;
  /** The ONLY text the payer sees on their receipt. Write it for them. */
  description?: string;
  metadata?: Record<string, unknown>;
}

/* ── Hosted plans ──────────────────────────────────────────────────────────── */

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "cancelled"
  | "incomplete";

/** A subscription to a plan you made in the portal (or through /v1/plans). */
export interface Subscription {
  id: string;
  /** YOUR id for this payer, if you set one when the session was created. */
  externalRef: string;
  status: SubscriptionStatus;
  /** The wallet that pays. Null before the first charge settles. */
  walletAddress: string | null;
  activationMethod: string;
  testMode: boolean;
  plan: {
    id: string;
    name: string;
    amount: Usdc;
    currency: "USDC";
    interval: Interval;
  };
  txHash: string | null;
  currentPeriodStart: Date;
  /** When the next charge is due. Billing moves this forward on each renewal. */
  currentPeriodEnd: Date;
  trialStart: Date | null;
  trialEnd: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSessionParams {
  /** A plan id (`plan_…`) from the portal, or a Plan you created. */
  plan: string;
  /**
   * YOUR id for this payer. It arrives as `external_ref` on every webhook for
   * the subscription this session creates, which is how you map it back. Pass
   * it from your own session, never from the browser.
   */
  externalRef: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, unknown>;
}

/** A hosted checkout session. Send the payer to `url`. */
export interface CheckoutSession {
  id: string;
  /** Where to send the payer. This is the whole point of the object. */
  url: string;
  status: string;
  /**
   * For the embedded checkout. Not a secret you can treat casually: it
   * authorizes completing THIS session, so it belongs in the page that is
   * checking out and nowhere else.
   */
  sessionToken?: string;
  plan: {
    name: string;
    amount: Usdc;
    currency: "USDC";
    interval: Interval;
  };
  expiresAt: Date;
}

/** A session read back after the fact. Has no `url` or token. */
export interface RetrievedSession {
  id: string;
  status: string;
  externalRef: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, unknown> | null;
  testMode: boolean;
  plan: { name: string; amount: Usdc; currency: "USDC"; interval: Interval };
  /** Set once checkout completed. */
  subscriptionId: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export type WebhookEventType =
  // Hosted plans — a plan you created in the portal, paid through Sweep's own
  // checkout or a payment link. You do not call the API for these at all; the
  // webhook is the whole integration.
  | "checkout.session.completed"
  | "subscription.created"
  | "subscription.renewed"
  | "subscription.past_due"
  | "subscription.cancelled"
  | "payment.succeeded"
  | "payment.failed"
  // The external rail — mandates you create and charge yourself.
  | "mandate.authorized"
  | "mandate.revoked"
  | "mandate.expiring"
  | "mandate.expired"
  | "charge.succeeded"
  | "charge.failed";

/**
 * What each event carries.
 *
 * These were `Record<string, unknown>` — every field a developer needed was
 * reachable only by guessing its name and casting. The names are snake_case
 * because this is the wire payload, unlike the rest of the SDK.
 */
export interface WebhookPayloads {
  "checkout.session.completed": {
    subscription_id: string;
    plan_id: string;
    amount: number;
    /** What reached your wallet, after the platform fee. */
    merchant_share: number;
    platform_fee: number;
    currency: "USDC";
  };
  /**
   * A subscriber finished checkout on a hosted plan and billing began.
   *
   * This is the one to act on for a portal-created plan. Note what identifies
   * the payer: with a payment link you did not set an `external_ref`, so the
   * envelope's is one Sweep generated. Use `subscriber_email` or the stable
   * `customer_id` — or append `?ref=<your user id>` to the link, which the
   * hosted page forwards.
   */
  "subscription.created": {
    subscription_id: string;
    plan_id: string;
    plan_name: string;
    tier_id: string;
    tier_name: string;
    amount: number;
    currency: "USDC";
    interval: Interval;
    status: string;
    activation_method: string;
    wallet_address: string;
    /** Stable across every wallet this person pays from. Null if unresolved. */
    customer_id: string | null;
    subscriber_email: string;
    tx_hash: string | null;
    allowance_tx_hash: string | null;
    block_number: number | null;
    /** Where the USDC came from. */
    chain: string;
    /** Where it settled. Always Arc. */
    settlement_chain: string;
  };
  "subscription.renewed": {
    subscription_id: string;
    plan_id: string;
    amount: number;
    currency: "USDC";
    tx_hash: string;
    chain: string;
    source_chain: string;
    /** When the next charge is due. */
    current_period_end: string;
  };
  /** A renewal failed and the subscription is awaiting payment. */
  "subscription.past_due": {
    subscription_id: string;
    plan_id: string;
    amount: number;
    currency: "USDC";
    /** Which retry this was. */
    attempt: number;
    reason: string;
  };
  "subscription.cancelled": {
    subscription_id: string;
    plan_id: string;
    cancel_reason: string;
    cancelled_at: string;
    /** Only when the payer's own cancel produced it. */
    wallet_address?: string;
    revoked_delegations?: number;
  };
  "payment.succeeded": {
    subscription_id: string;
    plan_id?: string;
    amount: number;
    /** What reached your wallet, after the platform fee. */
    merchant_share?: number;
    platform_fee?: number;
    currency: "USDC";
    /** "initial" for the first charge, "renewal" afterwards. */
    type: string;
    tx_hash: string | null;
  };
  "payment.failed": {
    subscription_id: string;
    plan_id: string;
    amount: number;
    currency: "USDC";
    type: string;
    attempt: number;
    reason: string;
  };
  "mandate.authorized": {
    mandate_id: string;
    external_ref: string;
    /** The wallet that signed. Known for the first time at this event. */
    wallet_address: string;
    max_amount: number;
    currency: "USDC";
    interval: Interval;
    /** Numeric chain ids actually signed — may be fewer than you requested. */
    chain_ids: number[];
    /** What you sent when you created it, or null. */
    email: string | null;
    /** What the payer proved. May differ from `email` — reconcile on this. */
    verified_email: string | null;
    expires_at: string;
    /**
     * This wallet already backs another live mandate at your merchant.
     *
     * Not an error, and not blocked: one person paying for two seats, or a
     * household or company wallet, is legitimate, and each payer proved their
     * own email. But the two are independent delegations with independent
     * period enforcers, so their ceilings ADD UP rather than capping each
     * other. If that is not something you allow, this is where you find out.
     */
    wallet_reused: boolean;
  };
  "mandate.revoked": {
    mandate_id: string;
    external_ref: string;
    wallet_address: string | null;
    revoked_at: string;
    /** Who ended it: your own DELETE, or the payer from their portal. */
    revoked_by: "merchant" | "payer";
    /**
     * Always false. The signed permission stays in the payer's wallet —
     * disableDelegation is onlyDeleGator, so only they can remove it. What is
     * guaranteed is that Sweep Console will not redeem it again.
     */
    on_chain: boolean;
  };
  "mandate.expiring": {
    mandate_id: string;
    external_ref: string;
    wallet_address: string | null;
    expires_at: string;
    days_remaining: number;
    recovery: string;
  };
  "mandate.expired": {
    mandate_id: string;
    external_ref: string;
    wallet_address: string | null;
    expired_at: string;
    /** You cannot extend a mandate. Only the payer can sign a new one. */
    recovery: string;
  };
  "charge.succeeded": {
    charge_id: string;
    mandate_id: string;
    external_ref: string;
    amount: number;
    currency: "USDC";
    /** Where the USDC came from. */
    source_chain: string;
    /** Where it settled. Always Arc. */
    chain: string;
    tx_hash: string;
    description: string | null;
  };
  "charge.failed": {
    charge_id: string;
    mandate_id: string;
    external_ref: string;
    amount: number;
    currency: "USDC";
    failure_code: string;
    failure_reason: string;
  };
}

export interface WebhookEvent<T = Record<string, unknown>> {
  eventId: string;
  eventType: WebhookEventType;
  createdAt: Date;
  merchantId: string;
  /** The `externalRef` you set on the mandate. Map it back to your own user. */
  externalRef: string;
  data: T;
}

/**
 * An event narrowed to one type, so `data` is the real shape.
 *
 * The handler map in `expressHandler` hands you one of these already narrowed;
 * `construct` cannot, since the type is only known after it parses.
 */
export type TypedWebhookEvent<K extends WebhookEventType = WebhookEventType> = {
  [T in K]: Omit<WebhookEvent, "eventType" | "data"> & {
    eventType: T;
    data: WebhookPayloads[T];
  };
}[K];

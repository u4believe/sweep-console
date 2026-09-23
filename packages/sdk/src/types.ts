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
  email: string | null;
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
  /** Omit and no receipt can be sent for any charge against this mandate. */
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

export type WebhookEventType =
  | "mandate.authorized"
  | "mandate.revoked"
  | "mandate.expiring"
  | "mandate.expired"
  | "charge.succeeded"
  | "charge.failed";

export interface WebhookEvent<T = Record<string, unknown>> {
  eventId: string;
  eventType: WebhookEventType;
  createdAt: Date;
  merchantId: string;
  /** The `externalRef` you set on the mandate. Map it back to your own user. */
  externalRef: string;
  data: T;
}

// One class per refusal the rail can hand back, because `catch (e)` on a rail
// that moves money should be able to ask "which of these is it" without parsing
// a string. Every one of these is a documented, expected outcome — not a bug.

export class SweepError extends Error {
  /** The API's machine-readable code, e.g. `period_cap_exceeded`. */
  readonly code: string;
  readonly status: number;
  /** Present on a 5xx. Quote it to support; it locates the failure in our logs. */
  readonly reference?: string;
  /** Per-field messages from a 422. */
  readonly details?: Record<string, string>;
  /** The id of whatever conflicted. Set on `mandate_exists`. */
  readonly mandateId?: string;
  /** Set on `mandate_exists` when the existing mandate is still pending. */
  readonly authorizationUrl?: string;

  constructor(
    message: string,
    opts: {
      code: string;
      status: number;
      reference?: string;
      details?: Record<string, string>;
      mandateId?: string;
      authorizationUrl?: string;
    }
  ) {
    super(message);
    this.name = new.target.name;
    this.code = opts.code;
    this.status = opts.status;
    this.reference = opts.reference;
    this.details = opts.details;
    this.mandateId = opts.mandateId;
    this.authorizationUrl = opts.authorizationUrl;
  }
}

/**
 * 403 — the account has not been granted the rail.
 *
 * Mainnet only: testnet has the rail open to every account, so this cannot
 * happen there. Ask in portal → Payment rail.
 */
export class RailNotEnabled extends SweepError {}

/**
 * 403 — a `test_` key reached the live API, or a `live_` key reached the
 * sandbox.
 *
 * The message names the host to use. Not retryable: it is a configuration
 * mismatch, not a transient failure, and the same key will be refused every
 * time. The client routes by key prefix, so seeing this usually means an
 * explicit `baseUrl` is pointing somewhere the key does not belong.
 */
export class WrongEnvironment extends SweepError {}

/**
 * 422 — the amount is under the mainnet minimum, 1.00 USDC by default.
 *
 * `details.amount` names the floor and what was sent. Collecting a charge
 * costs the same gas whatever its size, so under about a dollar the platform
 * fee stops covering it. Testnet has no floor.
 *
 * Catchable on purpose: an integrator can round up and retry, which is not
 * something a generic validation failure allows.
 */
export class AmountBelowMinimum extends SweepError {}

/** 404 — no mandate with that id on this account. */
export class MandateNotFound extends SweepError {}

/** 409 — the payer withdrew it. Stop charging; a new mandate needs a new signature. */
export class MandateRevoked extends SweepError {}

/** 409 — never authorized, or no longer active. */
export class MandateNotActive extends SweepError {}

/**
 * 409 — this `externalRef` already has a live mandate at your merchant.
 *
 * Two live mandates for one payer are two independent delegations with
 * independent period enforcers, so their ceilings add up and both can be
 * charged. `mandateId` names the one already standing. If it is still pending,
 * `authorizationUrl` is the link to resend — do that instead of creating a
 * second. To replace an active one, revoke it first.
 */
export class MandateExists extends SweepError {}

/** 422 — this single charge is larger than the mandate's `maxAmount`. */
export class AmountOverCap extends SweepError {}

/**
 * 422 — it fits under `maxAmount` but not under what is left this period.
 * The message names what is committed, what remains, and when the period resets.
 */
export class PeriodCapExceeded extends SweepError {}

/** 400 — no `Idempotency-Key`. The client always sends one, so this means a bug here. */
export class IdempotencyKeyRequired extends SweepError {}

/** 422 — that key was already used with a different body. A new charge needs a new key. */
export class IdempotencyKeyReused extends SweepError {}

/** 409 — a charge with this key is still in flight. Retry shortly, same key. */
export class IdempotencyKeyInFlight extends SweepError {}

/** 409 — two charges against one mandate committed at the same instant. Retry, same key. */
export class ChargeConflict extends SweepError {}

/** The signature on an incoming webhook did not verify. Do not trust the body. */
export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

const BY_CODE: Record<string, typeof SweepError> = {
  rail_not_enabled: RailNotEnabled,
  wrong_environment: WrongEnvironment,
  amount_below_minimum: AmountBelowMinimum,
  not_found: MandateNotFound,
  mandate_revoked: MandateRevoked,
  mandate_not_active: MandateNotActive,
  mandate_exists: MandateExists,
  amount_over_cap: AmountOverCap,
  period_cap_exceeded: PeriodCapExceeded,
  idempotency_key_required: IdempotencyKeyRequired,
  idempotency_key_reused: IdempotencyKeyReused,
  idempotency_key_in_flight: IdempotencyKeyInFlight,
  charge_conflict: ChargeConflict,
};

export function errorFrom(
  status: number,
  body: {
    error?: {
      message?: string;
      code?: string;
      reference?: string;
      details?: Record<string, string>;
      mandate_id?: string;
      authorization_url?: string;
    };
  } | null
): SweepError {
  const e = body?.error;
  const code = e?.code ?? "error";
  const Cls = BY_CODE[code] ?? SweepError;
  const message = e?.message ?? `Sweep API error (${status})`;
  return new Cls(message, {
    code,
    status,
    reference: e?.reference,
    details: e?.details,
    mandateId: e?.mandate_id,
    authorizationUrl: e?.authorization_url,
  });
}

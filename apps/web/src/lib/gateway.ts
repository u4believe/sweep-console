// Client for the cross-chain checkout (CCTP V2, delegation-gated).
//
// Every payment is cross-chain: Arc is settlement-only, so the subscriber grants
// ONCE — an ERC-7715 delegation per funded source chain, no fee. The platform then
// funds + activates the subscription from a granted chain, covering gas + bridge
// from the platform fee on each charge (PLATFORM_FEE_BPS). This client exposes the
// grant plan, per-chain delegation save, the activation kickoff, and status polling.

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface GrantTarget {
  chain_id: number;
  chain_key: string;
  name: string;
  token: `0x${string}`;
  period_amount: string;
  period_duration: number;
  delegate: `0x${string}`;
}

export interface GrantPlan {
  targets: GrantTarget[];
  /**
   * Chains this wallet has already authorized, counted per chain. A chain in
   * this list needs no further signature; the rest can still be granted.
   */
  granted_chain_ids: number[];
  // True only once EVERY offered chain is authorized — nothing left to grant.
  already_enabled: boolean;
}

export interface SweepStatus {
  sweep_id: string;
  status: "depositing" | "bridging" | "minting" | "complete" | "failed";
  error: string | null;
  activation_tx_hash: string | null;
  /** Chain the funds were actually pulled from ("base" | "arbitrum" | …). */
  source_chain: string | null;
  /** The subscription this activation created, once the sweep is complete. */
  subscription_id: string | null;
  redirect_url: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: { message?: string } }).error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

// ─── Public platform stats (marketing hero) ───────────────────────────────────

export interface PlatformStats {
  mrr: number;                     // monthly recurring revenue, USDC dollars
  activeSubscribers: number;
  newSubscribersThisMonth: number;
  settledThisMonth: number;        // USDC dollars settled this calendar month
}

/// Live, aggregate platform metrics across all merchants. Public + cached server-side.
export function fetchPlatformStats(): Promise<{ data: PlatformStats }> {
  return request(`/stats`);
}

// ─── Email verification (OTP) ─────────────────────────────────────────────────

/// Is this connected wallet already an OTP-verified customer of this merchant?
export function fetchWalletStatus(
  sessionId: string,
  address: string
): Promise<{ linked: boolean; verified: boolean; email_masked: string | null }> {
  return request(`/customer/wallet-status?address=${address}&session_id=${sessionId}`);
}

export interface WalletAvailability {
  /// False when this wallet already carries a live subscription with this
  /// merchant for someone else — the subscriber must connect a different one.
  available: boolean;
  owner_email_masked: string | null;
  message: string | null;
  /// USDC allowance this wallet needs to cover this plan ON TOP OF everything
  /// else it already pays for (across merchants), as a decimal string.
}

/// Pre-flight, run on wallet connect and again before the direct pay path: may
/// this subscriber pay from this wallet, and how much allowance does it need?
export function fetchWalletAvailability(
  sessionId: string,
  address: string,
  email?: string,
  emailToken?: string | null
): Promise<WalletAvailability> {
  return request(`/customer/wallet-availability`, {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      address,
      email,
      email_token: emailToken ?? undefined,
    }),
  });
}

export function requestOtp(
  sessionId: string,
  email: string,
  turnstileToken?: string
): Promise<{ sent: boolean }> {
  return request(`/customer/otp/request`, {
    method: "POST",
    body: JSON.stringify({ email, session_id: sessionId, turnstile_token: turnstileToken }),
  });
}

/// Verify a 6-digit code → a short-lived signed email proof for activation.
export function verifyOtp(email: string, code: string): Promise<{ verified: boolean; email_token: string }> {
  return request(`/customer/otp/verify`, {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
}

// ─── Manage existing subscriptions (gated on OTP proof) ───────────────────────

export interface LinkedSubscription {
  id: string;
  status: string;
  wallet_address: string;
  plan: { name: string; amount: number; interval: string; currency: string };
  current_period_end: string;
  permissions: { arc_subscription: boolean; cross_chain_grants: number };
  revocable: boolean;
}

export interface LinkedAccount {
  proven: boolean;
  email: string | null;
  wallets: { address: string; last_used_at: string }[];
  subscriptions: LinkedSubscription[];
}

/// Reveal the verified customer's on-file identity + active subscriptions. The
/// email token (OTP proof) is required — without it the server reveals nothing.
export function fetchLinkedSubscriptions(
  sessionId: string,
  email: string,
  emailToken: string
): Promise<LinkedAccount> {
  return request(`/customer/subscriptions`, {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, email, email_token: emailToken }),
  });
}

/// Revoke a prior subscription's permissions before upgrading (platform-paid gas).
export function revokeLinkedSubscription(
  sessionId: string,
  subscriptionId: string,
  email: string,
  emailToken: string
): Promise<{ id: string; status: string; revoked_delegations: number }> {
  return request(`/customer/subscriptions/${subscriptionId}/revoke`, {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, email, email_token: emailToken }),
  });
}

/// The cross-chain enable plan: which source chains to grant a delegation on, and
/// the Arc permit payload.
export function fetchGrantPlan(sessionId: string, wallet: string): Promise<GrantPlan> {
  return request<GrantPlan>(`/internal/checkout/${sessionId}/grant-plan?wallet=${wallet}`);
}

/// Persist one granted ERC-7715 delegation context (called per source chain).
export function saveDelegation(
  sessionId: string,
  body: Record<string, unknown>
): Promise<{ delegation_id: string; status: string }> {
  return request(`/internal/checkout/${sessionId}/delegation`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/// Proactive enable for an Arc-funded subscriber: confirm cross-chain renewals
/// (the delegations are saved separately). No fee, no activation — the Arc checkout
/// creates the subscription and links the grants.
export function enableCrossChain(
  sessionId: string,
  body: {
    session_token: string;
    wallet_address: string;
    email?: string;
    email_token?: string;
  }
): Promise<{ enabled: boolean }> {
  return request(`/internal/checkout/${sessionId}/cross-chain/enable`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/// Revoke cross-chain grants enabled in this checkout — the relayer will never
/// redeem the session's (not-yet-subscribed) delegations again.
///
/// Pass `chainId` to revoke a single chain, leaving the others authorized;
/// omit it to turn every chain off at once.
export function revokeGrant(
  sessionId: string,
  sessionToken: string,
  wallet: string,
  chainId?: number
): Promise<{ revoked: number; chain_id: number | null }> {
  return request(`/internal/checkout/${sessionId}/grant-revoke`, {
    method: "POST",
    body: JSON.stringify({
      session_token: sessionToken,
      wallet_address: wallet,
      ...(chainId !== undefined ? { chain_id: chainId } : {}),
    }),
  });
}

/// Fund + activate the subscription cross-chain. No subscriber fee — the platform
/// covers gas + bridge from the platform fee on each charge — and no permit or
/// contract call, because this path settles by minting to the merchant directly.
export function activateCrossChain(
  sessionId: string,
  body: {
    session_token: string;
    wallet_address: string;
    email?: string;
    email_token?: string;
  }
): Promise<{ sweep_id: string; status: string }> {
  return request(`/internal/checkout/${sessionId}/cross-chain/activate`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchSweepStatus(sessionId: string, sweepId: string): Promise<SweepStatus> {
  return request(`/checkout/${sessionId}/sweep/${sweepId}`);
}

/// Server payloads carry uint values as strings; viem's signTypedData wants
/// bigints. Hydrates the message (recursing into nested structs) using the
/// payload's own type table.
export function hydrateTypedData(payload: TypedDataPayload): TypedDataPayload {
  function hydrate(typeName: string, message: Record<string, unknown>): Record<string, unknown> {
    const fields = payload.types[typeName] ?? [];
    const out: Record<string, unknown> = { ...message };
    for (const field of fields) {
      const value = out[field.name];
      if (value === undefined) continue;
      if (/^u?int\d*$/.test(field.type) && typeof value === "string") {
        out[field.name] = BigInt(value);
      } else if (payload.types[field.type] && typeof value === "object" && value !== null) {
        out[field.name] = hydrate(field.type, value as Record<string, unknown>);
      }
    }
    return out;
  }
  return { ...payload, message: hydrate(payload.primaryType, payload.message) };
}

// ─── Standalone customer portal (/manage) ─────────────────────────────────────
// Cross-merchant, email+OTP gated. Reuses verifyOtp() (returns the email_token);
// these are the session-less portal endpoints (see api routes/customer-portal.ts).

export interface PortalSubscription {
  id: string;
  merchant: { name: string };
  status: string;
  wallet_address: string;
  plan: { name: string; amount: number; interval: string; currency: string };
  current_period_end: string;
  trial_end: string | null;
  escrow_refundable: boolean;
  refundable_until: string | null;
  refundable_amount: number;
  permissions: { arc_subscription: boolean; cross_chain_grants: number };
  /// One row per authorized chain, so the portal can offer per-chain control.
  /// Status is the stored one, kept current by the nightly reconciliation pass.
  grants: PortalGrant[];
  cross_chain_enabled: boolean;
  revocable: boolean;
}

export interface PortalGrant {
  mandate_id: string | null;
  chain_id: number;
  chain: string;
  period_amount: number;
  expires_at: string;
}

/// OTP request for the portal (no checkout session — generic branding server-side).
export function portalRequestOtp(email: string, turnstileToken?: string): Promise<{ sent: boolean }> {
  return request(`/customer/otp/request`, {
    method: "POST",
    body: JSON.stringify({ email, turnstile_token: turnstileToken }),
  });
}

export function portalListSubscriptions(
  email: string,
  emailToken: string
): Promise<{ proven: boolean; email?: string; subscriptions: PortalSubscription[] }> {
  return request(`/customer/portal/subscriptions`, {
    method: "POST",
    body: JSON.stringify({ email, email_token: emailToken }),
  });
}

export function portalCancelSubscription(
  email: string,
  emailToken: string,
  subscriptionId: string
): Promise<{ id: string; status: string; revoked_delegations: number }> {
  return request(`/customer/portal/subscriptions/${subscriptionId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ email, email_token: emailToken }),
  });
}

export function portalGrantPlan(
  email: string,
  emailToken: string,
  subscriptionId: string,
  wallet: string
): Promise<{ targets: GrantTarget[]; granted_chain_ids: number[]; already_enabled: boolean }> {
  return request(`/customer/portal/subscriptions/${subscriptionId}/grant-plan`, {
    method: "POST",
    body: JSON.stringify({ email, email_token: emailToken, wallet }),
  });
}

export function portalSaveGrant(
  email: string,
  emailToken: string,
  subscriptionId: string,
  body: Record<string, unknown>
): Promise<{ delegation_id: string; status: string }> {
  return request(`/customer/portal/subscriptions/${subscriptionId}/grant`, {
    method: "POST",
    body: JSON.stringify({ email, email_token: emailToken, ...body }),
  });
}

/// Omit `chainId` to turn off every chain at once.
export function portalRevokeGrant(
  email: string,
  emailToken: string,
  subscriptionId: string,
  chainId?: number
): Promise<{ revoked: number }> {
  return request(`/customer/portal/subscriptions/${subscriptionId}/grant-revoke`, {
    method: "POST",
    body: JSON.stringify({ email, email_token: emailToken, chain_id: chainId }),
  });
}

export interface WalletBalances {
  address: string;
  arc_balance: string;
  total: string;
  chains: { chain: string; name: string; domain: number; wallet_balance: string }[];
}

/** USDC the wallet holds on Arc and on every supported source chain. */
export function fetchWalletBalances(address: string): Promise<WalletBalances> {
  return request<WalletBalances>(`/v1/wallet/balances?address=${address}`);
}

/**
 * Renewal grants bound to a SUBSCRIPTION rather than a checkout session — used
 * on the confirmation page, where the session is already spent.
 */
/// Either proof the grant routes accept: an OTP-proven email, or the token of
/// the checkout session that created this subscription. See the note on
/// sessionProofSchema in routes/customer-portal.ts.
export type GrantProof =
  | { email: string; email_token: string }
  | { session_id: string; session_token: string };

export function fetchSubscriptionGrantPlan(
  subscriptionId: string,
  proof: GrantProof & { wallet?: string }
): Promise<{ targets: GrantTarget[] }> {
  return request(`/customer/portal/subscriptions/${subscriptionId}/grant-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  });
}

export function saveSubscriptionDelegation(
  subscriptionId: string,
  body: Record<string, unknown>
): Promise<{ delegation_id: string; status: string }> {
  return request(`/customer/portal/subscriptions/${subscriptionId}/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── External rail: the mandate authorization page ────────────────────────────
//
// Unauthenticated, like checkout: the mandate id in the URL is the credential and
// session_token guards the writes. The subscriber has no Sweep account.

export interface AuthorizationView {
  id: string;
  /** "pending" | "active" | "revoked" | "expired" */
  status: string;
  merchant_name: string;
  email: string | null;
  /** USDC micro-units — the ceiling per period, not a charge. */
  max_amount: number;
  currency: string;
  interval: string;
  period_duration: number;
  /** When the authorization itself stops being usable. */
  expires_at: string;
  /** When THIS LINK dies — much sooner, and a different thing. */
  link_expires_at: string;
  link_expired: boolean;
  wallet_address: string | null;
  return_url: string | null;
  session_token: string;
  targets: GrantTarget[];
  granted_chain_ids: number[];
}

export function getAuthorization(mandateId: string): Promise<AuthorizationView> {
  return request(`/authorize/${mandateId}`);
}

export function saveAuthorizationGrant(
  mandateId: string,
  body: Record<string, unknown>
): Promise<{ grant_id: string; chain_id: number; status: string }> {
  return request(`/authorize/${mandateId}/grant`, { method: "POST", body: JSON.stringify(body) });
}

export function completeAuthorization(
  mandateId: string,
  sessionToken: string,
  walletAddress: string
): Promise<{ id: string; status: string; chain_ids: number[] }> {
  return request(`/authorize/${mandateId}/complete`, {
    method: "POST",
    body: JSON.stringify({ session_token: sessionToken, wallet_address: walletAddress }),
  });
}

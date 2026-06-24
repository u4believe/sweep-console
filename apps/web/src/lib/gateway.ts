// Client for the cross-chain checkout (CCTP V2, delegation-gated).
//
// Arc is primary. When Arc is short, the subscriber enables cross-chain ONCE:
// a one-time setup fee (ERC-3009) + an ERC-7715 delegation per funded source chain
// + an Arc permit. The platform then funds + activates the subscription from a
// source chain. This client exposes the grant plan, per-chain delegation save, the
// activation kickoff, and status polling.

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
  // True once the session already has active grants — skip the fee + re-granting.
  already_enabled: boolean;
  setup_fee: string;
  fee_chain: string | null;
  fee_payload: TypedDataPayload | null;
  permit_payload: TypedDataPayload;
  permit_value: string;
  permit_deadline: string;
}

export interface SweepStatus {
  sweep_id: string;
  status: "depositing" | "bridging" | "minting" | "complete" | "failed";
  error: string | null;
  activation_tx_hash: string | null;
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
): Promise<{
  id: string;
  status: string;
  revoked_delegations: number;
  on_chain_cancelled: boolean;
  refunded_escrow: number;
}> {
  return request(`/customer/subscriptions/${subscriptionId}/revoke`, {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, email, email_token: emailToken }),
  });
}

/// The cross-chain enable plan: which source chains to grant a delegation on, the
/// one-time setup-fee payload, and the Arc permit payload.
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

/// Proactive enable for an Arc-funded subscriber: collect the one-time setup fee
/// (the delegations are saved separately). No activation — the Arc checkout does that.
export function enableCrossChain(
  sessionId: string,
  body: {
    session_token: string;
    wallet_address: string;
    email?: string;
    email_token?: string;
    fee_chain: string;
    fee_payload: TypedDataPayload;
    fee_signature: string;
  }
): Promise<{ enabled: boolean; fee_tx_hash: string }> {
  return request(`/internal/checkout/${sessionId}/cross-chain/enable`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/// Revoke the cross-chain grant enabled in this checkout — the relayer will never
/// redeem the session's (not-yet-subscribed) delegations again.
export function revokeGrant(
  sessionId: string,
  sessionToken: string,
  wallet: string
): Promise<{ revoked: number }> {
  return request(`/internal/checkout/${sessionId}/grant-revoke`, {
    method: "POST",
    body: JSON.stringify({ session_token: sessionToken, wallet_address: wallet }),
  });
}

/// Fund + activate the subscription cross-chain. The fee fields are sent only on a
/// fresh enable; when cross-chain is already enabled they're omitted (no re-charge).
export function activateCrossChain(
  sessionId: string,
  body: {
    session_token: string;
    wallet_address: string;
    email?: string;
    email_token?: string;
    fee_chain?: string;
    fee_payload?: TypedDataPayload;
    fee_signature?: string;
    permit_signature: string;
    permit_value: string;
    permit_deadline: string;
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

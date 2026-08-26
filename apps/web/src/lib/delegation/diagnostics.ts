// Diagnostics for the cross-chain ERC-7715 grant loop.
//
// Why this exists: the grant loop makes one wallet_requestExecutionPermissions
// call per source chain, and a failure on the 2nd+ chain surfaces to the user as
// a generic "Request cancelled". That string is ambiguous — a genuine user
// rejection (EIP-1193 code 4001), a request superseded by the wallet, and an
// internal SDK abort all read the same. These helpers dump the *raw* shape of the
// failure plus the wallet's active chain at that moment, which is what
// distinguishes "the user clicked reject" from "the wallet killed our request
// because the active chain moved out from under us".
//
// Everything here is observation only: nothing changes control flow, so the
// behaviour being diagnosed is not perturbed by measuring it.

import { type Client } from "viem";

export interface GrantAttemptContext {
  /** 1-based position in the loop. */
  index: number;
  total: number;
  /** Chain the permission is being requested FOR (not necessarily the active one). */
  targetChainId: number;
  chainName?: string;
}

/// The wallet's currently-selected chain, read straight from the provider rather
/// than from wagmi state — wagmi's copy can lag a switch the wallet made itself.
/// Returns null if the provider won't answer (never throws; this is diagnostic).
export async function readActiveChainId(client: Client): Promise<number | null> {
  try {
    const hex = (await client.request({ method: "eth_chainId" } as never)) as unknown;
    return typeof hex === "string" ? Number.parseInt(hex, 16) : null;
  } catch {
    return null;
  }
}

interface ErrorLayer {
  depth: number;
  name?: string;
  message?: string;
  code?: unknown;
  data?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  metaMessages?: unknown;
}

/// Unwrap the `cause` chain. The interesting field (an EIP-1193 `code`) is
/// usually several layers below whatever `e.message` says at the top.
export function unwrapError(e: unknown): ErrorLayer[] {
  const layers: ErrorLayer[] = [];
  let current: unknown = e;
  let depth = 0;
  while (current && depth < 8) {
    const c = current as Record<string, unknown>;
    layers.push({
      depth,
      name: typeof c.name === "string" ? c.name : undefined,
      message: typeof c.message === "string" ? c.message : String(current),
      code: c.code,
      data: c.data,
      shortMessage: c.shortMessage,
      details: c.details,
      metaMessages: c.metaMessages,
    });
    current = c.cause;
    depth++;
  }
  return layers;
}

/// EIP-1193 4001 is the ONLY code that means "the human pressed reject". Anything
/// else that merely reads like a cancellation is the wallet or SDK aborting.
export function isUserRejection(e: unknown): boolean {
  return unwrapError(e).some((l) => l.code === 4001 || l.code === "ACTION_REJECTED");
}

/// -32002 = "request already pending" — the signature of a superseded request,
/// which is what we expect if the wallet is queueing/killing our 2nd+ grant.
export function isRequestSuperseded(e: unknown): boolean {
  return unwrapError(e).some((l) => l.code === -32002);
}

export function logGrantAttempt(ctx: GrantAttemptContext, activeChainId: number | null): void {
  console.info(
    `[grant] ${ctx.index}/${ctx.total} requesting permission for chain ${ctx.targetChainId}` +
      `${ctx.chainName ? ` (${ctx.chainName})` : ""} — wallet active chain: ${activeChainId ?? "unknown"}` +
      `${activeChainId !== null && activeChainId !== ctx.targetChainId ? " ⚠️ MISMATCH" : ""}`
  );
}

export function logGrantSuccess(ctx: GrantAttemptContext, activeChainId: number | null): void {
  console.info(
    `[grant] ${ctx.index}/${ctx.total} granted for chain ${ctx.targetChainId} — ` +
      `wallet active chain now: ${activeChainId ?? "unknown"}`
  );
}

/// Full dump for a failed grant. Read the `layers` table first: the row with a
/// numeric `code` is the wallet's actual verdict.
export function logGrantFailure(
  ctx: GrantAttemptContext,
  e: unknown,
  activeChainIdAtFailure: number | null
): void {
  const layers = unwrapError(e);
  const verdict = isUserRejection(e)
    ? "USER REJECTED (4001) — the human pressed reject"
    : isRequestSuperseded(e)
      ? "REQUEST SUPERSEDED (-32002) — wallet had another request pending"
      : "NOT a user rejection — wallet/SDK aborted for another reason";

  console.group(
    `%c[grant] FAILED ${ctx.index}/${ctx.total} for chain ${ctx.targetChainId}`,
    "color:#dc2626;font-weight:bold"
  );
  console.error("verdict:", verdict);
  console.error("target chain:", ctx.targetChainId, ctx.chainName ?? "");
  console.error("wallet active chain at failure:", activeChainIdAtFailure ?? "unknown");
  if (activeChainIdAtFailure !== null && activeChainIdAtFailure !== ctx.targetChainId) {
    console.error(
      "⚠️ active chain != target chain — if this changed mid-loop, the connector client is stale"
    );
  }
  console.table(layers);
  console.error("raw error object:", e);
  console.groupEnd();
}

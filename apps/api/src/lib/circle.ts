// Normalize the base URL: a bare host like "api-sandbox.circle.com" makes fetch
// throw "Failed to parse URL", so ensure a scheme and strip any trailing slash.
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
import { isMainnet } from "./gateway/chains";
import { supportedSourceChains } from "./gateway/chains";
import { directSettlementEnabled } from "./chain/direct-settlement";

const BASE = normalizeBaseUrl(process.env.CIRCLE_BASE_URL ?? "https://api.circle.com");

/**
 * The chain a creator's Circle wallet is registered on.
 *
 * THE DEFAULT FOLLOWS THE NETWORK. It used to be ETH-SEPOLIA unconditionally
 * — a sandbox placeholder from before Circle supported Arc — which meant a
 * mainnet deployment that had not set CIRCLE_BLOCKCHAIN registered its
 * creators' payout wallets on a TESTNET chain.
 *
 * That does not fail at creation. A Circle EOA gets one EVM address, so
 * mainnet USDC still arrives at it and the on-chain balance is real. What
 * breaks is everything that asks CIRCLE: /balances reports the registered
 * chain only, so the wallet reads empty, the dashboard shows nothing, and the
 * withdraw route refuses with "No USDC balance found in your wallet" over
 * money that is demonstrably there. The same shape as the CCTP TokenMessenger
 * default: wrong in a way that succeeds.
 *
 * Arc is the settlement chain either way, so the only question is which Arc.
 */
const CIRCLE_BLOCKCHAIN = process.env.CIRCLE_BLOCKCHAIN ?? (isMainnet() ? "ARC" : "ARC-TESTNET");

function authHeaders(userToken?: string): Record<string, string> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("CIRCLE_API_KEY is not set");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (userToken) headers["X-User-Token"] = userToken;
  return headers;
}

// Circle replies carry bearer credentials in the body: `userToken` authenticates
// every subsequent wallet call for that merchant, and `encryptionKey` unlocks
// the wallet's entropy in the client SDK. Logging a response verbatim — which
// this did — puts both in the host's log stream, where anyone with log access
// can lift them and act as the merchant's wallet. Log the shape, never the
// secret.
const SECRET_KEYS = new Set(["usertoken", "encryptionkey", "apikey", "token", "secret", "privatekey"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        SECRET_KEYS.has(k.toLowerCase()) ? [k, "[redacted]"] : [k, redact(v)]
      )
    );
  }
  return value;
}

function safeBody(json: unknown): string {
  return JSON.stringify(redact(json)).slice(0, 300);
}

async function circlePost<T>(path: string, body: unknown, userToken?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(userToken),
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`[circle] POST ${path} → ${res.status}`, safeBody(json));
  if (!res.ok) {
    throw new Error(`Circle API error (${res.status}): ${(json as { message?: string }).message ?? safeBody(json)}`);
  }
  return (json as { data: T }).data;
}

async function circleGet<T>(path: string, userToken?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(userToken) });
  const json = await res.json();
  console.log(`[circle] GET ${path} → ${res.status}`, safeBody(json));
  if (!res.ok) {
    throw new Error(`Circle API error (${res.status}): ${(json as { message?: string }).message ?? safeBody(json)}`);
  }
  return (json as { data: T }).data;
}

/**
 * The Circle userId for a merchant, namespaced by environment.
 *
 * Circle's userId namespace is SHARED ACROSS ENTITIES, and our database is
 * shared across deployments, so the merchant's dbId is claimed by whichever
 * environment reached Circle first. Measured against the live entity on
 * 2026-10-19: a brand-new id created and minted a token fine, while the
 * merchant's dbId answered 409 "Existing user already created" to a create
 * and 404 "Cannot find the userId" to everything else — with zero users in
 * that entity. It had been claimed by the test entity in June.
 *
 * Unprefixed on testnet so every wallet created before this keeps working:
 * those users are registered under the bare dbId and renaming them is not
 * possible. Live gets the prefix because it has no users yet.
 *
 * Without this no merchant could ever create a live payout wallet, because
 * every merchant's dbId is already spoken for by their test wallet.
 */
export function circleUserId(merchantDbId: string): string {
  return isMainnet() ? `live_${merchantDbId}` : merchantDbId;
}

export async function createCircleUser(userId: string): Promise<void> {
  await circlePost("/v1/w3s/users", { userId: circleUserId(userId) });
}

export async function getCircleUserToken(
  userId: string
): Promise<{ userToken: string; encryptionKey: string }> {
  return circlePost<{ userToken: string; encryptionKey: string }>(
    "/v1/w3s/users/token",
    { userId: circleUserId(userId) }
  );
}

export async function createCircleWalletChallenge(
  userToken: string
): Promise<{ challengeId: string }> {
  const { randomUUID } = await import("crypto");
  // /initialize creates the PIN challenge + wallet in one step (first-time setup only)
  // EOA = standard Externally Owned Account; SCA requires special Circle feature flag
  return circlePost<{ challengeId: string }>(
    "/v1/w3s/user/initialize",
    { idempotencyKey: randomUUID(), blockchains: circleBlockchains(), accountType: "EOA" },
    userToken
  );
}

// For users already initialized (have a PIN): create an additional wallet via challenge
export async function createCircleWalletForExistingUser(
  userToken: string
): Promise<{ challengeId: string }> {
  const { randomUUID } = await import("crypto");
  return circlePost<{ challengeId: string }>(
    "/v1/w3s/user/wallets",
    {
      idempotencyKey: randomUUID(),
      blockchains: circleBlockchains(),
      // One wallet PER BLOCKCHAIN named, not one wallet in total — Circle
      // returns a record per chain, all sharing the EOA's single address.
      accountType: "EOA",
      count: 1,
    },
    userToken
  );
}

export interface CircleWallet {
  id: string;
  address: string;
  blockchain: string;
  state: string;
}

export async function getCircleWallets(userToken: string): Promise<CircleWallet[]> {
  const data = await circleGet<{ wallets: CircleWallet[] }>("/v1/w3s/user/wallets", userToken);
  return data.wallets ?? [];
}

export interface ChallengeResult {
  challenge: {
    id: string;
    type: string;
    status: string;
    correlationIds: string[];
  };
}

export async function getCircleChallengeStatus(
  userToken: string,
  challengeId: string
): Promise<ChallengeResult> {
  return circleGet<ChallengeResult>(
    `/v1/w3s/user/challenges/${challengeId}`,
    userToken
  );
}

// Fetch a single wallet by ID using platform auth (no user token needed).
// Use this when GET /v1/w3s/user/wallets returns 404 despite a completed challenge.
export async function getCircleWalletById(walletId: string): Promise<CircleWallet | null> {
  try {
    const data = await circleGet<{ wallet: CircleWallet }>(`/v1/w3s/wallets/${walletId}`);
    return data.wallet ?? null;
  } catch {
    return null;
  }
}

export interface TokenBalance {
  token: { id: string; name: string; symbol: string; blockchain: string; decimals: number };
  amount: string;
  updateDate: string;
}

/**
 * A balance read that can fail, said out loud.
 *
 * This returned `TokenBalance[]` and caught everything into `[]`. A missing
 * API key, an expired user token, a 404, a network timeout and a genuinely
 * empty wallet were then indistinguishable — and the callers all read an
 * empty array as "zero USDC".
 *
 * That cost real time on 2026-10-18: a wallet holding 150 USDC on ARC-TESTNET
 * showed empty, because the request reached a deployment whose Circle
 * credentials were for the other environment. Nothing anywhere said so.
 *
 * Worse than the display, portal.ts then WROTE that zero to
 * Merchant.usdcBalance and stamped balanceUpdatedAt fresh, so a transient
 * failure became cached truth and later reads served it from the cache
 * without asking Circle again.
 */
export type BalanceRead =
  | { ok: true; balances: TokenBalance[] }
  | { ok: false; reason: string };

export async function getCircleWalletBalances(walletId: string): Promise<BalanceRead> {
  try {
    const data = await circleGet<{ tokenBalances: TokenBalance[] }>(`/v1/w3s/wallets/${walletId}/balances`);
    return { ok: true, balances: data.tokenBalances ?? [] };
  } catch (e) {
    // The message, not the error: circleGet already redacts credentials out of
    // Circle's replies, and this string reaches logs and sometimes a merchant.
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// Fetch the ECDSA public key for a given Circle key ID.
// The key is base64-encoded DER (SPKI format); cache it — it never changes per ID.
export async function getWebhookPublicKey(keyId: string): Promise<string> {
  const data = await circleGet<{ publicKey: string; algorithm: string }>(
    `/v2/notifications/publicKey/${keyId}`
  );
  return data.publicKey; // base64-encoded DER
}

export async function registerWebhookSubscription(webhookUrl: string): Promise<{ id: string; endpoint: string }> {
  return circlePost<{ id: string; endpoint: string }>("/v2/notifications/subscriptions", {
    endpoint: webhookUrl,
    notificationTypes: ["transactions.inbound", "transactions.outbound"],
  });
}

export async function createCircleTransferChallenge(
  userToken: string,
  walletId: string,
  tokenId: string,
  destinationAddress: string,
  amount: string
): Promise<{ challengeId: string }> {
  const { randomUUID } = await import("crypto");
  return circlePost<{ challengeId: string }>(
    "/v1/w3s/user/transactions/transfer",
    {
      idempotencyKey: randomUUID(),
      walletId,
      tokenId,
      destinationAddress,
      amounts: [amount],
      // Circle's transfer endpoint takes `feeLevel` as a top-level field (dynamic
      // gas estimation). Without it, Circle demands explicit gasPrice/gasLimit and
      // rejects the request — that's the "API parameter invalid" on withdrawal.
      feeLevel: "MEDIUM",
    },
    userToken
  );
}

/** The chain this deployment registers wallets on and expects balances from. */
export function circleBlockchain(): string {
  return CIRCLE_BLOCKCHAIN;
}

/**
 * Every chain a creator's wallet must be registered on.
 *
 * Under direct settlement a creator is paid on whichever chain their
 * subscriber holds USDC on, so a payout wallet has to be legible on all of
 * them. Derived from supportedSourceChains() rather than listed again here —
 * adding Monad to that table is what put Monad in this list, and a second
 * list would be a second thing to forget.
 *
 * Arc is deliberately absent: nothing settles there any more, and
 * registering a chain Circle must then be asked about on every balance read
 * costs a round trip for an answer that is always zero.
 *
 * With the flag off this stays the single configured chain, so a rollback
 * registers wallets exactly as before.
 */
export function circleBlockchains(): string[] {
  if (!directSettlementEnabled()) return [CIRCLE_BLOCKCHAIN];
  const codes = supportedSourceChains().map((c) => c.circle);
  // Never return an empty list: Circle rejects it, and a deployment with no
  // configured source chains has bigger problems than a wallet's registration.
  return codes.length > 0 ? codes : [CIRCLE_BLOCKCHAIN];
}

/**
 * The USDC balance on the chain this deployment settles to.
 *
 * Matching on symbol alone is wrong in both directions. A wallet registered
 * on the other network reports USDC that cannot be spent here, and selecting
 * it sends a withdrawal out on the wrong chain. A wallet registered correctly
 * but holding nothing reports no entry at all, which reads the same as "we
 * looked on the wrong chain" unless the two are told apart.
 *
 * So this returns which of those happened, and the caller can say something
 * true. `elsewhere` is the diagnostic that matters: it means the money is
 * real and Circle is looking at a different chain, which is a configuration
 * problem and not an empty wallet.
 */
export function usdcOnSettlementChain(balances: TokenBalance[]):
  | { found: TokenBalance }
  | { found: null; elsewhere: TokenBalance[] } {
  const want = circleBlockchains().map((c) => c.toUpperCase());
  const usdc = balances.filter((b) => b.token.symbol === "USDC");
  const here = usdc.find((b) => want.includes((b.token.blockchain ?? "").toUpperCase()));
  if (here) return { found: here };
  return { found: null, elsewhere: usdc };
}

/**
 * USDC per chain, for a creator paid on whichever chain each subscriber used.
 *
 * The single-chain read above answers "can this wallet be withdrawn from
 * here", which was the only question while everything settled on Arc. It is
 * the wrong question now: a creator with 40 USDC on Base and 12 on Arbitrum
 * has two balances and two withdrawals, and a function returning the first
 * match would show 40 and silently hide the rest.
 *
 * `elsewhere` keeps its old meaning — USDC on a chain this deployment does
 * not settle on — because that still diagnoses a misregistered wallet, which
 * is the failure that reads as an empty wallet over money that is there.
 */
export function usdcByChain(balances: TokenBalance[]): {
  perChain: { blockchain: string; balance: TokenBalance }[];
  total: bigint;
  elsewhere: TokenBalance[];
} {
  const want = new Set(circleBlockchains().map((c) => c.toUpperCase()));
  const usdc = balances.filter((b) => b.token.symbol === "USDC");
  const perChain: { blockchain: string; balance: TokenBalance }[] = [];
  const elsewhere: TokenBalance[] = [];
  for (const b of usdc) {
    const code = (b.token.blockchain ?? "").toUpperCase();
    if (want.has(code)) perChain.push({ blockchain: code, balance: b });
    else elsewhere.push(b);
  }
  // Circle reports amounts as decimal strings; USDC is 6dp on every chain we
  // settle on, so parse rather than trust a float.
  const total = perChain.reduce((sum, p) => sum + parseUsdc(p.balance.amount), 0n);
  return { perChain, total, elsewhere };
}

/**
 * Every chain this creator's Circle wallet is registered on, and what is on it.
 *
 * NO SCHEMA CHANGE, AND THAT IS THE POINT. A merchant row stores one
 * circleWalletId, which was right when one chain mattered. Circle returns one
 * wallet record PER CHAIN — same EOA address, different id — and a user token
 * is mintable from the merchant's id alone, with no merchant session. So the
 * per-chain ids are derivable on demand rather than something to store,
 * migrate and keep in step with Circle.
 *
 * `missing` is what step 6 of the migration acts on: chains this deployment
 * settles on that the wallet is NOT registered for. Those read as zero while
 * holding real USDC, because a Circle EOA has one address and money arrives
 * whatever is registered — see circleBlockchains().
 */
export async function readCreatorWalletChains(merchantDbId: string): Promise<
  | {
      ok: true;
      address: string | null;
      chains: { blockchain: string; walletId: string; usdc: bigint; read: boolean }[];
      missing: string[];
      total: bigint;
    }
  | { ok: false; reason: string }
> {
  let wallets: CircleWallet[];
  try {
    const { userToken } = await getCircleUserToken(merchantDbId);
    wallets = await getCircleWallets(userToken);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  const want = circleBlockchains().map((c) => c.toUpperCase());
  const byCode = new Map(wallets.map((w) => [(w.blockchain ?? "").toUpperCase(), w]));

  const chains: { blockchain: string; walletId: string; usdc: bigint; read: boolean }[] = [];
  let total = 0n;
  for (const code of want) {
    const w = byCode.get(code);
    if (!w) continue;
    const read = await getCircleWalletBalances(w.id);
    if (!read.ok) {
      // A failed read is not a zero balance — the same distinction the portal
      // already draws. Report it unread rather than reporting zero.
      chains.push({ blockchain: code, walletId: w.id, usdc: 0n, read: false });
      continue;
    }
    const usdc = read.balances
      .filter((b) => b.token.symbol === "USDC")
      .reduce((sum, b) => sum + parseUsdc(b.amount), 0n);
    chains.push({ blockchain: code, walletId: w.id, usdc, read: true });
    total += usdc;
  }

  return {
    ok: true,
    address: wallets[0]?.address ?? null,
    chains,
    missing: want.filter((c) => !byCode.has(c)),
    total,
  };
}

/** Circle's decimal string -> USDC micro-units, without floating point. */
export function parseUsdc(amount: string): bigint {
  const [whole = "0", frac = ""] = String(amount).trim().split(".");
  const micros = (frac + "000000").slice(0, 6);
  const sign = whole.startsWith("-") ? -1n : 1n;
  return sign * (BigInt(whole.replace("-", "") || "0") * 1_000_000n + BigInt(micros || "0"));
}

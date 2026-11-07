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
/** The id a merchant's Circle user has by default, with no ref stored. */
export function circleUserId(merchantDbId: string): string {
  return isMainnet() ? `live_${merchantDbId}` : merchantDbId;
}

/**
 * The id for a merchant who is being moved to a different account type.
 *
 * Circle fixes accountType AT INITIALIZATION, so an EOA-initialized user can
 * never hold an SCA wallet — /user/wallets takes the challenge, takes the PIN
 * and creates nothing. A merchant who needs SCA therefore needs a NEW Circle
 * user, and a new user needs an id that is not the one already initialized.
 */
export function circleUserIdForType(merchantDbId: string, type: "EOA" | "SCA"): string {
  const base = circleUserId(merchantDbId);
  return type === "SCA" ? `${base}_sca` : base;
}

/**
 * Which Circle user this merchant's wallets actually live under.
 *
 * The STORED ref wins, and null means the derived default — so every merchant
 * provisioned before account types mattered keeps resolving to the user that
 * already holds their wallets. Nothing moves because a global default changed.
 */
export async function resolveCircleUserId(merchantDbId: string): Promise<string> {
  const { prisma } = await import("./prisma");
  const m = await prisma.merchant.findUnique({
    where: { id: merchantDbId },
    select: { circleUserRef: true, liveCircleUserRef: true },
  });
  const ref = isMainnet() ? m?.liveCircleUserRef : m?.circleUserRef;
  return ref ?? circleUserId(merchantDbId);
}

/**
 * Create the Circle user, optionally under an explicit id.
 *
 * `userRef` is passed when provisioning a NEW user for a different account
 * type; omitted it creates the merchant's default one.
 */
export async function createCircleUser(userId: string, userRef?: string): Promise<void> {
  await circlePost("/v1/w3s/users", { userId: userRef ?? (await resolveCircleUserId(userId)) });
}

export async function getCircleUserToken(
  userId: string
): Promise<{ userToken: string; encryptionKey: string }> {
  return circlePost<{ userToken: string; encryptionKey: string }>(
    "/v1/w3s/users/token",
    { userId: await resolveCircleUserId(userId) }
  );
}

/**
 * EOA or SCA for a creator's payout wallet.
 *
 * SCA, BECAUSE GAS STATION REQUIRES IT. Circle's docs are explicit: "On EVM
 * chains, the Programmable Wallet must be an ERC-4337-compliant smart
 * contract account." An EOA creator cannot have their withdrawal gas
 * sponsored, and under direct settlement a creator is paid on four chains and
 * would otherwise need native token on each to move their own money.
 *
 * AN SCA IS A DIFFERENT ADDRESS FROM AN EOA, which is why this is a decision
 * and not a detail. The payout address is pinned into every subscriber's
 * grant, so a creator who switches needs every subscriber to re-authorize.
 * It therefore has to be settled BEFORE step 9 of the migration, not after.
 *
 * The old comment here said SCA "requires special Circle feature flag". That
 * may still be true of a given Circle account even though the supported-chains
 * table now lists SCA for user-controlled wallets on every chain we settle on
 * (Base, Arbitrum, Optimism, Monad and Arc). Overridable for exactly that
 * reason: if Circle refuses SCA for this account, CIRCLE_ACCOUNT_TYPE=EOA
 * restores the old behaviour without a release.
 */
export function creatorAccountType(): "EOA" | "SCA" {
  return process.env.CIRCLE_ACCOUNT_TYPE?.trim().toUpperCase() === "EOA" ? "EOA" : "SCA";
}

export async function createCircleWalletChallenge(
  userToken: string
): Promise<{ challengeId: string }> {
  const { randomUUID } = await import("crypto");
  // /initialize creates the PIN challenge + wallet in one step (first-time setup only)
  return circlePost<{ challengeId: string }>(
    "/v1/w3s/user/initialize",
    { idempotencyKey: randomUUID(), blockchains: circleBlockchains(), accountType: creatorAccountType() },
    userToken
  );
}

/**
 * Add wallets for a user who already has a PIN.
 *
 * `blockchains` defaults to every chain this deployment pays on. Pass a
 * subset to add only what is MISSING: asking Circle for a chain the user
 * already holds is at best a no-op and at worst a second wallet on that
 * chain, which is the ambiguity readCreatorWalletChains then has to resolve.
 */
export async function createCircleWalletForExistingUser(
  userToken: string,
  blockchains?: string[]
): Promise<{ challengeId: string }> {
  const { randomUUID } = await import("crypto");
  return circlePost<{ challengeId: string }>(
    "/v1/w3s/user/wallets",
    {
      idempotencyKey: randomUUID(),
      blockchains: blockchains?.length ? blockchains : circleBlockchains(),
      // One wallet PER BLOCKCHAIN named, not one wallet in total — Circle
      // returns a record per chain, all sharing the account's single address.
      accountType: creatorAccountType(),
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
  /**
   * "EOA" or "SCA". Present on Circle's reply; optional here because a reply
   * from before we asked for it would not carry one.
   *
   * It matters because a merchant can hold BOTH on the same chain — an EOA
   * from before this migration and an SCA created after — and they are
   * different addresses. Picking whichever Circle happens to list first would
   * read a balance from one wallet and withdraw from another.
   */
  accountType?: string;
}

/**
 * This user's wallets.
 *
 * THE LIST PATH IS /v1/w3s/wallets. CREATING is POST /v1/w3s/user/wallets,
 * and this read the same path with GET — which Circle does not serve. Every
 * read answered `{"code":-1,"message":"Resource not found"}`, and code -1 is
 * Circle saying the ROUTE is unknown, not that the resource is empty.
 *
 * It cost an afternoon because of how convincingly it lied. A 404 on every
 * read looked exactly like an account with no wallets, so: relinking
 * reported "Could not find your Circle wallet", the balance screen reported
 * every chain unregistered, add-chains logged "(has none)" and created
 * wallets that had existed all along. The createWallet challenge then came
 * back `status: COMPLETE, errorCode: 0` with four correlation ids — Circle
 * had done the work, and we were asking the wrong address whether it had.
 *
 * Worse, this function had been taught to READ 404 as "none", which turned a
 * wrong URL into a plausible answer. A 404 here is now reported, because with
 * the right path an empty account answers 200 with an empty list.
 */
export async function getCircleWallets(userToken: string): Promise<CircleWallet[]> {
  let data: { wallets?: CircleWallet[] };
  try {
    data = await circleGet<{ wallets: CircleWallet[] }>("/v1/w3s/wallets", userToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) {
      // Kept so a creator with nothing is still offered a wallet rather than
      // an error — but said out loud, because on this path it should not
      // happen and the last time it did, it was the path that was wrong.
      console.warn(
        "[circle] GET /v1/w3s/wallets answered 404 — an empty account should answer 200 " +
          "with an empty list, so treat this as a route or permission problem, not as 'no wallets'"
      );
      return [];
    }
    throw e;
  }
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
      chains: {
        blockchain: string;
        walletId: string;
        address: string;
        accountType: string | null;
        usdc: bigint;
        read: boolean;
      }[];
      missing: string[];
      total: bigint;
      oneAddress: boolean;
      addresses: string[];
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

  /**
   * One wallet per chain, and the RIGHT one where there are two.
   *
   * A merchant who had an EOA before this migration and creates an SCA after
   * holds both on the same chain, at different addresses. `new Map(...)` kept
   * whichever Circle listed last, which is not a decision — it is a coin
   * toss that decides which address a balance is read from and which a
   * withdrawal leaves.
   *
   * USABLE BEATS PREFERRED. A LIVE wallet outranks a preferred one in any
   * other state, because a wallet still initialising cannot be read or
   * withdrawn from: choosing a PENDING SCA over a LIVE EOA would show a
   * creator nothing while their money sat in the EOA. Among equally usable
   * wallets, the configured account type wins.
   */
  const preferred = creatorAccountType();
  const byCode = new Map<string, CircleWallet>();
  for (const w of wallets) {
    const code = (w.blockchain ?? "").toUpperCase();
    const held = byCode.get(code);
    if (!held) {
      byCode.set(code, w);
      continue;
    }
    const score = (x: CircleWallet) =>
      (x.state === "LIVE" ? 4 : 0) + (x.accountType?.toUpperCase() === preferred ? 2 : 0);
    if (score(w) > score(held)) byCode.set(code, w);
  }

  const chains: {
    blockchain: string;
    walletId: string;
    address: string;
    accountType: string | null;
    usdc: bigint;
    read: boolean;
  }[] = [];
  let total = 0n;
  for (const code of want) {
    const w = byCode.get(code);
    if (!w) continue;
    const read = await getCircleWalletBalances(w.id);
    if (!read.ok) {
      // A failed read is not a zero balance — the same distinction the portal
      // already draws. Report it unread rather than reporting zero.
      chains.push({
        blockchain: code,
        walletId: w.id,
        address: w.address,
        accountType: w.accountType ?? null,
        usdc: 0n,
        read: false,
      });
      continue;
    }
    const usdc = read.balances
      .filter((b) => b.token.symbol === "USDC")
      .reduce((sum, b) => sum + parseUsdc(b.amount), 0n);
    chains.push({
      blockchain: code,
      walletId: w.id,
      address: w.address,
      accountType: w.accountType ?? null,
      usdc,
      read: true,
    });
    total += usdc;
  }

  /**
   * Whether every chain really is one address.
   *
   * CONFIRMED with Circle (7 Nov 2026): an SCA has the same address on every
   * EVM-compatible chain, as an EOA does. Circle's unified-addressing doc
   * implies it for "Circle Wallets on EVM" but never says SCA, and its own
   * assistant declined to confirm — so it was confirmed directly.
   *
   * Still reported rather than assumed. It costs one field, and it is the
   * fact a wrongly-pinned payee would turn on: see the guard in
   * /wallet/circle/confirm, which refuses to store an address it cannot vouch
   * for on every chain.
   *
   * It matters because the payout address is pinned into each subscriber's
   * grant. One address means one pin. Several would mean the pin has to be
   * per chain, which the grant targets already are — but settlementPayees()
   * is not, and would have to become so BEFORE any grant is signed.
   */
  const addresses = [...new Set(chains.map((c) => c.address.toLowerCase()))];

  return {
    ok: true,
    address: chains[0]?.address ?? wallets[0]?.address ?? null,
    chains,
    missing: want.filter((c) => !byCode.has(c)),
    total,
    /** True when one address serves every chain — the assumption elsewhere. */
    oneAddress: addresses.length <= 1,
    addresses,
  };
}

/**
 * USDC micro-units back to the decimal string Circle and the dashboard use.
 *
 * The balance route has always returned Circle's own string, so the web side
 * reads `usdcBalance` as text. A total summed across chains has to come back
 * in the same shape or every caller changes at once.
 */
export function formatUsdc(micros: bigint): string {
  const neg = micros < 0n;
  const abs = neg ? -micros : micros;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Circle's decimal string -> USDC micro-units, without floating point. */
export function parseUsdc(amount: string): bigint {
  const [whole = "0", frac = ""] = String(amount).trim().split(".");
  const micros = (frac + "000000").slice(0, 6);
  const sign = whole.startsWith("-") ? -1n : 1n;
  return sign * (BigInt(whole.replace("-", "") || "0") * 1_000_000n + BigInt(micros || "0"));
}

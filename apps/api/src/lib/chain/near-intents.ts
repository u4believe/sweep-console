/**
 * Payouts to a chain we do not settle on, quoted through NEAR Intents.
 *
 * A creator is paid on whichever chain their subscriber paid from, so a
 * balance arrives spread across Base, Arbitrum, Optimism and Monad. Today the
 * only way out is a withdrawal on each chain separately, to an address on that
 * same chain. This asks a different question: what is that balance worth
 * delivered somewhere else — Solana, Tron, Polygon, Arbitrum — in one move.
 *
 * READ-ONLY, AND STRUCTURALLY SO. Every request here sets `dry: true`, which
 * 1Click answers WITHOUT a depositAddress, a deadline or a timeWhenInactive.
 * There is nothing in the response to pay into, so no caller of this module
 * can move money even by mistake. Execution is a separate module and a
 * separate decision; this one exists to price the route first, because NEAR
 * Intents HAS NO TESTNET and mainnet is the only place the question can be
 * asked.
 *
 * WHAT A QUOTE DOES AND DOES NOT INCLUDE. It prices the route: the solver's
 * spread, plus `withdrawFee` — the destination-chain cost, charged in the
 * token itself and already deducted from `amountOut`. It does NOT price
 * 1Click's own cut, which is taken at execution and never appears here; the
 * same pair quotes to the same six decimals with and without a key (measured).
 * That cut is 25bp unauthenticated and 1bp on stablecoin pairs with a key,
 * which is why `EXECUTION_FEE_BPS` below is reported alongside every quote
 * rather than left for the reader to remember.
 */

/** 1Click. No SDK — four fields of one POST body are not worth a dependency. */
const API = "https://1click.chaindefuser.com";

/**
 * The partner JWT, from the Partners Portal ("Distribution Channel" key type).
 *
 * SERVER-SIDE ONLY, and that is the point of this module existing at all
 * rather than the browser calling 1Click directly. The key identifies the
 * integrator and carries our fee schedule; in a Vite bundle it would be
 * readable by anyone who opened the network tab.
 */
const JWT = (process.env.NEAR_1CLICK_JWT ?? "").trim();

export const hasPartnerKey = (): boolean => JWT.length > 0;

/**
 * What execution adds, in basis points, on top of a quote.
 *
 * Stablecoin-only payouts are not an arbitrary restriction: 1Click prices
 * USDC/USDT/DAI pairs at 1bp and everything else at 20bp, so the product
 * decision and the cheap tier are the same decision. Without a key it is 25bp
 * on every route, which is larger than the entire route cost on most
 * destinations — hence the two values rather than a constant.
 */
export const EXECUTION_FEE_BPS = (): number => (hasPartnerKey() ? 1 : 25);

/** Our settlement chains, as 1Click names them, keyed by Circle's code. */
const SOURCE_BY_CIRCLE_CODE: Record<string, string> = {
  BASE: "base",
  ARB: "arb",
  OP: "op",
  MONAD: "monad",
};

export const oneClickChainFor = (circleCode: string): string | null =>
  SOURCE_BY_CIRCLE_CODE[circleCode.toUpperCase()] ?? null;

/**
 * Stablecoins only.
 *
 * A payout is a withdrawal, not a trade. A creator withdrawing to Bitcoin is
 * asking us to take a price view on their revenue, and a creator who meant to
 * hold dollars would be handed volatility by a dropdown. It also keeps every
 * route inside 1Click's 1bp stablecoin tier.
 */
export const PAYOUT_SYMBOLS = ["USDC", "USDT"] as const;
export type PayoutSymbol = (typeof PAYOUT_SYMBOLS)[number];

/**
 * Destinations we will not offer, and why — each a finding, not an opinion.
 *
 * Kept as data rather than filtered out silently, because "we don't support
 * Stellar" and "Stellar needs the recipient to open a trustline first" are
 * different answers and only one of them is true.
 */
export const DESTINATIONS_OFF: Record<string, string> = {
  stellar: "the recipient must hold a USDC trustline before it can be paid",
  xlayer: "no solver liquidity",
  miden: "untested",
};

/** Display names for 1Click's chain slugs. Unknown slugs show as themselves. */
const CHAIN_LABEL: Record<string, string> = {
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  monad: "Monad",
  pol: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
  gnosis: "Gnosis",
  scroll: "Scroll",
  sol: "Solana",
  near: "NEAR",
  tron: "Tron",
  ton: "TON",
  aptos: "Aptos",
  sui: "Sui",
  hypercore: "Hyperliquid",
  // Labelled even though we do not pay to them: DESTINATIONS_OFF is rendered
  // as a list of names and reasons, and "stellar (…)" in a sentence of proper
  // nouns reads as a bug rather than a decision.
  stellar: "Stellar",
  xlayer: "X Layer",
  miden: "Miden",
};
export const chainLabel = (slug: string): string => CHAIN_LABEL[slug] ?? slug;

/**
 * How a recipient address has to look, per destination family.
 *
 * 1Click refuses a quote on address SHAPE alone, so a malformed address reads
 * as "no route" rather than "check the address" unless we catch it first. Only
 * families we actually offer are listed; anything unlisted is accepted as-is
 * and left to the API to judge.
 */
const ADDRESS_SHAPE: Array<{ test: (chain: string) => boolean; re: RegExp; hint: string }> = [
  {
    test: (c) => ["eth", "base", "arb", "op", "monad", "pol", "bsc", "avax", "gnosis", "scroll", "hypercore"].includes(c),
    re: /^0x[a-fA-F0-9]{40}$/,
    hint: "an 0x… address, 42 characters",
  },
  { test: (c) => c === "sol", re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, hint: "a base58 Solana address" },
  { test: (c) => c === "tron", re: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, hint: "a Tron address starting with T" },
  { test: (c) => c === "near", re: /^[a-z0-9._-]{2,64}$/, hint: "a NEAR account id" },
  { test: (c) => c === "aptos" || c === "sui", re: /^0x[a-fA-F0-9]{1,64}$/, hint: "an 0x… address" },
  { test: (c) => c === "ton", re: /^[A-Za-z0-9_-]{48}$/, hint: "a TON address" },
];

/** null when the shape is acceptable (or unknown), a reason when it is not. */
export function addressProblem(chain: string, address: string): string | null {
  const rule = ADDRESS_SHAPE.find((r) => r.test(chain));
  if (!rule) return null;
  return rule.re.test(address.trim()) ? null : `That doesn't look like ${rule.hint}.`;
}

export type PayoutToken = {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
};

/**
 * The token list, cached.
 *
 * It changes when NEAR onboards an asset, which is not on a timescale a
 * dashboard needs to track — and the alternative is a 300KB fetch on every
 * page load. A failed refresh keeps serving the last good list rather than
 * emptying the dropdown, since a stale destination that no longer quotes
 * fails later with a reason, while an empty list looks like a broken feature.
 */
let cache: { at: number; tokens: PayoutToken[] } | null = null;
const TTL_MS = 10 * 60_000;

export async function payoutTokens(): Promise<PayoutToken[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.tokens;
  try {
    const r = await fetch(`${API}/v0/tokens`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`GET /v0/tokens → ${r.status}`);
    const tokens = (await r.json()) as PayoutToken[];
    if (!Array.isArray(tokens) || tokens.length === 0) throw new Error("empty token list");
    cache = { at: Date.now(), tokens };
    return tokens;
  } catch (e) {
    if (cache) {
      console.warn(`[near-intents] token refresh failed, serving ${cache.tokens.length} cached: ${String(e)}`);
      return cache.tokens;
    }
    throw e;
  }
}

function authHeaders(): Record<string, string> {
  return JWT ? { Authorization: `Bearer ${JWT}` } : {};
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase();
const sym = (s: string | undefined) => (s ?? "").toUpperCase();

export function tokenFor(all: PayoutToken[], symbol: string, chain: string): PayoutToken | null {
  return all.find((t) => sym(t.symbol) === sym(symbol) && norm(t.blockchain) === norm(chain)) ?? null;
}

export type Destination = { chain: string; label: string; symbols: PayoutSymbol[] };

/**
 * Every destination we would pay to, from the live token list.
 *
 * Source chains are excluded only when they are the source of THIS quote, not
 * globally — a creator paid on Base may well want it all on Arbitrum, and
 * that is one of the cheapest routes on the board.
 */
export async function destinations(exclude?: string): Promise<Destination[]> {
  const all = await payoutTokens();
  const chains = new Set(all.map((t) => norm(t.blockchain)));
  const out: Destination[] = [];
  for (const chain of [...chains].sort()) {
    if (chain === norm(exclude)) continue;
    if (DESTINATIONS_OFF[chain]) continue;
    const symbols = PAYOUT_SYMBOLS.filter((s) => tokenFor(all, s, chain));
    if (symbols.length > 0) out.push({ chain, label: chainLabel(chain), symbols: [...symbols] });
  }
  return out;
}

export type Quote = {
  /** What leaves the creator's wallet, in whole tokens. */
  amountIn: string;
  /** What lands at the destination, after the route's own costs. */
  amountOut: string;
  /** The worst case the solver may deliver, at the slippage we asked for. */
  minAmountOut: string;
  /** Destination-chain cost, in whole tokens — fixed, not proportional. */
  withdrawFee: string;
  /** Charged only if the route fails and the deposit is returned. */
  refundFee: string;
  /** Seconds, as the solver estimates it. */
  timeEstimate: number | null;
  /** 1bp keyed, 25bp not — charged at execution, NOT inside amountOut. */
  executionFeeBps: number;
};

const fmt = (micro: unknown, decimals: number): string => {
  const n = Number(micro ?? 0) / 10 ** decimals;
  return Number.isFinite(n) ? n.toFixed(Math.min(6, decimals)) : "0";
};

/**
 * Price one payout. Dry, so nothing it returns can be paid into.
 *
 * `slippageTolerance` is 100bp. A tighter bound does not make the route
 * cheaper — it makes solvers decline it, which surfaces as "no route" and
 * reads as an outage. The quote is EXACT_INPUT, so the creator names what
 * leaves and the uncertainty lands on what arrives.
 */
export async function quotePayout(input: {
  fromChain: string;
  toChain: string;
  symbol: PayoutSymbol;
  /** Whole tokens, as typed. */
  amount: string;
  recipient: string;
  /** Where a failed route sends the money back to. */
  refundTo: string;
}): Promise<{ ok: true; quote: Quote } | { ok: false; why: string }> {
  const off = DESTINATIONS_OFF[norm(input.toChain)];
  if (off) return { ok: false, why: `We don't pay out to ${chainLabel(norm(input.toChain))} — ${off}.` };

  const shape = addressProblem(norm(input.toChain), input.recipient);
  if (shape) return { ok: false, why: shape };

  const all = await payoutTokens();
  // The source is always USDC: that is what settlement pays a creator.
  const src = tokenFor(all, "USDC", input.fromChain);
  if (!src) return { ok: false, why: `USDC is not listed on ${chainLabel(norm(input.fromChain))}.` };
  const dst = tokenFor(all, input.symbol, input.toChain);
  if (!dst) {
    return { ok: false, why: `${input.symbol} is not listed on ${chainLabel(norm(input.toChain))}.` };
  }
  if (src.assetId === dst.assetId) {
    return { ok: false, why: "That is the same asset on the same chain — withdraw directly instead." };
  }

  const whole = Number(input.amount);
  if (!Number.isFinite(whole) || whole <= 0) return { ok: false, why: "Enter an amount above zero." };
  const amountMicro = BigInt(Math.round(whole * 10 ** src.decimals)).toString();

  let r: Response;
  try {
    r = await fetch(`${API}/v0/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: src.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: dst.assetId,
        amount: amountMicro,
        refundTo: input.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: input.recipient.trim(),
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    });
  } catch (e) {
    return { ok: false, why: `We couldn't reach the payout network just now (${String(e)}).` };
  }

  const json = (await r.json().catch(() => ({}))) as {
    message?: string;
    quote?: Record<string, unknown>;
  };
  if (!r.ok) return { ok: false, why: String(json.message ?? `The payout network refused the quote (${r.status}).`) };
  const q = json.quote;
  if (!q) return { ok: false, why: "No solver quoted this route just now. Try a different destination or amount." };

  const t = Number(q.timeEstimate);
  return {
    ok: true,
    quote: {
      amountIn: String(q.amountInFormatted ?? input.amount),
      amountOut: String(q.amountOutFormatted ?? fmt(q.amountOut, dst.decimals)),
      minAmountOut: fmt(q.minAmountOut, dst.decimals),
      withdrawFee: fmt(q.withdrawFee, dst.decimals),
      refundFee: fmt(q.refundFee, src.decimals),
      timeEstimate: Number.isFinite(t) ? t : null,
      executionFeeBps: EXECUTION_FEE_BPS(),
    },
  };
}

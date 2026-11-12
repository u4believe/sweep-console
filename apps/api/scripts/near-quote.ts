import "dotenv/config";

/**
 * What a creator's balance is worth on another chain, asked of NEAR Intents.
 *
 *   pnpm tsx scripts/near-quote.ts --to sol --amount 2
 *   pnpm tsx scripts/near-quote.ts --to btc --amount 10 --recipient bc1q…
 *
 * READ-ONLY, AND STRUCTURALLY SO. Every request sets `dry: true`, which the
 * 1Click API answers without a depositAddress, a deadline or a
 * timeWhenInactive — there is nothing in the response to pay into even by
 * mistake. That property is why this step exists before any execution code:
 * NEAR Intents HAS NO TESTNET, so the only way to learn what the route costs
 * and whether solvers quote it at all is to ask mainnet, and a dry quote is
 * the one question that cannot move money.
 *
 * It answers three things the documentation could not:
 *
 *   1. Which of our four settlement chains can actually be a SOURCE. The doc's
 *      confirmed-by-name table lists USDC on Base and Arbitrum but not
 *      Optimism or Monad, while the live token list has all four — Optimism
 *      and Monad through a different bridge, which is worth knowing before
 *      relying on them.
 *   2. The real all-in cost, which is not the quoted fee. Without a partner
 *      JWT NEAR injects its own appFees, so a quote taken now prices the
 *      route as an unregistered integrator sees it. That is the honest number
 *      to design against until the JWT exists.
 *   3. Whether a route is quotable at all. Coverage follows solver inventory
 *      rather than a protocol whitelist, so a thinly traded leg can simply
 *      return nothing — and that is a product decision, not an error.
 *
 * WHAT IT FOUND, 12 Nov 2026, so the next reader starts from numbers rather
 * than from the doc's table:
 *
 *   all four settlement chains quote to USDC elsewhere, but by two different
 *   bridges — base and arb natively (.omft.near), op and monad through the
 *   HOT bridge (nep245 omni.hot.tg). The doc's confirmed-by-name table lists
 *   only base and arb, so op and monad would have read as unsupported.
 *
 *   THE COST IS FIXED, NOT PROPORTIONAL. It is destination gas, and it barely
 *   moves with size:
 *
 *                    -> ethereum        -> solana        -> near
 *       2 USDC        0.300 (15.0%)     0.010 (0.51%)    0.005 (0.23%)
 *      20 USDC        0.303 (1.51%)     0.012 (0.06%)    0.005 (0.02%)
 *     200 USDC        0.322 (0.16%)     0.026 (0.01%)    0.005 (0.00%)
 *
 *   Which makes the product rule a MINIMUM WITHDRAWAL PER DESTINATION rather
 *   than a fee percentage. A 2 USDC payout to Ethereum loses 15% of itself;
 *   the same payout to NEAR loses 0.23%. A creator must see the quote before
 *   committing, and the dry endpoint makes showing it free.
 *
 * LIMITATION: this quotes USDC to USDC. A Bitcoin payout wants USDC -> BTC,
 * which is a different destination asset and not covered here — hence
 * "USDC is not listed on btc", which is true and beside the point.
 */
const API = "https://1click.chaindefuser.com";

/** Our settlement chains, as 1Click names them. */
const SOURCE_CHAINS = ["base", "arb", "op", "monad"] as const;

type Token = {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
};

/** A plausible address per destination, so the quote is not refused on shape. */
const SAMPLE_RECIPIENT: Record<string, string> = {
  sol: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  btc: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  eth: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f",
  base: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f",
  arb: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f",
  op: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f",
  monad: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f",
  near: "example.near",
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function tokens(): Promise<Token[]> {
  const r = await fetch(`${API}/v0/tokens`);
  if (!r.ok) throw new Error(`GET /v0/tokens → ${r.status}`);
  return (await r.json()) as Token[];
}

/** USDC on a given 1Click chain, or null when that pair is not listed. */
function usdcOn(all: Token[], chain: string): Token | null {
  return (
    all.find(
      (t) => (t.symbol ?? "").toUpperCase() === "USDC" && (t.blockchain ?? "").toLowerCase() === chain
    ) ?? null
  );
}

async function quote(input: {
  originAsset: string;
  destinationAsset: string;
  amountMicro: string;
  refundTo: string;
  recipient: string;
}): Promise<{ ok: true; q: Record<string, string> } | { ok: false; why: string }> {
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    // 1% in basis points. A dry quote does not commit to it; it only bounds
    // what the solver may return, and a tight tolerance reads as "no route".
    slippageTolerance: 100,
    originAsset: input.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: input.destinationAsset,
    amount: input.amountMicro,
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const r = await fetch(`${API}/v0/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    return { ok: false, why: String((json as { message?: string }).message ?? `HTTP ${r.status}`) };
  }
  const q = (json as { quote?: Record<string, string> }).quote;
  if (!q) return { ok: false, why: "no quote in the response — no solver took the route" };
  return { ok: true, q };
}

async function main() {
  const toChain = (arg("to") ?? "sol").toLowerCase();
  const amount = Number(arg("amount") ?? "2");
  const amountMicro = String(Math.round(amount * 1_000_000));
  const refundTo = arg("refund-to") ?? "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f";
  const recipient = arg("recipient") ?? SAMPLE_RECIPIENT[toChain];

  if (!recipient) {
    console.log(
      `No sample address for "${toChain}". Pass --recipient <address on that chain>; the quote is ` +
        `refused on address shape alone, so it has to look real.`
    );
    process.exitCode = 1;
    return;
  }

  const all = await tokens();
  const dest = usdcOn(all, toChain);
  if (!dest) {
    const where = all
      .filter((t) => (t.symbol ?? "").toUpperCase() === "USDC")
      .map((t) => t.blockchain)
      .join(", ");
    console.log(`USDC is not listed on "${toChain}". It is listed on: ${where}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${amount} USDC -> USDC on ${toChain}   (dry run, nothing moves)\n`);
  console.log(`  destination asset  ${dest.assetId}\n`);

  for (const chain of SOURCE_CHAINS) {
    const src = usdcOn(all, chain);
    if (!src) {
      console.log(`  ${chain.padEnd(7)} USDC NOT LISTED on this chain — cannot be a source`);
      continue;
    }
    if (src.assetId === dest.assetId) {
      console.log(`  ${chain.padEnd(7)} same asset as the destination — no swap needed`);
      continue;
    }
    const res = await quote({
      originAsset: src.assetId,
      destinationAsset: dest.assetId,
      amountMicro,
      refundTo,
      recipient,
    });
    if (!res.ok) {
      console.log(`  ${chain.padEnd(7)} NO QUOTE — ${res.why}`);
      continue;
    }
    const out = Number(res.q.amountOutFormatted ?? "0");
    const cost = amount > 0 ? ((amount - out) / amount) * 100 : 0;
    // The bridge shows in the asset id, and it is not cosmetic: omft is the
    // native route, omni.hot.tg is the HOT bridge, and they are different
    // liquidity.
    const bridge = src.assetId.includes("omni.hot.tg") ? "HOT" : src.assetId.includes(".omft.") ? "omft" : "?";
    console.log(
      `  ${chain.padEnd(7)} ${out.toFixed(6)} out   cost ${cost.toFixed(3)}%   ` +
        `~${res.q.timeEstimate ?? "?"}s   via ${bridge}`
    );
  }

  console.log(
    `\nNo partner JWT is set, so these include the appFees NEAR injects for ` +
      `unregistered integrators. A JWT from the Partners Portal waives the protocol fee — ` +
      `get it before pricing this for creators.\n`
  );
}

main();

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
 * WHAT THE MATRIX FOUND, 12 Nov 2026, from base:
 *
 *   TWO COSTS, NOT ONE. Destination gas is fixed, and the USDC/USDT peg
 *   spread is proportional and currently in our favour — so the same route
 *   gets cheaper with size, and past a few hundred USDC several USDT
 *   destinations come out NET POSITIVE:
 *
 *                    20 USDC      100 USDC     500 USDC
 *       eth/USDC      0.304        0.310        0.360     fixed L1 gas
 *       eth/USDT      0.283        0.213       -0.136     spread overtakes gas
 *       tron/USDT     0.847        0.777        0.436
 *       near/USDT    -0.016          —         -0.253
 *       sol/USDT     -0.006          —         -0.243
 *
 *   A NEGATIVE COST IS A MARKET CONDITION, NOT A FEATURE. It is USDT trading
 *   a touch above USDC at quote time; it can invert. Never promise it — quote
 *   it.
 *
 *   TRON IS THE EXPENSIVE ONE, which is the opposite of what its volume
 *   suggests: 4.2% of a 20 USDC payout, 0.09% of a 500 one. It is also the
 *   only route most USDT holders actually want. So it argues for a
 *   per-destination minimum rather than dropping the destination.
 *
 *   CHEAP EVERYWHERE ELSE: near, op, gnosis, sol, bsc, pol, avax and arb all
 *   land under 0.1% on 20 USDC — fractions of a cent.
 *
 *   THREE ROUTES REFUSE, each for its own reason worth surfacing in a UI
 *   rather than reporting as an error:
 *     stellar   "Destination address does not have a trustline for this" —
 *               Stellar needs the recipient to hold a USDC trustline first.
 *     xlayer    "No liquidity available" — solver inventory, exactly the gap
 *               the docs warn coverage follows.
 *     miden     no sample address here, so untested rather than unsupported.
 *
 * LIMITATION: stablecoins only, by design. A Bitcoin payout wants USDC -> BTC,
 * a different destination asset — hence "USDC is not listed on btc", which is
 * true and beside the point.
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

/**
 * A shape-valid address per destination, because the API validates the
 * recipient before it will quote.
 *
 * These are for SHAPE ONLY. `dry: true` means no depositAddress ever comes
 * back, so nothing can be paid to any of them — but a quote is refused
 * outright on a malformed recipient, so each destination needs one that
 * parses. An all-zeroes Solana address, for instance, is rejected.
 */
const SAMPLE_RECIPIENT: Record<string, string> = {
  // EVM, one shape for all of them
  eth: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f", base: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f", arb: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f", op: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f", monad: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f",
  pol: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f", bsc: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f", avax: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f", gnosis: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f", scroll: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f",
  xlayer: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f", hypercore: "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f",
  // non-EVM
  sol: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  near: "intents.near",
  tron: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
  ton: "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
  stellar: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
  aptos: "0x0000000000000000000000000000000000000000000000000000000000000001",
  sui: "0x0000000000000000000000000000000000000000000000000000000000000002",
  btc: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
};

/**
 * STABLECOINS ONLY, which is a product decision and a convenient one.
 *
 * USDC reaches 16 chains and USDT 13, and the union is wider than either —
 * USDT is the only way to reach TRON and TON, which between them carry more
 * stablecoin volume than most of the USDC set. Meanwhile USDT is NOT on Base,
 * Arbitrum or Monad, so it can only ever be a DESTINATION here: the source
 * leg is always the USDC a creator was paid in.
 *
 * One source asset, two destination assets, no volatility to explain to a
 * creator. A BTC or SOL payout would be a different product.
 */
const PAYOUT_SYMBOLS = ["USDC", "USDT"] as const;

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

/**
 * Every stablecoin destination, priced from one source.
 *
 * The point is comparison, not completeness: which destinations are worth
 * offering at all. A fixed destination-gas cost means the answer depends
 * entirely on the payout size, so this prints the cost in USDC as well as a
 * percentage — a creator cares about the former.
 */
async function matrix(amount: number, fromChain: string): Promise<void> {
  const all = await tokens();
  const src = usdcOn(all, fromChain);
  if (!src) {
    console.log(`USDC is not listed on "${fromChain}" — it cannot be a source.`);
    process.exitCode = 1;
    return;
  }
  const amountMicro = String(Math.round(amount * 1_000_000));
  const refundTo = arg("refund-to") ?? "0x18e0699EE5c7dd9D558D56f0C2b2f6C3a5b6747f";

  const rows = all
    .filter((t) => (PAYOUT_SYMBOLS as readonly string[]).includes((t.symbol ?? "").toUpperCase()))
    .filter((t) => t.assetId !== src.assetId)
    .sort((a, b) => `${a.blockchain}${a.symbol}`.localeCompare(`${b.blockchain}${b.symbol}`));

  console.log(`\n${amount} USDC on ${fromChain} -> stablecoin elsewhere   (dry run, nothing moves)\n`);
  console.log(`  ${"destination".padEnd(14)} ${"asset".padEnd(6)} ${"out".padStart(12)} ${"cost".padStart(10)} ${"%".padStart(8)}   time`);

  const priced: Array<{ chain: string; sym: string; cost: number }> = [];
  for (const t of rows) {
    const chain = (t.blockchain ?? "").toLowerCase();
    const sym = (t.symbol ?? "").toUpperCase();
    /**
     * Some chains list the same symbol twice — hypercore carries USDC as both
     * hip1 and erc20 — and two identical-looking rows read as a bug. The tail
     * of the asset id is what tells them apart.
     */
    const variant = t.assetId.split(":").pop()?.split("-")[0] ?? "";
    const recipient = SAMPLE_RECIPIENT[chain];
    if (!recipient) {
      console.log(`  ${chain.padEnd(14)} ${sym.padEnd(6)} ${"—".padStart(12)}  no sample address for this chain`);
      continue;
    }
    const res = await quote({
      originAsset: src.assetId,
      destinationAsset: t.assetId,
      amountMicro,
      refundTo,
      recipient,
    });
    if (!res.ok) {
      console.log(`  ${chain.padEnd(14)} ${sym.padEnd(6)} ${"—".padStart(12)}  ${res.why.slice(0, 54)}`);
      continue;
    }
    const out = Number(res.q.amountOutFormatted ?? "0");
    const cost = amount - out;
    priced.push({ chain, sym, cost });
    console.log(
      `  ${chain.padEnd(14)} ${sym.padEnd(6)} ${out.toFixed(6).padStart(12)} ${cost.toFixed(6).padStart(10)} ` +
        `${((cost / amount) * 100).toFixed(3).padStart(7)}%   ~${res.q.timeEstimate ?? "?"}s` +
        (rows.filter((r) => r.blockchain === t.blockchain && r.symbol === t.symbol).length > 1
          ? `   [${variant}]`
          : "")
    );
  }

  priced.sort((a, b) => a.cost - b.cost);
  if (priced.length > 0) {
    console.log(`\n  cheapest: ${priced.slice(0, 5).map((p) => `${p.chain}/${p.sym} ${p.cost.toFixed(4)}`).join("  ")}`);
    console.log(`  dearest:  ${priced.slice(-3).map((p) => `${p.chain}/${p.sym} ${p.cost.toFixed(4)}`).join("  ")}`);
  }
}

async function main() {
  if (process.argv.includes("--matrix")) {
    await matrix(Number(arg("amount") ?? "20"), (arg("from") ?? "base").toLowerCase());
    return;
  }
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

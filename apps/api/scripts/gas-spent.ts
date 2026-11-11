import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { createPublicClient, http, formatEther, formatUnits } from "viem";
import { base, arbitrum, optimism, monad } from "viem/chains";

/**
 * What the platform actually paid in gas to settle, per chain.
 *
 * Gas is on us — it is the thing the product promises and the thing nobody
 * could price until now. Under the bridged path a settlement cost three
 * transactions plus a CCTP fee and the answer was spread across four
 * addresses; direct settlement is one handleOps from one payer, so the bill
 * is a receipt lookup.
 *
 * Reads the receipts rather than differencing balances: a balance delta also
 * contains EntryPoint deposits, which are a transfer and not a cost.
 */
const prisma = new PrismaClient();
const CHAINS = { base, arbitrum, optimism, monad } as const;

async function main() {
  const since = new Date(Date.now() - 48 * 3600 * 1000);
  const rows = await prisma.payment.findMany({
    where: { createdAt: { gte: since }, txHash: { not: null } },
    select: { id: true, txHash: true, chain: true, amount: true, type: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) {
    console.log("no payments with a tx hash in the last 48h");
    return;
  }

  const perChain = new Map<string, { gas: bigint; native: string; n: number; usdc: bigint }>();
  for (const r of rows) {
    const key = (r.chain ?? "").toLowerCase();
    const chain = (CHAINS as Record<string, (typeof CHAINS)[keyof typeof CHAINS]>)[key];
    if (!chain) {
      console.log(`  ${String(r.txHash).slice(0, 18)}…  chain "${r.chain}" not recognised — skipped`);
      continue;
    }
    try {
      const pc = createPublicClient({ chain, transport: http() });
      const rc = await pc.getTransactionReceipt({ hash: r.txHash as `0x${string}` });
      const cost = rc.gasUsed * (rc.effectiveGasPrice ?? 0n);
      const cur = perChain.get(key) ?? { gas: 0n, native: chain.nativeCurrency.symbol, n: 0, usdc: 0n };
      cur.gas += cost;
      cur.n += 1;
      cur.usdc += BigInt(r.amount ?? 0);
      perChain.set(key, cur);
      console.log(
        `  ${key.padEnd(9)} ${String(r.txHash).slice(0, 14)}…  gasUsed ${String(rc.gasUsed).padStart(9)}  ` +
          `@ ${rc.effectiveGasPrice ?? 0n} wei  = ${formatEther(cost)} ${chain.nativeCurrency.symbol}`
      );
    } catch (e) {
      console.log(`  ${key.padEnd(9)} ${String(r.txHash).slice(0, 14)}…  receipt unavailable`);
    }
  }

  console.log("\ntotal per chain");
  for (const [k, v] of perChain) {
    console.log(
      `  ${k.padEnd(9)} ${v.n} settlement(s)  collected ${formatUnits(v.usdc, 6)} USDC  ` +
        `gas ${formatEther(v.gas)} ${v.native}`
    );
  }
}
main().finally(() => prisma.$disconnect());

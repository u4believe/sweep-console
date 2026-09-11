// Re-anchor a relayer's stored nonce when it has run ahead of the chain.
//
//   pnpm tsx scripts/nonce-reanchor.ts                 # report every key/chain
//   pnpm tsx scripts/nonce-reanchor.ts --write         # correct the safe ones
//
// allocateNonce raises the stored counter to the chain's pending count whenever
// the chain is AHEAD. It cannot lower it, and it should not be able to: handing
// back a nonce that might still be in flight would replace a real payment.
//
// But a send that is allocated a nonce and then never reaches the mempool leaves
// the row permanently high. Once the node has dropped it there is nothing pending
// at that nonce, so every later send is signed with a FUTURE nonce and queues
// unmined — indefinitely, because nothing will ever fill the hole. On Arc that
// jams receiveOnArc, which is the CCTP mint at the end of every cross-chain
// payment.
//
// The safe test is the one this script applies: re-anchor only when the mempool
// is provably empty for that account, i.e. latest == pending. If they differ,
// transactions really are in flight and the gap may close on its own.
//
// It deletes the row rather than rewriting the counter, so the next allocation
// seeds through allocateNonce's own INSERT branch (`pending + 1`) instead of this
// script hand-writing a number that module owns.

import "dotenv/config";
import { createPublicClient, http, defineChain, type Address } from "viem";
import { prisma } from "../src/lib/prisma";

function rpcFor(chainId: number): string | null {
  if (chainId === 5042002 || chainId === 5042001) return process.env.ARC_TESTNET_RPC_URL ?? null;
  return process.env[`DELEGATION_RPC_${chainId}`] ?? null;
}

function clientFor(chainId: number, url: string) {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  return createPublicClient({ chain, transport: http() });
}

async function main() {
  const write = process.argv.includes("--write");
  console.log(write ? "MODE: write\n" : "MODE: report (pass --write to correct)\n");

  const rows = await prisma.relayerNonce.findMany({ orderBy: [{ chainId: "asc" }, { address: "asc" }] });
  if (rows.length === 0) return void console.log("no stored nonces — every key seeds from the chain on next use.");

  let corrected = 0;
  for (const row of rows) {
    const url = rpcFor(row.chainId);
    if (!url) {
      console.log(`${row.address} chain ${row.chainId}: no RPC configured — skipped`);
      continue;
    }
    const client = clientFor(row.chainId, url);
    const address = row.address as Address;
    let latest: number;
    let pending: number;
    try {
      [latest, pending] = await Promise.all([
        client.getTransactionCount({ address, blockTag: "latest" }),
        client.getTransactionCount({ address, blockTag: "pending" }),
      ]);
    } catch (e) {
      console.log(`${row.address} chain ${row.chainId}: RPC unreachable — skipped (${(e as Error).message.split("\n")[0]})`);
      continue;
    }

    const ahead = row.nextNonce - pending;
    const state =
      latest !== pending
        ? `${pending - latest} in the mempool`
        : ahead > 0
          ? `${ahead} AHEAD with an empty mempool`
          : "in step";
    console.log(
      `${row.address} chain ${String(row.chainId).padEnd(9)} latest ${latest} · pending ${pending} · stored ${row.nextNonce} — ${state}`
    );

    if (latest !== pending || ahead <= 0) continue;
    if (!write) {
      console.log(`    would re-anchor: next send would otherwise be signed with ${row.nextNonce} and never mine`);
      continue;
    }
    await prisma.relayerNonce.delete({
      where: { address_chainId: { address: row.address, chainId: row.chainId } },
    });
    corrected++;
    console.log(`    re-anchored — next allocation seeds from the chain at ${pending}`);
  }

  if (write) console.log(`\nre-anchored ${corrected} key/chain pair(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

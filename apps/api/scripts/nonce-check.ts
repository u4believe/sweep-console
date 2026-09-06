// Local proof that the nonce allocator produces real, distinct, mineable nonces.
//
//   pnpm tsx scripts/nonce-check.ts read            # read-only: registry + chain state
//   pnpm tsx scripts/nonce-check.ts fund 0.05       # send gas to the throwaway key
//   pnpm tsx scripts/nonce-check.ts race 5          # 5 CONCURRENT sends, with allocation
//   pnpm tsx scripts/nonce-check.ts race 5 --naive  # same, letting viem pick — the control
//
// Everything past `read` runs on a THROWAWAY key derived from NONCE_TEST_SEED, never
// the platform relayer, so a botched run cannot strand the nonce sequence that the
// live billing engine depends on. `fund` is the one exception: it is a single real
// transfer out of the relayer's Arc balance.

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  keccak256,
  parseEther,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { allocateNonce, resetNonce, withNonce } from "../src/lib/chain/nonce";
import { getPlatformAccount, knownDelegates, accountForDelegate } from "../src/lib/chain/signers";
import { prisma } from "../src/lib/prisma";

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network/"] } },
  testnet: true,
});

const publicClient = createPublicClient({ chain: arc, transport: http() });

/// A key that exists only for this harness. Deterministic so repeated runs reuse the
/// same funded address instead of stranding gas in a new one each time.
function throwaway() {
  const seed = process.env.NONCE_TEST_SEED ?? "sweep-nonce-harness-v1";
  return privateKeyToAccount(keccak256(toHex(seed)) as Hex);
}

async function storedNonce(address: string) {
  const rows = await prisma.$queryRaw<{ nextNonce: number }[]>`
    SELECT "nextNonce" FROM "relayer_nonces"
     WHERE "address" = ${address.toLowerCase()} AND "chainId" = ${arc.id}
  `;
  return rows[0]?.nextNonce ?? null;
}

async function read() {
  const platform = getPlatformAccount();
  const test = throwaway();

  console.log("── signer registry ──");
  console.log("platform         ", platform.address);
  console.log("known delegates  ", knownDelegates().join(", "));
  // The 39 live mandates all name this address; if it stops resolving, they are dead.
  const live = "0xD4F79436a2a69C70127570749dc39Ae5D5C0c646";
  try {
    const a = accountForDelegate(live as Hex);
    console.log("live mandate key ", a.address.toLowerCase() === live.toLowerCase() ? "RESOLVES ✓" : "MISMATCH ✗");
  } catch (e) {
    console.log("live mandate key  UNRESOLVABLE ✗ —", (e as Error).message);
  }

  console.log("\n── chain vs stored (Arc testnet) ──");
  for (const acct of [platform, test]) {
    const [pending, bal, stored] = await Promise.all([
      publicClient.getTransactionCount({ address: acct.address, blockTag: "pending" }),
      publicClient.getBalance({ address: acct.address }),
      storedNonce(acct.address),
    ]);
    const label = acct.address === platform.address ? "platform" : "throwaway";
    const drift = stored === null ? "no row yet" : stored === pending ? "in sync ✓" : `DRIFT ${stored - pending}`;
    console.log(
      `${label.padEnd(10)} ${acct.address}  pending=${pending}  stored=${stored ?? "-"}  ${drift}  bal=${formatEther(bal)}`
    );
  }
}

async function fund(amount: string) {
  const platform = getPlatformAccount();
  const test = throwaway();
  const wallet = createWalletClient({ account: platform, chain: arc, transport: http() });
  console.log(`funding ${test.address} with ${amount} USDC from ${platform.address}…`);
  // Deliberately NOT through withNonce: this is the relayer's own key and the live
  // billing engine may be mid-send on it. Let viem read the chain, as it does today.
  const hash = await wallet.sendTransaction({ to: test.address, value: parseEther(amount) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  ${receipt.status} — ${hash}`);
}

async function race(n: number, naive: boolean) {
  const test = throwaway();
  const wallet = createWalletClient({ account: test, chain: arc, transport: http() });

  const bal = await publicClient.getBalance({ address: test.address });
  if (bal === 0n) throw new Error(`${test.address} has no gas — run: pnpm tsx scripts/nonce-check.ts fund 0.05`);

  console.log(`${n} concurrent self-sends from ${test.address} (${naive ? "NAIVE — viem picks" : "allocated"})\n`);

  // Fired together on purpose. This is the exact shape of the bug: several sends on
  // one key with no send having reached the mempool before the next reads the count.
  const results = await Promise.allSettled(
    Array.from({ length: n }, (_, i) =>
      naive
        ? wallet.sendTransaction({ to: test.address, value: 0n }).then((h) => ({ i, nonce: -1, hash: h }))
        : withNonce(test.address, arc.id, publicClient, (nonce) =>
            wallet.sendTransaction({ to: test.address, value: 0n, nonce }).then((h) => ({ i, nonce, hash: h }))
          )
    )
  );

  const sent: { i: number; nonce: number; hash: Hex }[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") sent.push(r.value as { i: number; nonce: number; hash: Hex });
    else console.log(`  send REJECTED — ${(r.reason as Error).message.split("\n")[0]}`);
  }

  const mined = await Promise.all(
    sent.map(async (s) => {
      try {
        const rc = await publicClient.waitForTransactionReceipt({ hash: s.hash, timeout: 60_000 });
        const tx = await publicClient.getTransaction({ hash: s.hash });
        return { ...s, onChainNonce: tx.nonce, status: rc.status as string };
      } catch {
        return { ...s, onChainNonce: -1, status: "NOT MINED" };
      }
    })
  );

  console.log("  allocated  on-chain  status     tx");
  for (const m of mined.sort((a, b) => a.onChainNonce - b.onChainNonce)) {
    const match = m.nonce === -1 ? "  " : m.nonce === m.onChainNonce ? "✓ " : "✗ ";
    console.log(`  ${String(m.nonce).padStart(9)}  ${String(m.onChainNonce).padStart(8)}  ${m.status.padEnd(9)} ${match}${m.hash}`);
  }

  const distinct = new Set(mined.map((m) => m.onChainNonce)).size;
  const ok = mined.length === n && distinct === n && mined.every((m) => m.status === "success");
  console.log(`\n  requested=${n} broadcast=${sent.length} mined=${mined.filter((m) => m.status === "success").length} distinct nonces=${distinct}`);
  console.log(`  ${ok ? "PASS — every send got its own nonce and mined" : "FAIL — sends collided, were dropped, or replaced each other"}`);
  console.log(`  stored nextNonce = ${await storedNonce(test.address)}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const naive = process.argv.includes("--naive");
  if (cmd === "fund") await fund(arg ?? "0.05");
  else if (cmd === "race") await race(Number(arg ?? 5), naive);
  else if (cmd === "reset") await resetNonce(throwaway().address, arc.id), console.log("throwaway row cleared");
  else if (cmd === "alloc") console.log("allocated", await allocateNonce(throwaway().address, arc.id, publicClient));
  else await read();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

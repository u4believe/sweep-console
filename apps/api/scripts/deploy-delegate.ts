import "dotenv/config";
import { isMainnet, supportedSourceChains } from "../src/lib/gateway/chains";
import {
  delegateAddressForNewGrant,
  delegateMscaEnabled,
  ensureDelegateMscaDeployed,
  ownerOfDelegateMsca,
} from "../src/lib/chain/delegate-msca";
import { createPublicClient, http } from "viem";

/**
 * Put code on the delegate MSCA on every chain this deployment grants over.
 *
 * MetaMask refuses to grant an ERC-7715 permission to a `to` address with no
 * code on the target chain — proven by a clean seven-chain split, where every
 * chain carrying a deployed delegate authorized and every chain without one
 * returned 4100 after the subscriber confirmed. The redeem path deploys
 * lazily on its first operation, which is too late: the grant comes first.
 *
 * Reports by default; --apply deploys.
 */
async function main() {
  const apply = process.argv.includes("--apply");

  if (!delegateMscaEnabled()) {
    console.log("DELEGATE_MSCA_ENABLED is not true, so new grants name the relayer EOA.");
    console.log("An EOA delegate has no code on any chain, which is what MetaMask refuses.");
    console.log("Set DELEGATE_MSCA_ENABLED=true and RENEWAL_DELEGATE_MSCA_ADDRESS, then re-run.");
    process.exitCode = 1;
    return;
  }

  const delegate = delegateAddressForNewGrant("hosted");
  const owned = ownerOfDelegateMsca(delegate);
  if (!owned) {
    console.log(`No owner key resolves to delegate ${delegate} — cannot deploy it.`);
    process.exitCode = 1;
    return;
  }

  const chains = supportedSourceChains();
  /**
   * The chain ID is printed because the KEY alone is ambiguous: "base" is
   * Base on a mainnet deployment and Base Sepolia on a test one, and the
   * delegate's deployment state differs between them. A report that cannot
   * be told apart from the other network's report is a trap.
   */
  console.log(`delegate ${delegate}   owner mode=${owned.mode}   network=${isMainnet() ? "MAINNET" : "testnet"}`);

  let missing = 0;
  let unknown = 0;
  for (const c of chains) {
    /**
     * An RPC failure is NOT an absence of code, and must never be read as one.
     *
     * The first version of this script caught the error and fell through to
     * the same branch as "0x", which reported a delegate that is deployed on
     * Base, Arbitrum and Optimism as missing on all three — purely because a
     * public RPC rate-limited three calls in a row. With --apply that
     * mistake spends gas redeploying accounts that already exist.
     */
    const pc = createPublicClient({ chain: c.chain, transport: http() });
    let code: string | undefined;
    try {
      code = await pc.getCode({ address: delegate });
    } catch (e) {
      console.log(`  ${`${c.key}:${c.chain.id}`.padEnd(18)} UNKNOWN — RPC failed, not checked: ${(e as Error).message.split("\n")[0].slice(0, 60)}`);
      unknown += 1;
      process.exitCode = 1;
      continue;
    }
    if (code && code !== "0x") {
      console.log(`  ${`${c.key}:${c.chain.id}`.padEnd(18)} deployed (${(code.length - 2) / 2} bytes)`);
      continue;
    }
    missing += 1;
    if (!apply) {
      console.log(`  ${`${c.key}:${c.chain.id}`.padEnd(18)} NO CODE — grants on this chain will fail with 4100 (use --apply)`);
      continue;
    }
    try {
      const r = await ensureDelegateMscaDeployed({ chainId: c.chain.id, owner: owned.owner, delegate });
      console.log(`  ${`${c.key}:${c.chain.id}`.padEnd(18)} DEPLOYED  ${r.txHash}`);
    } catch (e) {
      console.log(`  ${`${c.key}:${c.chain.id}`.padEnd(18)} FAILED    ${(e as Error).message.split("\n")[0]}`);
      process.exitCode = 1;
    }
  }

  /**
   * A chain we COULD NOT CHECK is not a chain that passed.
   *
   * The first version counted only confirmed absences, so a run where one
   * RPC failed still ended with "Every chain carries the delegate" — the
   * reassuring summary being the one line a reader trusts. An unknown is
   * reported as an unknown, and the all-clear requires every chain to have
   * actually answered.
   */
  if (unknown > 0) {
    console.log(`\n${unknown} chain(s) could not be checked. Re-run; the all-clear needs every chain to answer.`);
  }
  if (missing === 0 && unknown === 0) {
    console.log("\nEvery chain carries the delegate. Grants can be signed on all of them.");
  } else if (missing > 0 && !apply) {
    console.log(`\n${missing} chain(s) need the delegate deployed. Re-run with --apply.`);
  }
}

main();

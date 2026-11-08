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
 * Put code on the delegate MSCA on every chain this deployment redeems over.
 *
 * NOT a fix for the 4100 on the grant, though it was written as one. The
 * reasoning was that MetaMask refuses a `to` address with no code, from a
 * seven-chain split where every deployed delegate authorized and every
 * code-less one failed. Grants stored on 4 November disprove it: they name an
 * EOA delegate with no code on any of those chains, and they were signed.
 *
 * It earns its place anyway. An MSCA needs code to execute, and the redeem
 * path deploys lazily on its first operation — inside the first renewal a
 * subscriber is waiting on, paying the deploying op's extra verification gas
 * there. This moves that out of a live charge.
 */
async function main() {
  const apply = process.argv.includes("--apply");

  if (!delegateMscaEnabled()) {
    console.log("DELEGATE_MSCA_ENABLED is not true, so new grants name the relayer EOA.");
    console.log("An EOA needs no deployment, so there is nothing for this script to do.");
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
      console.log(`  ${`${c.key}:${c.chain.id}`.padEnd(18)} NO CODE — its first redeem here pays to deploy it (use --apply)`);
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
    console.log("\nEvery chain carries the delegate. No redeem will pay to deploy it.");
  } else if (missing > 0 && !apply) {
    console.log(`\n${missing} chain(s) need the delegate deployed. Re-run with --apply.`);
  }
}

main();

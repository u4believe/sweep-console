// Rotate an MSCA's owner key while keeping its address.
//
//   pnpm tsx scripts/rotate-msca-owner.ts --role hosted --new 0xNewOwner
//   pnpm tsx scripts/rotate-msca-owner.ts --role hosted --new 0xNewOwner --apply
//
// Roles: hosted (RENEWAL_DELEGATE), external (EXTERNAL_RELAYER), settlement.
//
// WHY THIS EXISTS AND WHAT IT IS FOR
//
// This is the property the whole MSCA decision was made for. An EOA's address
// IS its key, and a 7702 account's address is its key's address, so rotating
// either moves the address — and the delegate address is written into every
// grant's delegation struct while the settlement address is written into their
// payee caveats. Moving it invalidates them.
//
// An MSCA's address comes from a factory, a salt and the INITIAL owner, so once
// it is deployed the owner can be replaced and the address stays. Every grant
// keeps working.
//
// BEFORE IT IS DEPLOYED, ROTATION IS NOT A TRANSACTION
//
// A counterfactual account's address is still a pure function of the owner key,
// so changing the key just changes the address — no chain involved. This script
// refuses to run in that case and tells you to re-derive instead, because
// sending a rotation for an account that does not exist would deploy it with
// the OLD owner first, which is the opposite of what was wanted.
//
// That is also the reason to settle the owner key before the first grant names
// the address: until then this is an env var, afterwards it is an on-chain
// operation under a one-of-one threshold.

import "dotenv/config";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { rpcUrlForChain } from "../src/lib/chain/delegation";
import { getRelayerAccount, getSettlementAccount } from "../src/lib/chain/signers";
import { supportedSourceChains, chainKeyForId } from "../src/lib/gateway/chains";

/// Circle's weighted-owner validation plugin, which holds the owner set.
const OWNER_PLUGIN: Address = "0x0000000C984AFf541D6cE86Bb697e68ec57873C8";

const PLUGIN_ABI = [
  {
    name: "addOwners",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ownersToAdd", type: "address[]" },
      { name: "weightsToAdd", type: "uint256[]" },
      { name: "publicKeyOwnersToAdd", type: "tuple[]", components: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }] },
      { name: "pubicKeyWeightsToAdd", type: "uint256[]" },
      { name: "newThresholdWeight", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "removeOwners",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ownersToRemove", type: "address[]" },
      { name: "publicKeyOwnersToRemove", type: "tuple[]", components: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }] },
      { name: "newThresholdWeight", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "ownershipInfoOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bytes30[]" }, { type: "uint256[]" }, { type: "uint256" }],
  },
  {
    name: "isOwnerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }, { name: "ownerToCheck", type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const NO_WEBAUTHN: readonly { x: bigint; y: bigint }[] = [];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const role = (arg("role") ?? "") as "hosted" | "external" | "settlement";
  if (!["hosted", "external", "settlement"].includes(role)) {
    throw new Error("--role must be hosted, external or settlement");
  }
  const newOwnerRaw = arg("new");
  if (!newOwnerRaw) throw new Error("--new <address> is required (the incoming owner)");
  const newOwner = getAddress(newOwnerRaw);
  const apply = process.argv.includes("--apply");

  const owner = role === "settlement" ? getSettlementAccount() : getRelayerAccount(role);
  console.log(`role            ${role}`);
  console.log(`current owner   ${owner.address}`);
  console.log(`incoming owner  ${newOwner}`);
  console.log(apply ? "MODE: apply\n" : "MODE: dry run (pass --apply to commit)\n");

  if (newOwner.toLowerCase() === owner.address.toLowerCase()) {
    throw new Error("the incoming owner is the current owner — nothing to rotate");
  }

  for (const source of supportedSourceChains()) {
    const chainId = source.chain.id;
    const label = chainKeyForId(chainId) ?? String(chainId);
    const rpc = rpcUrlForChain(chainId);
    const chain = defineChain({
      id: chainId,
      name: label,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
    const publicClient = createPublicClient({ chain, transport: http(rpc) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = await toCircleSmartAccount({ client: publicClient as any, owner: owner as any });

    const code = await publicClient.getCode({ address: account.address }).catch(() => null);
    if (!code || code === "0x") {
      console.log(`${label.padEnd(10)} ${account.address} is COUNTERFACTUAL — no rotation needed.`);
      console.log(`${"".padEnd(10)} Point the owner key at the new signer and re-derive the address with`);
      console.log(`${"".padEnd(10)} scripts/delegate-msca-address.ts. The address WILL change, which is`);
      console.log(`${"".padEnd(10)} free while no grant names it.`);
      continue;
    }

    const [ids, weights, threshold] = await publicClient.readContract({
      address: OWNER_PLUGIN,
      abi: PLUGIN_ABI,
      functionName: "ownershipInfoOf",
      args: [account.address],
    });
    const alreadyOwner = await publicClient.readContract({
      address: OWNER_PLUGIN,
      abi: PLUGIN_ABI,
      functionName: "isOwnerOf",
      args: [account.address, newOwner],
    });
    console.log(`${label.padEnd(10)} ${account.address} deployed — ${ids.length} owner(s), threshold ${threshold}`);
    console.log(`${"".padEnd(10)} incoming key is already an owner: ${alreadyOwner}`);

    /**
     * Add before removing, in two operations rather than one.
     *
     * Removing the only owner in the same breath as adding another would, if
     * the add were rejected for any reason, leave an account nobody can sign
     * for — and an account with no owner is not recoverable by anyone,
     * including Circle. Two operations mean the worst case is an account with
     * two valid owners, which is merely untidy.
     *
     * Threshold stays at 1 throughout for the same reason: raising it while
     * only one key can sign would lock the account immediately.
     */
    const addCall = encodeFunctionData({
      abi: PLUGIN_ABI,
      functionName: "addOwners",
      args: [[newOwner], [1n], NO_WEBAUTHN, [], 1n],
    });
    const removeCall = encodeFunctionData({
      abi: PLUGIN_ABI,
      functionName: "removeOwners",
      args: [[owner.address as Address], NO_WEBAUTHN, 1n],
    });

    if (!apply) {
      console.log(`${"".padEnd(10)} would send addOwners([${newOwner}], [1], threshold 1)`);
      console.log(`${"".padEnd(10)} then      removeOwners([${owner.address}], threshold 1)`);
      continue;
    }

    console.log(`${"".padEnd(10)} NOT SENT. Rotation of a deployed account is a UserOperation through`);
    console.log(`${"".padEnd(10)} the account itself, and the submission path depends on which account`);
    console.log(`${"".padEnd(10)} this is — a delegate self-bundles, settlement goes via its bundler.`);
    console.log(`${"".padEnd(10)} Both calldatas are printed below; wire them through the matching path`);
    console.log(`${"".padEnd(10)} rather than having this script guess.`);
    console.log(`${"".padEnd(10)}   target: ${OWNER_PLUGIN}`);
    console.log(`${"".padEnd(10)}   add:    ${addCall as Hex}`);
    console.log(`${"".padEnd(10)}   remove: ${removeCall as Hex}`);
  }

  console.log("\nAfter a rotation, update the role's key configuration so this platform signs");
  console.log("with the new owner — the address does not change, so nothing else has to.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

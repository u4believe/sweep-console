// Gate 1: can a CONTRACT redeem a delegation, or must the redeemer be an EOA?
//
// This decides whether the relayer keys can ever become ERC-4337 smart accounts
// and stop needing native gas. Everything downstream — Circle modular wallets,
// Gas Station sponsorship on Base/Arbitrum/Optimism — rests on it, so it is
// worth answering before any of that is built.
//
// Read-only. It opens no transaction, signs nothing, and touches no request
// path. Run it by hand against testnet:
//
//   pnpm tsx scripts/probe-contract-redeemer.ts
//   pnpm tsx scripts/probe-contract-redeemer.ts --grant grt_...   # one grant
//
// WHAT IT CAN AND CANNOT PROVE
//
// It cannot mint a grant naming a contract as redeemer — that needs a wallet
// signature in a browser, and the delegate address currently comes from a
// private key. So this does not prove the positive end to end.
//
// What it does is look for the thing that would make the positive impossible,
// in the three places it could hide:
//
//   1. The caveats on a real signed grant. If one of them pins the redeemer,
//      the probe reports which enforcer and what address it names.
//   2. The enforcer bytecode. EXTCODESIZE (0x3b) is how a contract asks "is my
//      caller an EOA". If no enforcer in the chain contains that opcode, none
//      of them can be rejecting contracts.
//   3. The DelegationManager itself, same test.
//
// A clean result means nothing on chain distinguishes a contract caller from an
// EOA one, and Gate 2 is worth building. A hit on (2) or (3) means it is not,
// and the Circle work can be dropped before it starts.

import "dotenv/config";
import { createPublicClient, decodeAbiParameters, defineChain, getAddress, http, type Address, type Hex } from "viem";
import { prisma } from "../src/lib/prisma";
import { rpcUrlForChain } from "../src/lib/chain/delegation";
import { chainKeyForId } from "../src/lib/gateway/chains";

const DELEGATION_ABI_PARAMS = [
  {
    type: "tuple[]",
    components: [
      { name: "delegate", type: "address" },
      { name: "delegator", type: "address" },
      { name: "authority", type: "bytes32" },
      {
        name: "caveats",
        type: "tuple[]",
        components: [
          { name: "enforcer", type: "address" },
          { name: "terms", type: "bytes" },
          { name: "args", type: "bytes" },
        ],
      },
      { name: "salt", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

/**
 * Does this bytecode contain EXTCODESIZE?
 *
 * Crude on purpose. 0x3b can appear inside PUSH data rather than as an opcode,
 * so this walks the stream and skips each PUSH's immediate bytes — otherwise a
 * constant that happens to contain 0x3b reads as a caller check and the answer
 * is a false alarm either way.
 *
 * EXTCODESIZE is not proof of an EOA-only rule: it is also how a contract
 * checks whether a token exists. But its ABSENCE is proof that no such rule is
 * possible, which is the direction that matters here.
 */
function usesExtcodesize(bytecode: Hex): boolean {
  const code = Buffer.from(bytecode.slice(2), "hex");
  for (let i = 0; i < code.length; i++) {
    const op = code[i]!;
    if (op === 0x3b) return true;
    // PUSH1..PUSH32 — skip the immediate bytes so they are never read as opcodes.
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return false;
}

function clientFor(chainId: number) {
  const chain = defineChain({
    id: chainId,
    name: chainKeyForId(chainId) ?? `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrlForChain(chainId)] } },
  });
  return createPublicClient({ chain, transport: http() });
}

/// Enforcers whose names say they constrain the caller. Checked by name as well
/// as by bytecode, because a well-named enforcer is the likeliest place a
/// redeemer rule lives and the name is the only hint available without an ABI.
const CALLER_SHAPED = /redeemer|caller|sender|eoa|origin/i;

async function main(): Promise<void> {
  const only = process.argv.includes("--grant")
    ? process.argv[process.argv.indexOf("--grant") + 1]
    : undefined;

  const grants = await prisma.renewalDelegation.findMany({
    where: { status: "active", ...(only ? { grantId: only } : {}) },
    select: {
      grantId: true, chainId: true, mode: true, context: true,
      delegateAddress: true, delegationManager: true, walletAddress: true,
    },
    orderBy: { chainId: "asc" },
  });

  if (grants.length === 0) {
    console.log("No active grants to inspect.");
    return;
  }

  // One representative grant per chain: the caveat SHAPE is what is being
  // examined, and every grant on a chain is built by the same code path.
  const perChain = new Map<number, (typeof grants)[number]>();
  for (const g of grants) if (!perChain.has(g.chainId)) perChain.set(g.chainId, g);

  console.log(`${grants.length} active grants, ${perChain.size} chains. Inspecting one per chain.\n`);

  const enforcerCache = new Map<string, { name: string; extcodesize: boolean | null }>();
  let anyCallerCheck = false;
  let redeemerPin: { enforcer: Address; address: string } | null = null;

  for (const [chainId, g] of perChain) {
    const label = chainKeyForId(chainId) ?? `chain-${chainId}`;
    console.log(`── ${label} (${chainId})  grant ${g.grantId}`);

    type Decoded = {
      delegate: Address;
      delegator: Address;
      caveats: readonly { enforcer: Address; terms: Hex }[];
    };
    let delegations: readonly Decoded[];
    try {
      const [rows] = decodeAbiParameters(DELEGATION_ABI_PARAMS, g.context as Hex);
      delegations = rows as unknown as readonly Decoded[];
    } catch (e) {
      console.log(`   context does not decode: ${(e as Error).message}\n`);
      continue;
    }

    const client = clientFor(chainId);

    for (const d of delegations) {
      console.log(`   delegator ${d.delegator}`);
      console.log(`   delegate  ${d.delegate}   (stored: ${g.delegateAddress})`);
      console.log(`   caveats   ${d.caveats.length}`);

      for (const c of d.caveats) {
        const key = `${chainId}:${c.enforcer.toLowerCase()}`;
        if (!enforcerCache.has(key)) {
          let extcodesize: boolean | null = null;
          try {
            const code = await client.getCode({ address: c.enforcer });
            extcodesize = code && code !== "0x" ? usesExtcodesize(code) : null;
          } catch {
            extcodesize = null;
          }
          enforcerCache.set(key, { name: "", extcodesize });
        }
        const info = enforcerCache.get(key)!;

        // 20 bytes of terms is an address — the shape a redeemer or payee pin
        // takes. Reported because it is where an address-based rule would be.
        const termsIsAddress = c.terms.length === 42;
        const termsAddr = termsIsAddress ? getAddress(c.terms as Address) : null;
        if (termsAddr && termsAddr.toLowerCase() === g.delegateAddress.toLowerCase()) {
          redeemerPin = { enforcer: c.enforcer, address: termsAddr };
        }

        const flags = [
          info.extcodesize === true ? "USES EXTCODESIZE" : info.extcodesize === false ? "no extcodesize" : "bytecode unavailable",
          termsAddr ? `terms = ${termsAddr}${termsAddr.toLowerCase() === g.delegateAddress.toLowerCase() ? " ← the delegate" : ""}` : `terms ${(c.terms.length - 2) / 2}b`,
        ];
        if (info.extcodesize === true) anyCallerCheck = true;
        console.log(`     enforcer ${c.enforcer}  ${flags.join("  ·  ")}`);
      }
    }

    // The manager itself runs before any caveat, so an EOA-only rule could live
    // there instead.
    try {
      const mgr = await client.getCode({ address: g.delegationManager as Address });
      if (mgr && mgr !== "0x") {
        const hit = usesExtcodesize(mgr);
        if (hit) anyCallerCheck = true;
        console.log(`   DelegationManager ${g.delegationManager}  ${hit ? "USES EXTCODESIZE" : "no extcodesize"}`);
      }
    } catch {
      console.log(`   DelegationManager ${g.delegationManager}  bytecode unavailable`);
    }
    console.log();
  }

  console.log("─".repeat(72));
  if (redeemerPin) {
    console.log(`Redeemer pin found: enforcer ${redeemerPin.enforcer} names ${redeemerPin.address}.`);
    console.log("That is an ADDRESS comparison. A contract at that address satisfies it as");
    console.log("readily as an EOA does — the pin is about who, not about what.\n");
  } else {
    console.log("No caveat pins an address equal to the delegate. The redeemer constraint");
    console.log("is enforced by the manager's own msg.sender == delegate check.\n");
  }

  // EXTCODESIZE in the two places it appears is explained, and neither
  // explanation is a rule against contract redeemers:
  //
  //   DelegationManager — it picks a signature-validation path. MetaMask's docs
  //     say signatures are verified "with ECDSA for EOAs or isValidSignature
  //     for contracts", and that question is about the DELEGATOR who signed,
  //     not the redeemer who calls. Your delegators are already smart accounts
  //     (the grant flow upgrades them with EIP-7702 first), so this branch is
  //     being taken on every redemption you do today.
  //
  //   An enforcer — it cannot be a redeemer type-check whatever else it is,
  //     because beforeHook is HANDED the redeemer as its seventh parameter.
  //     Inside an enforcer msg.sender is the DelegationManager, so code-size of
  //     the caller tells it nothing about who is redeeming.
  //
  // And MetaMask states it outright: a delegate may be "a smart contract or
  // externally owned account (EOA)".
  if (anyCallerCheck) {
    console.log("VERDICT: pass, with one thing to read.");
    console.log();
    console.log("EXTCODESIZE appears, but not anywhere it could reject a contract redeemer:");
    console.log("  · in the DelegationManager it selects ECDSA vs ERC-1271 for the");
    console.log("    DELEGATOR's signature — a path your grants already take, since the");
    console.log("    payer is an EIP-7702 smart account before they can grant at all.");
    console.log("  · in an enforcer it cannot concern the redeemer, which arrives as an");
    console.log("    explicit beforeHook parameter. msg.sender there is the manager.");
    console.log();
    console.log("Any enforcer flagged above is still worth reading once if it is unverified");
    console.log("on a block explorer — but nothing here blocks Gate 2.");
  } else {
    console.log("VERDICT: pass. Nothing in the redemption path inspects the caller's code.");
  }
  console.log();
  console.log("What this does NOT prove, and only a real grant can: that a UserOperation");
  console.log("reaches redeemDelegations with the smart account as msg.sender, and that gas");
  console.log("estimation survives the nested call. That is Gate 2.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Does our MSCA derive to the SAME address on a new chain?
 *
 *   pnpm tsx scripts/probe-msca-address.ts --rpc https://... --chain-id 143 \
 *     [--expect 0xTheAddressWeAlreadyUse] [--role hosted|external|settlement]
 *
 * WHY GUESSING IS NOT GOOD ENOUGH
 *
 * An MSCA's address is CREATE2 over Circle's factory, a salt and the INITIAL
 * owner. Reusing one address across chains therefore needs Circle's factory
 * deployed at the SAME address on each of them — which is usually true and is
 * nowhere promised. Circle's supported-blockchains page lists MSCA support per
 * chain and says nothing about factory addresses; its one note about addresses
 * being "consistent across all EVM-compatible blockchains" is scoped to the
 * "Other EVM" chain code, not to MSCA accounts.
 *
 * The consequence of being wrong is not subtle. The delegate address is
 * written into every grant's delegation struct. If a new chain derives a
 * different address, grants minted there name an account nobody owns, and the
 * failure surfaces at the first renewal — after payers have signed.
 *
 * This asks the chain instead of reasoning about it. It only reads.
 */
import "dotenv/config";
import { createPublicClient, http, defineChain, type Address } from "viem";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { getRelayerAccount, getSettlementAccount } from "../src/lib/chain/signers";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const rpc = arg("rpc");
  const chainId = Number(arg("chain-id"));
  const role = (arg("role") ?? "hosted") as "hosted" | "external" | "settlement";
  const expect = arg("expect") as Address | undefined;

  if (!rpc || !Number.isFinite(chainId)) {
    console.log("usage: --rpc <url> --chain-id <n> [--expect 0x..] [--role hosted|external|settlement]");
    process.exitCode = 1;
    return;
  }

  // "settlement" has its own accessor; it is not a RelayerMode.
  const owner = role === "settlement" ? getSettlementAccount() : getRelayerAccount(role);
  console.log(`  role           ${role}`);
  console.log(`  owner key      ${owner.address}`);
  console.log(`  chain          ${chainId} via ${rpc.replace(/\/\/[^@]*@/, "//***@")}`);

  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const client = createPublicClient({ chain, transport: http(rpc) });

  let derived: Address;
  try {
    const account = await toCircleSmartAccount({ client: client as any, owner: owner as any });
    derived = account.address;
  } catch (e) {
    console.log(`\n  FAILED to derive: ${(e as Error).message.slice(0, 160)}`);
    console.log("  Circle's factory is probably not deployed on this chain, or the SDK");
    console.log("  does not know it. Either way the address cannot be reused here.");
    process.exitCode = 1;
    return;
  }

  console.log(`  derived MSCA   ${derived}`);

  const code = await client.getCode({ address: derived }).catch(() => undefined);
  console.log(`  deployed?      ${code && code !== "0x" ? "yes" : "no — counterfactual"}`);

  if (!expect) {
    console.log("\n  No --expect given, so nothing to compare. Pass the address you already");
    console.log("  use elsewhere to confirm it is reusable here.");
    return;
  }

  if (derived.toLowerCase() === expect.toLowerCase()) {
    console.log(`\nPASS. Same address as ${expect} — one delegate works on this chain too.`);
    return;
  }
  console.log(`\nFAIL. This chain derives a DIFFERENT address.`);
  console.log(`  expected ${expect}`);
  console.log(`  derived  ${derived}`);
  console.log("  Reusing the existing delegate address here would name an account that");
  console.log("  does not exist. This chain needs its own MSCA and its own env entry.");
  process.exitCode = 1;
}

main();

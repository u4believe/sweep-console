// What is funded, and what still is not, before the first live charge.
//
//   ARC_NETWORK=mainnet pnpm tsx scripts/check-mainnet-funding.ts
//
// Read-only. It reads balances and nothing else.
//
// WHAT EACH ACCOUNT NEEDS, AND WHY IT DIFFERS
//
// The settlement MSCA needs NO USDC float. The first version of this script
// reported an empty settlement balance as "nothing to bridge", which inverts
// the design: the USDC arrives WITH the payment, and the paymaster's gas is
// topped up out of the platform's own fee toward SETTLEMENT_GAS_FLOOR_USDC
// (settlement-userop.ts). Pre-funding it would be the hand-managed float that
// design exists to avoid.
//
// It needs ETH on Optimism ONLY: Base and Arbitrum take gas from USDC through
// Circle Paymaster v0.7, which is not deployed on Optimism — verified
// on-chain by check-mainnet-addresses.ts.
//
// The delegate MSCAs self-bundle, which means they call handleOps themselves
// and pay that transaction's gas in native ETH on every chain. No paymaster is
// involved there at all, so they need ETH on all three.
//
// Nothing needs a balance before its first use: all three are counterfactual
// and deploy via initCode. "not deployed" below is the expected state of an
// account that has not settled or redeemed yet, not a problem to fix.

import "dotenv/config";
import { createPublicClient, formatEther, formatUnits, http, getAddress, type Address } from "viem";
import { base, arbitrum, optimism } from "viem/chains";
import { isMainnet } from "../src/lib/gateway/chains";

const CHAINS = [
  { key: "base", chain: base, rpc: "https://mainnet.base.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", needsEth: false },
  { key: "arbitrum", chain: arbitrum, rpc: "https://arb1.arbitrum.io/rpc", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", needsEth: false },
  { key: "optimism", chain: optimism, rpc: "https://mainnet.optimism.io", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", needsEth: true },
];

const BALANCE_OF = "0x70a08231";
/// EntryPoint v0.7 — where a smart account's gas actually sits.
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

/**
 * Only the `call` is needed, so only `call` is required.
 *
 * ReturnType<typeof createPublicClient> is the generic client, and a client
 * built with a concrete chain is not assignable to it. Asking for the one
 * method this uses sidesteps that without casting the whole client away.
 */
type Caller = { call: (args: { to: Address; data: `0x${string}` }) => Promise<{ data?: `0x${string}` | undefined }> };

/// balanceOf(address) on the EntryPoint is that account's gas deposit.
async function entryPointDeposit(client: Caller, account: string): Promise<bigint> {
  const data = `${BALANCE_OF}${account.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
  const r = await client.call({ to: getAddress(ENTRY_POINT) as Address, data });
  return r.data && r.data !== "0x" ? BigInt(r.data) : 0n;
}

async function usdcOf(client: Caller, token: string, who: string): Promise<bigint> {
  const data = `${BALANCE_OF}${who.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
  const r = await client.call({ to: getAddress(token) as Address, data });
  return r.data && r.data !== "0x" ? BigInt(r.data) : 0n;
}

async function main(): Promise<void> {
  if (!isMainnet()) {
    console.log("ARC_NETWORK is not 'mainnet'. Re-run as:\n");
    console.log("  ARC_NETWORK=mainnet pnpm tsx scripts/check-mainnet-funding.ts");
    process.exitCode = 1;
    return;
  }

  const settlement = process.env.SETTLEMENT_MSCA_ADDRESS;
  // [label, the MSCA whose deposit pays, the OWNER whose ETH funds it]
  const { getRelayerAccount } = await import("../src/lib/chain/signers");
  const ownerOf = (mode: "hosted" | "external"): string | undefined => {
    try {
      return getRelayerAccount(mode).address;
    } catch {
      return undefined;
    }
  };
  const delegates = [
    ["renewal", process.env.RENEWAL_DELEGATE_MSCA_ADDRESS, ownerOf("hosted")],
    ["external", process.env.EXTERNAL_RELAYER_MSCA_ADDRESS, ownerOf("external")],
  ] as const;

  if (!settlement) {
    console.log("SETTLEMENT_MSCA_ADDRESS is not set — nothing to check.");
    process.exitCode = 1;
    return;
  }

  /// The floor settlement keeps back out of the platform fee to pay the
  /// paymaster with. Reported so a funding decision can see it.
  const gasFloor = process.env.SETTLEMENT_GAS_FLOOR_USDC ?? "0.10";
  const ethFloor = process.env.DELEGATE_MSCA_DEPOSIT_FLOOR_ETH ?? "0.002";

  console.log(`settlement MSCA  ${settlement}`);
  console.log(`gas floor        ${gasFloor} USDC (from the platform fee, never the merchant's share)\n`);

  let short = 0;

  for (const { key, chain, rpc, usdc, needsEth } of CHAINS) {
    const client = createPublicClient({ chain, transport: http(process.env[`RPC_URL_${chain.id}`] ?? rpc) });
    console.log(`${key} (${chain.id})`);

    const code = await client.getCode({ address: getAddress(settlement) as Address }).catch(() => null);
    const bal = await usdcOf(client, usdc, settlement).catch(() => -1n);
    const eth = await client.getBalance({ address: getAddress(settlement) as Address }).catch(() => -1n);

    console.log(`  settlement   USDC ${bal < 0n ? "(read failed)" : formatUnits(bal, 6)}   ETH ${eth < 0n ? "?" : formatEther(eth)}   ${code && code !== "0x" ? "deployed" : "not deployed (expected before first use)"}`);

    // An empty settlement balance is the NORMAL resting state, not a gap:
    // each payment finishes having bridged everything it brought.
    if (bal === 0n) {
      console.log(`               (no USDC — expected: it arrives with each payment)`);
    }
    if (needsEth && eth === 0n) {
      console.log(`               ^ no ETH — ${key} has no Circle Paymaster, so it pays its own gas`);
      short++;
    }
    if (!needsEth && eth > 0n) {
      console.log(`               (ETH here is unused: Base and Arbitrum take gas from USDC)`);
    }

    for (const [name, msca, owner] of delegates) {
      if (!owner) {
        console.log(`  ${name.padEnd(12)} (key not set)`);
        continue;
      }
      const oEth = await client.getBalance({ address: getAddress(owner) as Address }).catch(() => -1n);
      const dep = msca ? await entryPointDeposit(client, msca).catch(() => -1n) : -1n;
      const needed = BigInt(Math.floor(Number(ethFloor) * 1e18));
      // Fund the OWNER; the deposit is what it has already moved in. Either
      // alone can be zero; both zero means the next redeem cannot pay.
      const dry = oEth >= 0n && oEth < needed && (dep < 0n || dep < needed);
      console.log(
        `  ${name.padEnd(12)} owner ${owner.slice(0, 10)}…  ETH ${oEth < 0n ? "?" : formatEther(oEth)}` +
          `   deposited ${dep < 0n ? "?" : formatEther(dep)}`
      );
      if (dry) {
        console.log(`               ^ fund the OWNER — it sends depositTo and pays that gas`);
        short++;
      }
    }
    console.log();
  }

  console.log(
    short === 0
      ? "Funded. Every account has what the first charge on its chain will need."
      : `${short} account/chain pair(s) still need funding. A charge routed to one of them fails at settlement.`
  );
}

void main();

// Derive the settlement MSCA address, for SETTLEMENT_MSCA_ADDRESS.
//
//   pnpm tsx scripts/settlement-msca-address.ts
//
// Read-only. The address is counterfactual — it exists as an address before
// any contract is deployed there, and the first settlement deploys it via
// initCode. It is identical on every chain, because CREATE2 with one factory
// and one salt puts it in the same place everywhere.
import "dotenv/config";
import { createPublicClient, defineChain, http } from "viem";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { rpcUrlForChain } from "../src/lib/chain/delegation";
import { supportedSourceChains, chainKeyForId } from "../src/lib/gateway/chains";
import { getSettlementAccount } from "../src/lib/chain/signers";

async function main() {
  const owner = getSettlementAccount();
  console.log(`owner (settlement key)  ${owner.address}\n`);
  let seen: string | null = null;
  for (const source of supportedSourceChains()) {
    const id = source.chain.id;
    const chain = defineChain({
      id,
      name: chainKeyForId(id) ?? String(id),
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrlForChain(id)] } },
    });
    const client = createPublicClient({ chain, transport: http(rpcUrlForChain(id)) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = await toCircleSmartAccount({ client: client as any, owner: owner as any });
    const code = await client.getCode({ address: account.address });
    console.log(
      `  ${(chainKeyForId(id) ?? id).toString().padEnd(10)} ${account.address}  ${code && code !== "0x" ? "deployed" : "counterfactual"}`
    );
    if (seen && seen !== account.address) console.log("    ^ DIFFERS from the other chains — do not use one env var");
    seen = account.address;
  }
  console.log(`\nSETTLEMENT_MSCA_ADDRESS=${seen}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

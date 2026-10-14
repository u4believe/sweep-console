// Derive the delegate MSCA addresses, for RENEWAL_DELEGATE_MSCA_ADDRESS and
// EXTERNAL_RELAYER_MSCA_ADDRESS.
//
//   pnpm tsx scripts/delegate-msca-address.ts
//
// Read-only. Counterfactual — the address exists before any contract is there,
// and the first redeem deploys it via initCode. Identical on every chain.
import "dotenv/config";
import { createPublicClient, defineChain, http } from "viem";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { rpcUrlForChain } from "../src/lib/chain/delegation";
import { getRelayerAccount } from "../src/lib/chain/signers";
import { supportedSourceChains, chainKeyForId } from "../src/lib/gateway/chains";

async function main() {
  for (const mode of ["hosted", "external"] as const) {
    const owner = getRelayerAccount(mode);
    const env = mode === "external" ? "EXTERNAL_RELAYER_MSCA_ADDRESS" : "RENEWAL_DELEGATE_MSCA_ADDRESS";
    console.log(`\n${mode} delegate — owner ${owner.address}`);
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
      const code = await client.getCode({ address: account.address }).catch(() => null);
      console.log(
        `  ${(chainKeyForId(id) ?? id).toString().padEnd(10)} ${account.address}  ${code && code !== "0x" ? "deployed" : "counterfactual"}`
      );
      if (seen && seen !== account.address) console.log("    ^ DIFFERS — do not use one env var");
      seen = account.address;
    }
    console.log(`  ${env}=${seen}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

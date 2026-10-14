// Verify an AWS KMS settlement key and print the configuration it implies.
//
//   KMS_REGION=eu-west-1 pnpm tsx scripts/setup-kms-settlement.ts --key <arn-or-id>
//
// Read-only: it signs one throwaway digest and reads a public key. Nothing is
// deployed and no funds move.
//
// THE ADDRESS WILL CHANGE, AND THAT IS FINE TODAY
//
// A KMS key is a NEW keypair — AWS generates it and the private half never
// leaves. So the settlement MSCA derived from it is a DIFFERENT address from
// the one derived from SETTLEMENT_PRIVATE_KEY. That is free right now, because
// no grant pins the settlement MSCA yet: the fourteen that pinned the old EOA
// were revoked, and the thirteen still active carry no payee caveat at all.
//
// It stops being free the moment a grant names it. Then changing the owner is
// addOwners/removeOwners on the deployed account, which keeps the address —
// which is the whole reason settlement is an MSCA rather than an EOA.
//
// So: run this, set what it prints, and test a checkout. In that order.

import "dotenv/config";
import { createPublicClient, defineChain, http } from "viem";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { awsKmsAddress, kmsSignerFromEnv, toKmsAccount } from "../src/lib/chain/kms-signer";
import { rpcUrlForChain } from "../src/lib/chain/delegation";
import { supportedSourceChains, chainKeyForId } from "../src/lib/gateway/chains";
import { keccak256, type Hex } from "viem";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const keyId = arg("key") ?? process.env.KMS_KEY_SETTLEMENT;
  if (!keyId) throw new Error("--key <arn-or-id> is required (or set KMS_KEY_SETTLEMENT)");
  if (!process.env.KMS_REGION && !process.env.AWS_REGION) {
    throw new Error("set KMS_REGION (or AWS_REGION) to the key's region");
  }

  console.log(`key    ${keyId}`);
  console.log(`region ${process.env.KMS_REGION ?? process.env.AWS_REGION}\n`);

  // 1. The address, from the key's public half.
  const address = await awsKmsAddress(keyId);
  console.log(`owner address derived from the key: ${address}`);

  // 2. Prove it can sign, and that the signature recovers to that address.
  //    toKmsAccount throws if it does not, so reaching the next line is the
  //    proof — a key in the wrong region or an IAM policy missing kms:Sign
  //    fails here rather than at the first real settlement.
  //    Built through kmsSignerFromEnv, so this exercises the production path
  //    rather than a parallel one that could drift from it.
  process.env.KMS_PROVIDER = "aws";
  process.env.KMS_KEY_SETTLEMENT = keyId;
  process.env.KMS_ADDRESS_SETTLEMENT = address;
  const signer = kmsSignerFromEnv("settlement");
  if (!signer) throw new Error("kmsSignerFromEnv returned null with KMS_PROVIDER=aws");
  const account = toKmsAccount(signer);
  const digest = keccak256("0x736574757020636865636b" as Hex);
  await account.sign!({ hash: digest });
  console.log(`signing works, and the signature recovers to that address`);

  // 3. The MSCA this owner implies, on each source chain.
  console.log();
  let msca: string | null = null;
  for (const source of supportedSourceChains()) {
    const id = source.chain.id;
    const rpc = rpcUrlForChain(id);
    const chain = defineChain({
      id,
      name: chainKeyForId(id) ?? String(id),
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
    const client = createPublicClient({ chain, transport: http(rpc) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sa = await toCircleSmartAccount({ client: client as any, owner: account as any });
    const code = await client.getCode({ address: sa.address }).catch(() => null);
    console.log(
      `  ${(chainKeyForId(id) ?? id).toString().padEnd(10)} MSCA ${sa.address}  ${code && code !== "0x" ? "deployed" : "counterfactual"}`
    );
    if (msca && msca !== sa.address) console.log("    ^ DIFFERS — do not use one env var");
    msca = sa.address;
  }

  const old = process.env.SETTLEMENT_MSCA_ADDRESS;
  console.log(`\nSet these:`);
  console.log(`  KMS_PROVIDER=aws`);
  console.log(`  KMS_REGION=${process.env.KMS_REGION ?? process.env.AWS_REGION}`);
  console.log(`  KMS_KEY_SETTLEMENT=${keyId}`);
  console.log(`  KMS_ADDRESS_SETTLEMENT=${address}`);
  console.log(`  SETTLEMENT_MSCA_ADDRESS=${msca}`);
  console.log(`  SETTLEMENT_MSCA_ENABLED=true`);
  if (old && msca && old.toLowerCase() !== msca.toLowerCase()) {
    console.log(`\nNote: SETTLEMENT_MSCA_ADDRESS currently reads ${old}, which came from`);
    console.log(`SETTLEMENT_PRIVATE_KEY. It must be replaced with the value above — a KMS key is a`);
    console.log(`different keypair, so it derives a different account. Free while nothing pins it.`);
  }
  console.log(`\nSETTLEMENT_PRIVATE_KEY is then unused for signing. Leave it set until a`);
  console.log(`settlement has run through KMS, then remove it — and remember the old MSCA may`);
  console.log(`still hold testnet USDC worth sweeping first.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

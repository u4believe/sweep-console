// Prove the KMS signature plumbing before any cloud account exists.
//
//   pnpm tsx scripts/check-kms-signer.ts
//
// Uses localTestSigner, which returns only r and s — no recovery id — and
// deliberately pushes s into the upper half of the curve order on half the
// digests. So every pass exercises the normalisation and the recovery-id
// search for real. If this is green, a provider adapter is all that remains.
import "dotenv/config";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  hashMessage, hashTypedData, keccak256, recoverAddress, recoverMessageAddress,
  recoverTypedDataAddress, serializeTransaction, parseTransaction, parseEther, type Hex,
} from "viem";
import { localTestSigner, toKmsAccount } from "../src/lib/chain/kms-signer";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

async function main() {
  const pk = generatePrivateKey();
  const reference = privateKeyToAccount(pk);
  const kms = toKmsAccount(await localTestSigner(pk));

  check("address matches the key", kms.address === reference.address);
  check("reports type local (the SDKs check this)", kms.type === "local");
  check("exposes raw sign", typeof kms.sign === "function");
  check("exposes signTransaction", typeof kms.signTransaction === "function");

  // Many digests, so both s-halves and both recovery ids are hit.
  let recovered = 0;
  for (let i = 0; i < 40; i++) {
    const digest = keccak256(`0x${i.toString(16).padStart(64, "0")}` as Hex);
    const sig = await kms.sign!({ hash: digest });
    const addr = await recoverAddress({ hash: digest, signature: sig });
    if (addr.toLowerCase() === reference.address.toLowerCase()) recovered++;
    // s must be in the lower half, per EIP-2.
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    if (s > 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n / 2n) {
      check(`digest ${i}: s is low-half`, false, `s=${s}`);
    }
  }
  check(`40/40 raw digests recover to the right address`, recovered === 40, `got ${recovered}`);

  const msg = "settlement owner rotation test";
  check(
    "signMessage recovers",
    (await recoverMessageAddress({ message: msg, signature: await kms.signMessage({ message: msg }) })).toLowerCase() ===
      reference.address.toLowerCase()
  );

  const typed = {
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const },
    types: { Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" },
      { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ] },
    primaryType: "Permit" as const,
    message: {
      owner: reference.address, spender: reference.address,
      value: 1000000n, nonce: 0n, deadline: 2n ** 256n - 1n,
    },
  };
  check(
    "signTypedData recovers (the Circle Paymaster permit)",
    (await recoverTypedDataAddress({ ...typed, signature: await kms.signTypedData(typed) })).toLowerCase() ===
      reference.address.toLowerCase()
  );
  check(
    "signTypedData matches the local key byte for byte",
    (await kms.signTypedData(typed)) === (await reference.signTypedData(typed))
  );

  // The submitter's job: an ordinary transaction.
  const tx = {
    to: reference.address, value: parseEther("0.001"), chainId: 84532,
    nonce: 7, gas: 21000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n,
    type: "eip1559" as const,
  };
  const serialized = await kms.signTransaction!(tx);
  const parsed = parseTransaction(serialized);
  const txSender = await recoverAddress({
    hash: keccak256(serializeTransaction(tx)),
    signature: { r: parsed.r!, s: parsed.s!, v: parsed.v! },
  });
  check("signTransaction recovers to the owner", txSender.toLowerCase() === reference.address.toLowerCase());
  check(
    "signTransaction matches the local key byte for byte",
    serialized === (await reference.signTransaction(tx))
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

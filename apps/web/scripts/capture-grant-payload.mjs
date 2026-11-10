/**
 * Print the exact JSON-RPC payload a grant sends, without a browser.
 *
 * "What do we actually send?" has been the central question of this
 * migration, and for weeks the only way to answer it was to open a checkout,
 * fail a grant, and read a minified stack. The kit builds the payload from
 * buildPeriodicPermission's output, so a fake transport that captures
 * wallet_requestExecutionPermissions answers it offline and exactly.
 *
 * This is how the kit 1.6.0 -> 2.0.0 upgrade was cleared: both versions emit
 * byte-identical payloads, so the upgrade could not explain a new field in
 * MetaMask's prompt.
 *
 *   node scripts/capture-grant-payload.mjs
 */
import { createWalletClient, custom } from "viem";
import { erc7715ProviderActions } from "@metamask/smart-accounts-kit/actions";

const DELEGATE = "0x5947B31Deb2907594Cea0af63a2AE137FE5cf0EE";
const CREATOR_LOWER = "0x18e0699ee5c7dd9d558d56f0c2b2f6c3a5b6747f";
const CREATOR_BADSUM = "0x18e0699Ee5c7dd9d558d56F0c2b2f6c3a5B6747f";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function build({ payees, allowAdjustment, omitStartTime }) {
  return {
    chainId: 8453,
    to: DELEGATE,
    expiry: 1800000000,
    redeemer: [DELEGATE],
    ...(payees?.length ? { payee: payees } : {}),
    permission: {
      type: "erc20-token-periodic",
      isAdjustmentAllowed: allowAdjustment ?? false,
      data: {
        tokenAddress: TOKEN,
        periodAmount: 5000000n,
        periodDuration: 2592000,
        ...(omitStartTime ? {} : { startTime: 1762600000 }),
        justification: "Monthly subscription",
      },
    },
  };
}

async function capture(label, request) {
  let captured = null;
  const transport = custom({
    async request({ method, params }) {
      if (method === "wallet_requestExecutionPermissions") {
        captured = params;
        return [];
      }
      if (method === "wallet_getSupportedExecutionPermissions") return { chainIds: ["0x2105"] };
      return null;
    },
  });
  try {
    const client = createWalletClient({ transport }).extend(erc7715ProviderActions());
    await client.requestExecutionPermissions([request]);
  } catch (e) {
    if (!captured) {
      console.log(`${label}: could not capture — ${e.message.split("\n")[0]}`);
      return;
    }
  }
  const rules = (captured?.[0]?.rules ?? []).map((r) => r.type).join(", ");
  console.log(`\n===== ${label} =====`);
  console.log(`  to:    ${captured?.[0]?.to}`);
  console.log(`  rules: ${rules || "(none)"}`);
  console.log(JSON.stringify(captured, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

import { getAddress } from "viem";

await capture("no payee (what we send now)", build({ payees: [] }));
await capture("one payee, lowercase", build({ payees: [CREATOR_LOWER] }));
await capture("one payee, correct checksum", build({ payees: [getAddress(CREATOR_LOWER)] }));
await capture("one payee, WRONG checksum", build({ payees: [CREATOR_BADSUM] }));
await capture("two payees, both valid", build({ payees: [getAddress(CREATOR_LOWER), getAddress("0x4b6b75fbcbf4d1b0e1ec9e0d1c5b8a3f6e2d7c91")] }));

// MetaMask's documented example: isAdjustmentAllowed true, no startTime.
await capture("GRANT_ALLOW_ADJUSTMENT=true", build({ payees: [], allowAdjustment: true }));
await capture("GRANT_OMIT_START_TIME=true", build({ payees: [], omitStartTime: true }));
await capture("both, ie the documented shape", build({ payees: [], allowAdjustment: true, omitStartTime: true }));

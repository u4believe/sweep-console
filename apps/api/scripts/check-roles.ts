import "dotenv/config";
import { getRelayerAccount, getGasRelayerAccount, settlementIsSeparate } from "../src/lib/chain/signers";
import { delegateAddressForNewGrant, delegateMscaAddress, delegateMscaEnabled } from "../src/lib/chain/delegate-msca";

/**
 * Which address each role resolves to, and which one a grant names.
 *
 * The admin balances page lists a row per role, and a role whose key differs
 * from the funded address sends an operator to top up a wallet that pays for
 * nothing. More importantly for the grant: delegateAddressForNewGrant is the
 * `to` every subscriber signs, and if the key behind it is not the key that
 * redeems, the grant is unredeemable by us however cleanly it signs.
 */
function show(label: string, f: () => string | null | undefined) {
  let v: string | null | undefined;
  try { v = f(); } catch (e) { v = `THREW: ${(e as Error).message.split("\n")[0].slice(0, 70)}`; }
  console.log(`  ${label.padEnd(38)} ${v ?? "(none)"}`);
}

console.log("keys present");
for (const k of ["RENEWAL_DELEGATE_PRIVATE_KEY","EXTERNAL_RELAYER_PRIVATE_KEY","GAS_RELAYER_PRIVATE_KEY","PLATFORM_PRIVATE_KEY","KMS_PROVIDER","KMS_KEY_HOSTED","KMS_KEY_EXTERNAL","KMS_KEY_SETTLEMENT","KMS_KEY_GAS"]) {
  console.log(`  ${k.padEnd(38)} ${process.env[k] ? "set" : "(unset)"}`);
}

console.log("\nrole -> address");
show('getRelayerAccount("hosted")  [Renewal row]', () => getRelayerAccount("hosted").address);
show('getRelayerAccount("external") [External row]', () => getRelayerAccount("external").address);
show("getGasRelayerAccount()", () => getGasRelayerAccount()?.address ?? null);
show("settlementIsSeparate()", () => String(settlementIsSeparate()));

console.log("\nwhat a NEW grant names as `to`");
show("DELEGATE_MSCA_ENABLED", () => String(delegateMscaEnabled()));
show('delegateMscaAddress("hosted")', () => delegateMscaAddress("hosted"));
show('delegateMscaAddress("external")', () => delegateMscaAddress("external"));
show('delegateAddressForNewGrant("hosted")', () => delegateAddressForNewGrant("hosted"));
show('delegateAddressForNewGrant("external")', () => delegateAddressForNewGrant("external"));

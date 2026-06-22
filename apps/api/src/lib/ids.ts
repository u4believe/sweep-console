import { randomBytes } from "crypto";

function randomHex(bytes: number) {
  return randomBytes(bytes).toString("hex");
}

export const ids = {
  merchant: ()      => `${randomHex(2).toUpperCase()}-${randomHex(2).toUpperCase()}-${randomHex(2).toUpperCase()}`,
  plan: (slug: string) => `plan_${slug}_${randomHex(3)}`,
  session: (live: boolean) => `cs_${live ? "live" : "test"}_${randomHex(10)}`,
  sessionToken: () => randomHex(24),
  subscription: () => `sub_${randomHex(10)}`,
  payment: ()      => `pay_${randomHex(10)}`,
  passport: ()     => `pass_${randomHex(10)}`,
  webhook: ()      => `we_${randomHex(10)}`,
  event: ()        => `evt_${randomHex(8)}`,
  sweep: ()        => `swp_${randomHex(10)}`,
  paymentLink: ()  => `plink_${randomHex(10)}`,
  customer: ()     => `cus_${randomHex(10)}`,
  apiKey: (live: boolean) => `${live ? "live" : "test"}_${randomHex(24)}`,

  // Converts a platform subscription ID to a bytes32 for the smart contract
  toBytes32: (subscriptionId: string): `0x${string}` => {
    const hex = Buffer.from(subscriptionId).toString("hex").padEnd(64, "0").slice(0, 64);
    return `0x${hex}`;
  },
};

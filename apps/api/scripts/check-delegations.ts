// Run the delegation watch once, by hand.
//
//   pnpm tsx scripts/check-delegations.ts
//
// Same code the billing worker runs every ten minutes. Read-only.
import "dotenv/config";
import { checkRelayerDelegationsOnce } from "../src/billing/delegation-watch";

checkRelayerDelegationsOnce()
  .then((unexpected) => {
    console.log(`\n${unexpected.length} unexpected delegation(s).`);
    process.exitCode = unexpected.length > 0 ? 1 : 0;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });

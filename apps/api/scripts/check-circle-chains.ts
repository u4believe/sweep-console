/**
 * Which creators' payout wallets can actually be read on every chain we pay on?
 *
 *   ARC_NETWORK=mainnet pnpm tsx scripts/check-circle-chains.ts
 *
 * Read-only. Reports; changes nothing.
 *
 * WHY THIS IS NOT COSMETIC. Under direct settlement a creator is paid on
 * whichever chain their subscriber holds USDC on. A Circle EOA has ONE EVM
 * address, so the money arrives whatever Circle has registered — but Circle's
 * /balances and its withdrawal are per-chain. A wallet registered only on Arc
 * therefore reads EMPTY while holding real USDC, the dashboard shows nothing,
 * and withdrawal refuses with "No USDC balance found in your wallet" over
 * money that is demonstrably there.
 *
 * That is step 6 of the rollout plan, and it is a PREREQUISITE rather than a
 * follow-up: every Circle-wallet creator is in this state until it runs.
 * External verified EOAs are unaffected — they were never Circle's to read.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { circleBlockchains, readCreatorWalletChains } from "../src/lib/circle";
import { isMainnet } from "../src/lib/gateway/chains";

const usdc = (n: bigint) => (Number(n) / 1e6).toFixed(2).padStart(9);

async function main(): Promise<void> {
  const live = isMainnet();
  const want = circleBlockchains();
  console.log(`network   ${live ? "mainnet" : "testnet"}`);
  console.log(`chains    ${want.join(", ")}\n`);

  // The column that holds the Circle wallet IS the mode, as merchant-wallet.ts
  // reads it: circleWalletId for test, liveCircleWalletId for live.
  const merchants = await prisma.merchant.findMany({
    where: live ? { liveCircleWalletId: { not: null } } : { circleWalletId: { not: null } },
    select: { id: true, merchantId: true, name: true, circleWalletId: true, liveCircleWalletId: true },
  });

  if (merchants.length === 0) {
    console.log("No Circle-wallet merchants in this mode — nothing to register.");
    return;
  }

  let needRepair = 0;
  let unread = 0;
  let splitAddresses = 0;
  let eoaRemaining = 0;
  let strandedTotal = 0n;

  for (const m of merchants) {
    const r = await readCreatorWalletChains(m.id);
    const who = `${(m.name ?? m.merchantId).slice(0, 26).padEnd(26)}`;
    if (!r.ok) {
      // A failed read is not a clean wallet. Counting these as "ok" is how a
      // misconfigured API key reads as a passing check.
      unread++;
      console.log(`  ${who} READ FAILED  ${r.reason.slice(0, 60)}`);
      continue;
    }
    const have = r.chains.map((c) => `${c.blockchain}=${usdc(c.usdc).trim()}${c.read ? "" : "?"}`);
    const flag = r.missing.length > 0 ? "NEEDS REGISTRATION" : !r.oneAddress ? "SPLIT ADDRESSES" : "ok";
    console.log(`  ${who} ${flag.padEnd(19)} total ${usdc(r.total)}  [${have.join(" ") || "none"}]`);

    /**
     * THE QUESTION THIS CHECK EXISTS TO SETTLE, now that wallets are SCA.
     *
     * The payout address is pinned into every subscriber's grant, so one
     * address per creator means one pin. Confirmed with Circle (7 Nov 2026)
     * that an SCA shares one address across EVM chains, as an EOA does — the
     * docs imply it without saying SCA, so it was confirmed directly.
     *
     * Reported anyway: a confirmation is about how Circle behaves today, and
     * this is the fact a wrongly-pinned payee would turn on.
     *
     * Several addresses is not a failure of the wallet; it is a finding that
     * changes settlementPayees(), which pins ONE creator address for every
     * chain. Grant targets are already per chain, so the fix is contained —
     * but it has to land before any grant is signed against the wrong one.
     */
    const types = [...new Set(r.chains.map((c) => c.accountType ?? "?"))];
    console.log(
      `${" ".repeat(29)}address${r.oneAddress ? "" : "es"}: ${r.addresses.join(", ") || "none"}` +
        `  ·  accountType: ${types.join(", ") || "unknown"}`
    );
    if (!r.oneAddress) {
      splitAddresses++;
      console.log(
        `${" ".repeat(29)}^ ONE PIN WILL NOT COVER THESE. settlementPayees() pins a single` +
          ` creator address for every chain and must become per-chain first.`
      );
    }
    const mixed = r.chains.filter((c) => (c.accountType ?? "").toUpperCase() === "EOA");
    if (mixed.length > 0) {
      eoaRemaining++;
      console.log(
        `${" ".repeat(29)}^ still EOA on ${mixed.map((c) => c.blockchain).join(", ")} —` +
          ` Gas Station cannot sponsor those withdrawals`
      );
    }
    if (r.missing.length > 0) {
      needRepair++;
      strandedTotal += r.total;
      console.log(`${" ".repeat(29)}missing: ${r.missing.join(", ")}`);
    }
  }

  const checked = merchants.length - unread;
  console.log(
    `\n${needRepair} of ${checked} checked wallet(s) are not registered on every chain we pay on.`
  );
  if (unread > 0) {
    console.log(
      `${unread} wallet(s) COULD NOT BE READ, so their state is unknown — not clean. ` +
        `Fix the read before trusting this check.`
    );
    process.exitCode = 1;
  }
  if (splitAddresses > 0) {
    console.log(
      `\n${splitAddresses} wallet(s) hold DIFFERENT addresses per chain. A grant pins one payout\n` +
        `address, so settlementPayees() has to resolve per chain before step 9 re-authorization.`
    );
    process.exitCode = 1;
  }
  if (eoaRemaining > 0) {
    console.log(
      `\n${eoaRemaining} wallet(s) are still EOA. Gas Station needs an ERC-4337 smart contract\n` +
        `account, so those creators pay their own withdrawal gas until they re-run wallet setup\n` +
        `— which gives them a NEW address, and so needs their subscribers to re-authorize.`
    );
  }
  if (needRepair > 0) {
    console.log(
      "Those creators cannot see or withdraw USDC paid to them on the missing chains.\n" +
        "Registering is a PIN challenge the creator completes — createCircleWalletForExistingUser\n" +
        "now asks for every chain in circleBlockchains(), so a creator who re-runs wallet setup\n" +
        "gets the rest. There is no server-only path: the PIN is theirs."
    );
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main();

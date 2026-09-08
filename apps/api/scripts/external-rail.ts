// Grant or withdraw a merchant's access to the external payment rail
// (/v1/mandates, /v1/charges), which Merchant.externalRailEnabled gates.
//
//   pnpm tsx scripts/external-rail.ts                            # who has it today
//   pnpm tsx scripts/external-rail.ts ada@example.com --on       # dry run
//   pnpm tsx scripts/external-rail.ts ada@example.com --on --write
//   pnpm tsx scripts/external-rail.ts A1B2-C3D4-E5F6 --off --write
//
// Deliberately a script rather than a portal setting. The rail is an entitlement
// this platform grants, not a preference a developer sets: it is the first surface
// where a leaked API key moves money to the holder, and risk 06 (payment-facilitator
// posture) is not settled. A self-serve switch would make the gate decorative.
//
// Dry run by default, like the backfills — the write is one row, but it is the row
// that decides whether an account can charge.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";

/// The Supabase transaction pooler refuses a connection now and then.
async function retry<T>(f: () => Promise<T>, n = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= n) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function list() {
  const on = await retry(() =>
    prisma.merchant.findMany({
      where: { externalRailEnabled: true },
      select: { merchantId: true, email: true, name: true },
      orderBy: { createdAt: "asc" },
    })
  );
  const total = await retry(() => prisma.merchant.count());
  console.log(`merchants with the external rail enabled: ${on.length} of ${total}\n`);
  for (const m of on) console.log(`  ${m.merchantId}  ${m.email}  (${m.name})`);
  if (on.length === 0) console.log("  (none)");
  console.log(`\nTo grant it:  pnpm tsx scripts/external-rail.ts <email|merchantId> --on --write`);
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const on = args.includes("--on");
  const off = args.includes("--off");
  const target = args.find((a) => !a.startsWith("--"));

  if (!target) {
    await list();
    return;
  }
  if (on === off) {
    console.error("Pass exactly one of --on or --off.");
    process.exitCode = 1;
    return;
  }

  // Accept either identifier a human is likely to have to hand: the address they
  // log in with, or the public "A1B2-C3D4-E5F6" shown in the portal. Email is
  // matched case-insensitively because that is how it is typed, not how it is stored.
  const merchant = await retry(() =>
    prisma.merchant.findFirst({
      where: {
        OR: [
          { email: { equals: target, mode: "insensitive" } },
          { merchantId: target },
        ],
      },
      select: { id: true, merchantId: true, email: true, name: true, externalRailEnabled: true },
    })
  );

  if (!merchant) {
    console.error(`No merchant matches "${target}" (tried email and public merchantId).`);
    process.exitCode = 1;
    return;
  }

  const want = on;
  console.log(`${merchant.merchantId}  ${merchant.email}  (${merchant.name})`);
  console.log(`  externalRailEnabled: ${merchant.externalRailEnabled} -> ${want}`);

  if (merchant.externalRailEnabled === want) {
    console.log(`\nAlready ${want ? "enabled" : "disabled"} — nothing to do.`);
    return;
  }
  if (!write) {
    console.log(`\nMODE: dry run — pass --write to apply.`);
    return;
  }

  await retry(() =>
    prisma.merchant.update({ where: { id: merchant.id }, data: { externalRailEnabled: want } })
  );
  console.log(`\nWrote externalRailEnabled = ${want}.`);
  if (want) {
    console.log(
      `This account can now reach /v1/mandates and /v1/charges once those routes ship.\n` +
        `Mandates it creates are mode "external" and are invisible to the renewal cron —\n` +
        `its own billing system owns the clock.`
    );
  } else {
    console.log(
      `Existing mandates are NOT revoked by this — they stay live on chain and this\n` +
        `platform still holds the key. Withdraw the entitlement AND revoke the mandates\n` +
        `if the intent is to stop charges.`
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

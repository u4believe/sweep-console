// Mint a pending rail mandate and print its authorization link, so the payer
// side of the external rail can be opened and looked at.
//
//   pnpm tsx scripts/demo-mandate.ts                      # dry run
//   pnpm tsx scripts/demo-mandate.ts --write              # create it
//   pnpm tsx scripts/demo-mandate.ts --write --amount 2 --chains base,arbitrum
//   pnpm tsx scripts/demo-mandate.ts --write --email ada@example.com
//
// No --email by default, which is the API's own default and the more revealing
// case: the payer enters and proves their own address on the authorization
// page. Pass one and the field is pinned to it, because an address the
// developer named is the address the merchant believes it is billing.
//
// Creates exactly what POST /v1/mandates creates, for the one merchant that
// holds the rail entitlement. It exists because that endpoint needs the
// merchant's API key, which is stored only as an HMAC — minting a fresh key to
// see a page would rotate the key their integration is using.
//
// The link is good for 24 hours and the mandate stays `pending` until a wallet
// signs. Nothing here can move money: a mandate is an authorization to ask.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { ids } from "../src/lib/ids";

const WRITE = process.argv.includes("--write");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
};

const INTERVAL_SECONDS: Record<string, number> = {
  daily: 86_400, weekly: 604_800, monthly: 2_592_000, yearly: 31_536_000,
};

async function main() {
  const usdc = arg("amount", "5");
  const interval = arg("interval", "monthly");
  const chains = arg("chains", "base,arbitrum,optimism").split(",").map((c) => c.trim().toLowerCase());
  const email = arg("email", "");

  const merchant = await prisma.merchant.findFirst({
    where: { externalRailEnabled: true },
    select: { id: true, merchantId: true, name: true, email: true },
  });
  if (!merchant) {
    console.error("No merchant holds the rail entitlement — scripts/external-rail.ts grants it.");
    process.exitCode = 1;
    return;
  }

  const maxAmount = BigInt(Math.round(Number(usdc) * 1e6));
  console.log(`merchant   ${merchant.name} (${merchant.merchantId})`);
  console.log(`cap        ${usdc} USDC per ${interval}`);
  console.log(`chains     ${chains.join(", ")}`);
  console.log(`email      ${email || "(none — the payer enters and proves their own)"}`);

  if (!WRITE) {
    console.log("\nDry run. Re-run with --write to create it.");
    return;
  }

  const now = new Date();
  const mandate = await prisma.mandate.create({
    data: {
      mandateId: ids.mandate(),
      merchantId: merchant.id,
      externalRef: `demo-${now.toISOString().slice(0, 10)}`,
      email: email || null,
      maxAmount,
      interval,
      periodDuration: INTERVAL_SECONDS[interval] ?? INTERVAL_SECONDS.monthly,
      chains,
      // A year out, like a real one; the LINK is the thing that expires soon.
      expiresAt: new Date(now.getTime() + 365 * 86_400_000),
      metadata: { created_by: "scripts/demo-mandate.ts" },
      sessionToken: ids.sessionToken(),
      linkExpiresAt: new Date(now.getTime() + 24 * 3_600_000),
      isTestMode: true,
    },
    select: { mandateId: true, status: true, linkExpiresAt: true },
  });

  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  console.log(`\ncreated    ${mandate.mandateId}  (${mandate.status})`);
  console.log(`authorize  ${base}/authorize/${mandate.mandateId}`);
  console.log(`link good  until ${mandate.linkExpiresAt.toISOString()}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());

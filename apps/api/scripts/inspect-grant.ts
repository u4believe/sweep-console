import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { decodeAbiParameters } from "viem";

/**
 * Decode what a subscriber ACTUALLY signed.
 *
 * A permission context is an opaque hex blob everywhere else in this codebase:
 * the wallet builds it, we store it, and every redeem passes it back verbatim.
 * That is the right design — but it means a question like "is the delegate
 * still pinned?" cannot be answered by reading our own source, because the
 * answer lives in bytes MetaMask produced.
 *
 * This decodes those bytes to the ERC-7710 Delegation[] they are and names the
 * caveat enforcers, so the question is settled by the signed artefact rather
 * than by inference from a type signature. That distinction cost this
 * migration real time: `payee` takes a list in the kit's types and MetaMask
 * silently refuses two, which no amount of reading our code would reveal.
 */
const DELEGATION = [
  {
    type: "tuple[]",
    name: "delegations",
    components: [
      { type: "address", name: "delegate" },
      { type: "address", name: "delegator" },
      { type: "bytes32", name: "authority" },
      {
        type: "tuple[]",
        name: "caveats",
        components: [
          { type: "address", name: "enforcer" },
          { type: "bytes", name: "terms" },
          { type: "bytes", name: "args" },
        ],
      },
      { type: "uint256", name: "salt" },
      { type: "bytes", name: "signature" },
    ],
  },
] as const;

/** Enforcer addresses are stable per release, so a static map beats a lookup. */
const ENFORCER: Record<string, string> = {
  "0x474e3ae7e169e940607cc624da8a15eb120139ab": "ERC20PeriodTransferEnforcer",
  "0x92bf12322527caa612fd31a0e810472bbb106a8f": "ValueLteEnforcer",
  "0x1046bb45c8d673d4ea75321280db34899413c069": "TimestampEnforcer",
  "0xe144b0b2618071b4e56f746313528a669c7e65c5": "RedeemerEnforcer",
  "0xc2b0d624c1c4319760c96503ba27c347f3260f55": "AllowedCalldataEnforcer",
  "0xde4f2fac4b3d87a1d9953ca5fc09fca7f366254f": "NonceEnforcer",
};

const prisma = new PrismaClient();

async function main() {
  const take = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 3);
  const rows = await prisma.renewalDelegation.findMany({
    where: { context: { not: "" } },
    select: { id: true, chainId: true, walletAddress: true, delegateAddress: true, context: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take,
  });
  if (rows.length === 0) {
    console.log("no stored grants in this database");
    return;
  }

  for (const r of rows) {
    console.log(`\ngrant ${r.id}  chain=${r.chainId}  ${r.createdAt.toISOString().slice(0, 10)}`);
    let dels: any;
    try {
      [dels] = decodeAbiParameters(DELEGATION, r.context as `0x${string}`) as any;
    } catch (e) {
      console.log(`  NOT a Delegation[]: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    for (const d of dels) {
      const pinned = d.delegate.toLowerCase() === r.delegateAddress.toLowerCase();
      console.log(`  delegator (payer):  ${d.delegator}`);
      console.log(`  delegate (signed):  ${d.delegate}  ${pinned ? "== the delegate we redeem as" : "!= OUR DELEGATE — this grant is unredeemable by us"}`);
      console.log(`  caveats: ${d.caveats.length}`);
      for (const c of d.caveats) {
        const name = ENFORCER[c.enforcer.toLowerCase()] ?? "unknown enforcer";
        // A RedeemerEnforcer's terms ARE an address — show it as one, since
        // whether it repeats the delegate is the whole question.
        const terms =
          name === "RedeemerEnforcer" && c.terms.length >= 42
            ? `${c.terms.slice(0, 42)}  ${c.terms.slice(2, 42).toLowerCase() === d.delegate.slice(2).toLowerCase() ? "(the delegate again)" : "(a DIFFERENT address)"}`
            : `${c.terms.slice(0, 42)}…`;
        console.log(`    ${name.padEnd(28)} ${terms}`);
      }
    }
  }
}

main().finally(() => prisma.$disconnect());

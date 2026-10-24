// Phase 2 dry run: prove the grant path and the settlement path agree on
// mainnet BEFORE a single grant exists.
//
//   ARC_NETWORK=mainnet pnpm tsx scripts/preflight-mainnet.ts
//
// Read-only and offline except for one getCode per chain. It signs nothing,
// sends nothing and touches no database.
//
// WHY A SECOND CHECKER
//
// check-settlement-targets.ts answers the same question over the grants that
// EXIST. On mainnet none do, so it has nothing to say until the first payer
// has already granted — which is exactly too late.
//
// THE BUG CLASS, AND WHICH HALF OF IT EACH CHECK COVERS
//
// settlementPayeeFor() decides what a NEW grant pins. settlementTargetFor()
// decides where an EXISTING grant settles. A disagreement pulls the payer's
// money and then reverts, because AllowedCalldataEnforcer rejects a
// redemption going anywhere but the pinned address.
//
// That disagreement has two halves, and they need different checks.
//
// The CONFIG half — the two functions resolving differently for the same
// chain — is what the per-chain section below covers, by running one into the
// other. Note what it cannot do: settlementTargetFor has exactly two
// outcomes, the EOA when the grant pins the EOA and the MSCA otherwise, so a
// synthetic third address cannot make them disagree. The check is still worth
// running for settlementPayeeFor's throw on mixed coverage and for the
// viaMsca agreement, but it is not the one that would have caught the bug we
// actually shipped.
//
// The CALL-SITE half is. The real defect was that settlementPayeeFor existed,
// was correct, and was never called: all four grant sites pinned the EOA
// directly while chainSettlesViaMsca chose the MSCA. No amount of running the
// functions against each other sees that, because the broken code does not
// call them. Only reading the sites does, which is the static section.

import "dotenv/config";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createPublicClient, encodeAbiParameters, http, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arbitrum, optimism } from "viem/chains";
import {
  chainPaysOwnGas,
  chainSettlesViaMsca,
  chainUsesPaymaster,
  circlePaymasterV07,
  settlementPayeeFor,
  settlementTargetFor,
} from "../src/lib/chain/settlement-target";
import { isMainnet } from "../src/lib/gateway/chains";

/// Mirrors settlement-target.ts. A grant's payee lives inside a caveat's
/// terms, which is why grantPins() searches there rather than at a fixed
/// offset — the enforcers pack terms differently.
const DELEGATION_ABI_PARAMS = [
  {
    type: "tuple[]",
    components: [
      { name: "delegate", type: "address" },
      { name: "delegator", type: "address" },
      { name: "authority", type: "bytes32" },
      {
        name: "caveats",
        type: "tuple[]",
        components: [
          { name: "enforcer", type: "address" },
          { name: "terms", type: "bytes" },
          { name: "args", type: "bytes" },
        ],
      },
      { name: "salt", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

/**
 * The context a real grant would carry, for a given payee.
 *
 * Only the caveat terms matter to the routing, so the rest is filled with
 * zeroes rather than faked — a plausible-looking fake would invite someone to
 * read meaning into fields this check does not exercise.
 */
function contextPinning(payee: Address): Hex {
  return encodeAbiParameters(DELEGATION_ABI_PARAMS, [
    [
      {
        delegate: zeroAddress,
        delegator: zeroAddress,
        authority: `0x${"00".repeat(32)}` as Hex,
        caveats: [{ enforcer: zeroAddress, terms: payee as Hex, args: "0x" as Hex }],
        salt: 0n,
        signature: "0x" as Hex,
      },
    ],
  ]);
}

const CHAINS = [
  { key: "base", chain: base, rpc: "https://mainnet.base.org" },
  { key: "arbitrum", chain: arbitrum, rpc: "https://arb1.arbitrum.io/rpc" },
  { key: "optimism", chain: optimism, rpc: "https://mainnet.optimism.io" },
];

/**
 * Does the CCTP contract this deployment would burn into actually exist?
 *
 * This is the check that was missing when a mainnet payment burned nothing.
 * getTokenMessenger defaulted to the TESTNET address on every network, the
 * live services never set CCTP_TOKEN_MESSENGER_BASE, and the burn called an
 * address with no code — which the EVM reports as success. The UserOperation
 * said success, the log said "burned", no message was emitted, and the payment
 * died 180 seconds later waiting for an attestation of nothing.
 *
 * The default follows the network now, so this cannot happen by omission. It
 * can still happen by OVERRIDE: CCTP_TOKEN_MESSENGER_<CHAIN> set to a testnet
 * address, or left over from a testnet deployment, beats the default silently.
 * An operator cannot tell by reading the variable — only the chain knows
 * whether something is there.
 *
 * Every mainnet source chain, because the fault was in one function shared by
 * all of them and Base was merely the first one routed through.
 */
async function checkCctpContracts(note: (bad: boolean, line: string) => void): Promise<void> {
  const { getTokenMessenger } = await import("../src/lib/gateway/cctp");
  const { getSourceChain } = await import("../src/lib/gateway/chains");
  const { rpcUrlForChain } = await import("../src/lib/chain/delegation");
  const { createPublicClient, http } = await import("viem");

  console.log("CCTP contracts");
  for (const key of ["base", "arbitrum", "optimism"]) {
    const addr = getTokenMessenger(key);
    const overridden = !!process.env[`CCTP_TOKEN_MESSENGER_${key.toUpperCase()}`];
    let bytes = -1;
    try {
      const source = getSourceChain(key);
      // The configured RPC when there is one, else the chain's own public
      // endpoint. This is a read-only check and must work from a laptop that
      // has no DELEGATION_RPC_* set — a preflight you cannot run locally is
      // one that only ever runs after the thing it was meant to prevent.
      let rpc: string;
      try {
        rpc = rpcUrlForChain(source.chain.id);
      } catch {
        rpc = source.chain.rpcUrls.default.http[0]!;
      }
      const client = createPublicClient({ chain: source.chain, transport: http(rpc) });
      const code = await client.getCode({ address: addr });
      bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
    } catch (e) {
      note(true, `${key.padEnd(9)} ${addr} — could not read: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      continue;
    }
    note(
      bytes <= 0,
      `${key.padEnd(9)} ${addr}  ${bytes > 0 ? `${bytes} bytes` : "NO CODE — a burn here emits nothing"}` +
        `${overridden ? "  [CCTP_TOKEN_MESSENGER_" + key.toUpperCase() + " override]" : ""}`
    );
  }
  console.log();
}

async function main(): Promise<void> {
  if (!isMainnet()) {
    console.log("ARC_NETWORK is not 'mainnet'. Re-run as:\n");
    console.log("  ARC_NETWORK=mainnet pnpm tsx scripts/preflight-mainnet.ts\n");
    console.log("Running it against testnet config would check the wrong table and pass.");
    process.exitCode = 1;
    return;
  }

  let problems = 0;
  const note = (bad: boolean, line: string) => {
    if (bad) problems++;
    console.log(`  ${bad ? "FAIL" : "ok  "}  ${line}`);
  };

  /**
   * Does the configured MSCA match what the configured OWNER derives?
   *
   * These are two independent settings and nothing kept them in step. Turning
   * KMS on changes the owner, which changes the account CREATE2 puts it at —
   * so SETTLEMENT_MSCA_ADDRESS silently becomes an address this deployment
   * cannot sign for.
   *
   * settlement-userop.ts:177 catches it, but only at the moment of settling,
   * which is after the payer's money has been pulled. This check exists to
   * make that unreachable, and on 2026-10-20 it did not exist: a preflight
   * PASSED against a KMS owner paired with the old key's MSCA.
   */
  async function checkMscaMatchesOwner(): Promise<void> {
    const configured = process.env.SETTLEMENT_MSCA_ADDRESS;
    if (!configured) return;
    try {
      const { getSettlementAccount } = await import("../src/lib/chain/signers");
      const { toCircleSmartAccount } = await import("@circle-fin/modular-wallets-core");
      const owner = getSettlementAccount();
      // One chain is enough: the address is identical on all of them, which
      // setup-kms-settlement.ts verifies when it derives them.
      const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL_8453 ?? "https://mainnet.base.org") });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sa = await toCircleSmartAccount({ client: client as any, owner: owner as any });
      const agrees = sa.address.toLowerCase() === configured.toLowerCase();
      note(
        !agrees,
        agrees
          ? `SETTLEMENT_MSCA_ADDRESS matches the owner ${owner.address}`
          : `SETTLEMENT_MSCA_ADDRESS is ${configured} but owner ${owner.address} derives ${sa.address} — ` +
              `settlement would refuse rather than pay into an account it cannot spend from`
      );
    } catch (e) {
      note(true, `could not derive the settlement MSCA: ${(e as Error).message.slice(0, 90)}`);
    }
  }

  console.log(`SETTLEMENT_MSCA_ADDRESS   ${process.env.SETTLEMENT_MSCA_ADDRESS ?? "(unset)"}`);
  console.log(`SETTLEMENT_MSCA_ENABLED   ${process.env.SETTLEMENT_MSCA_ENABLED ?? "(unset)"}`);
  console.log(`KMS_PROVIDER              ${process.env.KMS_PROVIDER ?? "(unset)"}\n`);

  for (const { key, chain, rpc } of CHAINS) {
    console.log(`${key} (${chain.id})`);

    // 1. What a new grant pins, and where that grant would settle. The whole
    //    point: run one into the other.
    let payee: Address;
    try {
      payee = settlementPayeeFor(chain.id);
    } catch (e) {
      note(true, `settlementPayeeFor threw: ${(e as Error).message.slice(0, 70)}`);
      console.log();
      continue;
    }

    const target = settlementTargetFor(chain.id, contextPinning(payee));
    note(
      target.address.toLowerCase() !== payee.toLowerCase(),
      `grant pins ${payee} -> settles into ${target.address}`
    );

    // 2. The gas policy has to be coherent with that choice. An MSCA on a
    //    paymaster chain needs the paymaster deployed; one paying its own gas
    //    needs ETH, which is a funding fact rather than a code fact and is
    //    only reported here.
    const viaMsca = chainSettlesViaMsca(chain.id);
    note(
      viaMsca !== target.viaMsca,
      `chainSettlesViaMsca=${viaMsca} agrees with the resolved target (viaMsca=${target.viaMsca})`
    );

    if (chainUsesPaymaster(chain.id)) {
      const pm = circlePaymasterV07(chain.id);
      if (!pm) {
        note(true, "chainUsesPaymaster is true but circlePaymasterV07 returned null");
      } else {
        const client = createPublicClient({ chain, transport: http(process.env[`RPC_URL_${chain.id}`] ?? rpc) });
        const code = await client.getCode({ address: pm }).catch(() => null);
        note(!code || code === "0x", `Circle Paymaster v0.7 at ${pm} is deployed`);
      }
    } else if (chainPaysOwnGas(chain.id)) {
      console.log(`  --    pays its own gas: fund ${payee} with ETH on ${key}`);
    }

    console.log();
  }

  /**
   * Four roles, four keys, and nothing in the code says so.
   *
   * Two silent failures live here. getSettlementAccount() falls back to the
   * hosted relayer when SETTLEMENT_PRIVATE_KEY is unset (signers.ts:121),
   * so an unset variable does not error — settlement just quietly becomes the
   * platform key. And nothing stops two variables holding the SAME key, which
   * collapses the separation while every address still looks populated.
   *
   * Both matter more on mainnet than testnet: the settlement account is the
   * payee in every grant, and the delegates are named as the delegate. If one
   * key covers two roles, a single leak costs both.
   *
   * Addresses only below. The keys themselves are never read into output.
   */
  console.log("settlement account");
  await checkMscaMatchesOwner();
  console.log();

  await checkCctpContracts(note);

  console.log("keys");
  const ROLES: Array<[string, string]> = [
    [
      "SETTLEMENT_PRIVATE_KEY",
      process.env.KMS_PROVIDER
        ? "NOT the owner any more — KMS_PROVIDER is set, so the KMS key signs"
        : "owns the settlement MSCA, payee in every grant",
    ],
    ["RENEWAL_DELEGATE_PRIVATE_KEY", "owns the renewal delegate MSCA"],
    ["EXTERNAL_RELAYER_PRIVATE_KEY", "owns the external relayer MSCA"],
    ["PLATFORM_PRIVATE_KEY", "hosted relayer"],
  ];

  /**
   * Pairings that are deliberate, not accidents.
   *
   * PLATFORM_PRIVATE_KEY and RENEWAL_DELEGATE_PRIVATE_KEY already share a
   * fallback: getRelayerAccount("hosted") returns the renewal key when set and
   * the platform key when not (signers.ts:92-95). Setting them equal is
   * therefore the same behaviour an unconfigured deployment already has.
   *
   * They are still two jobs. The platform key is the Arc-side relayer — it
   * submits CCTP mints and pays Arc gas. The renewal key owns the delegate
   * MSCA that signs redeemDelegations on the source chains. Sharing means one
   * leak costs both.
   *
   * What makes it survivable is the MSCA: the grant names the delegate MSCA's
   * ADDRESS, and this key is only its OWNER, so a leak is rotated with
   * addOwners/removeOwners and no payer re-grants. That would not hold for a
   * bare EOA delegate, where the key IS the pinned address.
   */
  const ACCEPTED_SHARES = [["PLATFORM_PRIVATE_KEY", "RENEWAL_DELEGATE_PRIVATE_KEY"]];
  const shareAccepted = (a: string, b: string) =>
    ACCEPTED_SHARES.some((pair) => pair.includes(a) && pair.includes(b));

  const seen = new Map<string, string>();
  for (const [envVar, what] of ROLES) {
    const raw = process.env[envVar];
    if (!raw) {
      /**
       * Every one of these falls back silently. I wrote this branch believing
       * only SETTLEMENT_PRIVATE_KEY did, and that the others threw where they
       * were used — they do not, and a mainnet preflight PASSED on 2026-10-18
       * with two delegate keys unset.
       *
       * signers.ts:92 returns PLATFORM_PRIVATE_KEY when the renewal key is
       * absent, and getRelayerAccount("external") falls through to the same
       * place. So an unset delegate key does not fail loudly; it collapses
       * three roles onto one key, and every grant from then on names that one
       * address as its delegate.
       *
       * PLATFORM_PRIVATE_KEY is the exception: nothing falls back TO anything
       * else when it is missing, and platformKey() does throw.
       */
      const fallsBackSilently = envVar !== "PLATFORM_PRIVATE_KEY";
      /**
       * Name the key it would ACTUALLY fall back to.
       *
       * getRelayerAccount tries EXTERNAL, then RENEWAL, then PLATFORM — so an
       * unset external key lands on the RENEWAL key whenever that is set, not
       * on the platform key. Saying "PLATFORM" there sends someone to check a
       * variable that is not involved, at the one moment it matters: rotating
       * the delegate keys, where the whole risk is the two roles silently
       * collapsing onto one address.
       */
      const landsOn =
        envVar === "EXTERNAL_RELAYER_PRIVATE_KEY" && process.env.RENEWAL_DELEGATE_PRIVATE_KEY
          ? "RENEWAL_DELEGATE_PRIVATE_KEY — both delegates would be the SAME address"
          : "PLATFORM_PRIVATE_KEY";
      note(
        fallsBackSilently,
        `${envVar} is unset` +
          (fallsBackSilently
            ? ` — would SILENTLY use ${landsOn} (signers.ts:${
                envVar === "SETTLEMENT_PRIVATE_KEY" ? "121" : "92"
              })`
            : " — platformKey() throws where it is used")
      );
      continue;
    }

    let address: string;
    try {
      // Normalised exactly as signers.ts accountFor() does: the 0x prefix is
      // optional there, and SETTLEMENT_PRIVATE_KEY is in fact stored without
      // it. A stricter check here would report a working key as broken, and
      // the first false positive is what teaches everyone to ignore the tool.
      const trimmed = raw.trim();
      const hex = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
      address = privateKeyToAccount(hex).address;
    } catch {
      note(true, `${envVar} is set but is not a valid 32-byte private key`);
      continue;
    }

    const clash = seen.get(address.toLowerCase());
    if (clash && shareAccepted(clash, envVar)) {
      // Said out loud rather than passed in silence: a chosen pairing still
      // widens what one leak costs, and the next reader should see that it
      // was chosen.
      console.log(`  ok    ${envVar.padEnd(28)} ${address}  shares ${clash} — accepted`);
    } else {
      note(!!clash, `${envVar.padEnd(28)} ${address}  ${clash ? `SAME KEY AS ${clash}` : what}`);
    }
    if (!clash) seen.set(address.toLowerCase(), envVar);
  }
  console.log();

  // The call-site half. A grant site that builds a payee without going
  // through settlementPayeeAddress() is the defect that shipped once already,
  // and it is invisible to every runtime check above.
  console.log("grant sites");
  const ROUTES = join(__dirname, "..", "src", "routes");
  let sites = 0;
  for (const name of readdirSync(ROUTES).filter((f) => f.endsWith(".ts"))) {
    const lines = readFileSync(join(ROUTES, name), "utf8").split("\n");
    lines.forEach((line, i) => {
      // The payee expression, not the comment that mentions the helper.
      if (!/\bconst\s+payee\s*=/.test(line)) return;
      sites++;
      note(
        !line.includes("settlementPayeeAddress()"),
        `${name}:${i + 1} builds a payee via settlementPayeeAddress()`
      );
    });
  }
  note(sites === 0, `found ${sites} grant site(s) to check`);
  console.log();

  console.log(
    problems === 0
      ? "PASS. On every mainnet chain, the grant's payee and settlement's target are the same\n" +
          "      address, and every grant site derives its payee from settlementPayeeAddress()."
      : `FAIL. ${problems} problem(s). A grant that pins one address while settlement targets another\n` +
          "       pulls the payer's money and then reverts. Do not cut over."
  );
  if (problems > 0) process.exitCode = 1;
}

void main();

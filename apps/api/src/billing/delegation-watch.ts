/**
 * Watch the relayer addresses for an EIP-7702 delegation nobody asked for.
 *
 * Under 7702, what an address DOES is set by a signature, not by its code
 * history. Anyone holding the key can point it at any implementation, and the
 * account then executes that implementation's logic for every call — including
 * draining whatever it holds. A malicious delegation is not a transaction you
 * can see coming in a mempool filter; it is a state change that sits there
 * until something uses the account.
 *
 * settleViaUserOp already compares the pointer before it settles, so a hijack
 * cannot silently redirect a payment. But that check runs at settlement time,
 * which is the worst moment to discover it: the subscriber's money has already
 * been redeemed into the account. This runs on a timer instead, so the gap
 * between "delegation changed" and "somebody knows" is minutes rather than
 * however long until the next charge.
 *
 * THIS IS NOT HYPOTHETICAL ON THIS DEPLOYMENT
 *
 * When the settlement UserOp path was first wired, it failed with AA23 because
 * the settlement key on Base Sepolia was ALREADY delegated — to MetaMask's
 * EIP7702StatelessDeleGator v1.3.0, bound to EntryPoint v0.7, which rejects a
 * v0.8 operation. Nothing in this codebase put it there; it came from the
 * address being connected in a wallet. The same was true of the external
 * relayer and platform keys, on some chains and not others.
 *
 * That is the point worth keeping: "we never delegate this key" is not a
 * property of the system, because delegation does not require the system's
 * cooperation. It only requires the key. So it has to be observed, not assumed.
 */

import { createPublicClient, http, type Address, type Hex } from "viem";
import { rpcUrlForChain } from "../lib/chain/delegation";
import { chainKeyForId, supportedSourceChains } from "../lib/gateway/chains";
import { getPlatformAccount, getRelayerAccount, getSettlementAddress } from "../lib/chain/signers";


/**
 * Implementations that are fine to see, beyond the one we delegate to
 * ourselves. Comma-separated addresses.
 *
 * An escape hatch for a delegation that is known and accepted — the MetaMask
 * delegator already sitting on several of these keys, say — so that silencing
 * it is a deliberate, written-down decision rather than the monitor being
 * switched off wholesale because it complains every ten minutes.
 */
function allowedImplementations(): Set<string> {
  return new Set(
    (process.env.RELAYER_DELEGATION_ALLOWED ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** The 7702 pointer an address currently carries, or null if it is a plain EOA. */
function delegationPointer(code: Hex | undefined): string | null {
  if (!code || code === "0x") return null;
  // A delegation indicator is exactly 23 bytes: 0xef0100 || implementation.
  if (!code.toLowerCase().startsWith("0xef0100")) return "not-a-7702-pointer";
  return `0x${code.slice(8)}`.toLowerCase();
}

export interface DelegationFinding {
  address: Address;
  role: string;
  chainId: number;
  chainKey: string;
  /** What it points at now, or null for an undelegated EOA. */
  actual: string | null;
  /** What this deployment expects there. */
  expected: string | null;
  severity: "unexpected" | "allowed" | "pending";
}

/**
 * Every key this deployment holds, with the name it is known by in logs.
 *
 * getSettlementAddress rather than the account, because a settlement key that
 * falls back to the hosted relayer would otherwise be reported twice under two
 * names for the same address — accurate but noisy.
 */
function watchedAddresses(): { address: Address; role: string }[] {
  const rows: { address: Address; role: string }[] = [
    { address: getSettlementAddress(), role: "settlement" },
    { address: getRelayerAccount("hosted").address, role: "renewal delegate" },
    { address: getRelayerAccount("external").address, role: "external relayer" },
    { address: getPlatformAccount().address, role: "platform" },
  ];
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = r.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * What SHOULD be delegated on this chain.
 *
 * Nothing. Settlement runs as a Circle MSCA — a separate contract address, not
 * a delegation — so this codebase never points any of these keys anywhere, and
 * every one of them should be a plain EOA.
 *
 * The settlement EOA is watched most closely of all, because it OWNS the MSCA.
 * A hostile implementation sitting on an owner key is the one delegation that
 * could plausibly reach the account's funds, depending on whether the MSCA
 * validates an EOA owner by ECDSA recovery or by ERC-1271 — and an
 * implementation answering isValidSignature for anything would be game over
 * under the second. Not relying on which it is, is cheaper than proving it.
 *
 * Derived rather than stored. A baseline written to a table would need a
 * migration, would need seeding, and — worse — would record whatever was there
 * when it was first run, which on this deployment would have enshrined the
 * MetaMask delegation as the expected state.
 */
function expectedFor(_role: string, _chainId: number): string | null {
  return null;
}

/**
 * Read every watched address on every source chain and report what disagrees.
 *
 * Never throws for a chain it cannot reach: an RPC that is down is an outage,
 * not a hijack, and turning one into the other would train whoever reads these
 * logs to ignore them.
 */
export async function checkRelayerDelegations(): Promise<DelegationFinding[]> {
  const allowed = allowedImplementations();
  const findings: DelegationFinding[] = [];

  for (const source of supportedSourceChains()) {
    const chainId = source.chain.id;
    const chainKey = chainKeyForId(chainId) ?? String(chainId);
    let client;
    try {
      client = createPublicClient({ transport: http(rpcUrlForChain(chainId)) });
    } catch {
      continue;
    }

    for (const { address, role } of watchedAddresses()) {
      let code: Hex | undefined;
      try {
        code = await client.getCode({ address });
      } catch (e) {
        console.warn(`[delegation-watch] ${chainKey} ${role}: could not read code — ${(e as Error).message}`);
        continue;
      }

      const actual = delegationPointer(code);
      const expected = expectedFor(role, chainId);
      if (actual === expected) continue;

      /**
       * Expected a delegation and found none: not a hijack.
       *
       * settleViaUserOp delegates on first use, so an account that has simply
       * not settled yet sits here legitimately. Reporting it at the same
       * volume as a hostile pointer is how a monitor earns the right to be
       * ignored — which costs more than the alert is worth.
       */
      if (actual === null) {
        findings.push({ address, role, chainId, chainKey, actual, expected, severity: "pending" });
        continue;
      }

      if (allowed.has(actual)) {
        findings.push({ address, role, chainId, chainKey, actual, expected, severity: "allowed" });
        continue;
      }
      findings.push({ address, role, chainId, chainKey, actual, expected, severity: "unexpected" });
    }
  }

  return findings;
}

/**
 * The cron entry point. Logs loudly and returns the findings for a caller that
 * wants to page on them.
 *
 * An unexpected delegation is printed at error level with the word HIJACK in
 * it, because the realistic way this gets noticed is a log search, and the
 * realistic cost of missing it is the account being emptied.
 */
export async function checkRelayerDelegationsOnce(): Promise<DelegationFinding[]> {
  const findings = await checkRelayerDelegations();
  const unexpected = findings.filter((f) => f.severity === "unexpected");

  for (const f of findings) {
    const what = f.actual === null ? "no delegation" : f.actual;
    const want = f.expected === null ? "no delegation" : f.expected;
    if (f.severity === "pending") {
      console.log(
        `[delegation-watch] ${f.chainKey} ${f.role} ${f.address} is not delegated yet — ` +
          `it will be on its first settlement`
      );
    } else if (f.severity === "allowed") {
      console.warn(
        `[delegation-watch] ${f.chainKey} ${f.role} ${f.address} is delegated to ${what} ` +
          `(expected ${want}) — allowed by RELAYER_DELEGATION_ALLOWED`
      );
    } else {
      console.error(
        `[delegation-watch] POSSIBLE HIJACK: ${f.chainKey} ${f.role} ${f.address} ` +
          `points at ${what}, expected ${want}. Anyone holding this key can set that, and the ` +
          `implementation executes as the account. Verify before the next settlement.`
      );
    }
  }

  if (findings.length === 0) {
    console.log("[delegation-watch] all relayer addresses as expected");
  }
  return unexpected;
}

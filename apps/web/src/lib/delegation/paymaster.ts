// Can the wallet let us pay for the EIP-7702 upgrade?
//
// Every charge on this platform is already relayer-paid — the redeem, the CCTP
// burn and the Arc mint all come out of our gas. Exactly one moment still costs
// the subscriber anything: the first time they use a source chain, MetaMask has
// to upgrade their EOA to a smart account, and that is a transaction they submit
// and pay for. Checkout discloses it ("a few cents of gas"), which is honest but
// is also the last place a subscriber can be surprised by a wallet prompt.
//
// It matters more on the rail than at checkout. A subscriber at checkout is
// already buying something; one arriving at /authorize was sent by a developer,
// has bought nothing yet, and a gas prompt is exactly where they leave.
//
// The upgrade goes through EIP-5792 `wallet_sendCalls` (see upgrade.ts), and that
// call carries a `capabilities` field. ERC-7677 defines `paymasterService` there:
// hand the wallet a paymaster URL and it routes the batch through it, so the
// sponsor pays. This module answers only the first question — WILL THE WALLET LET
// US? — because standing up a paymaster is real work (an ERC-7677 endpoint, a
// funded account per chain, and a leash so it isn't a public faucet) and there is
// no point doing any of it if the answer is no.
//
// It deliberately does not sponsor anything. It asks, logs, and returns.

import { getCapabilities } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";

export interface PaymasterSupport {
  chainId: number;
  /** True only when the wallet reports paymasterService as supported here. */
  supported: boolean;
  /**
   * Null when the wallet never answered — it doesn't implement
   * wallet_getCapabilities, or it threw. That is NOT the same as "no": the
   * lesson from capabilities.ts is that MetaMask builds exist which refuse a
   * probe and then service the real call happily. Treat null as "unknown, try
   * it and let the attempt be the judge", never as a refusal.
   */
  raw: unknown | null;
}

/// What the wallet said about one chain, if anything.
function readChain(caps: Record<number, Record<string, unknown>> | undefined, chainId: number): PaymasterSupport {
  const forChain = caps?.[chainId];
  if (!forChain) return { chainId, supported: false, raw: null };
  const pm = forChain.paymasterService as { supported?: boolean } | undefined;
  return { chainId, supported: pm?.supported === true, raw: forChain };
}

/**
 * Ask the connected wallet whether it will accept a sponsored `wallet_sendCalls`
 * on each of `chainIds`.
 *
 * Never throws — a probe that fails is a probe that told us nothing, and nothing
 * here is important enough to break a checkout over.
 */
export async function probePaymasterSupport(
  account: `0x${string}`,
  chainIds: number[]
): Promise<PaymasterSupport[]> {
  let caps: Record<number, Record<string, unknown>> | undefined;
  try {
    caps = (await getCapabilities(wagmiConfig, { account })) as unknown as Record<
      number,
      Record<string, unknown>
    >;
  } catch (e) {
    console.info(
      "[paymaster] wallet_getCapabilities refused or unsupported — sponsorship status unknown, not disproven:",
      e instanceof Error ? e.message : e
    );
    return chainIds.map((chainId) => ({ chainId, supported: false, raw: null }));
  }
  return chainIds.map((chainId) => readChain(caps, chainId));
}

/**
 * Print what the wallet supports, once, in a form worth pasting into an issue.
 *
 * Called from the upgrade path so the answer arrives on the next real grant
 * rather than needing a special build. Also exported for the console:
 *   await window.__sweepProbePaymaster("0xYourAddress", [84532])
 */
export async function logPaymasterSupport(account: `0x${string}`, chainIds: number[]): Promise<void> {
  const results = await probePaymasterSupport(account, chainIds);
  const answered = results.filter((r) => r.raw !== null);
  if (answered.length === 0) {
    console.info("[paymaster] wallet reported no capabilities for", chainIds.join(", "));
    return;
  }
  for (const r of answered) {
    console.info(
      `[paymaster] chain ${r.chainId}: paymasterService ${r.supported ? "SUPPORTED — the 7702 upgrade can be sponsored" : "not offered"}`,
      r.raw
    );
  }
}

// Console handle, dev only. The probe is read-only, but there is no reason to
// hand a production page a global.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__sweepProbePaymaster = logPaymasterSupport;
}

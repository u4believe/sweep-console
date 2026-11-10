// EIP-7702 EOA → smart-account upgrade — the prerequisite MetaMask needs before it
// will grant an ERC-7715 execution permission for an address. Upgrade state lives
// in the account's on-chain code, which is chain-local: upgrading the address on
// Arbitrum Sepolia does NOT upgrade the same address on Base Sepolia. So this runs
// once per target chain, immediately before that chain's grant request.
//
// MetaMask offers the upgrade through EIP-5792's wallet_sendCalls: a forced-atomic
// batch of 2 calls is something a plain EOA cannot execute atomically, which is
// what makes MetaMask present its "Switch to smart account" confirmation. There is
// no dedicated "upgrade me" RPC — this is the documented trigger. See:
// https://docs.metamask.io/tutorials/upgrade-eoa-to-smart-account
//
// Reference implementation this mirrors: github.com/intuition-box/delegation (src/main.ts).

import { type Address, type Client } from "viem";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { sendCalls } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";
import { logPaymasterSupport } from "./paymaster";

// EIP-7702 delegation designator: an upgraded EOA's code is exactly this prefix
// followed by the 20-byte implementation address it delegates to.
const DELEGATION_PREFIX = "0xef0100";
const UPGRADE_POLL_MS = 2_000;
const UPGRADE_POLL_ATTEMPTS = 30; // ~1 min worst case — matches the reference impl

type ConfiguredChainId = (typeof wagmiConfig)["chains"][number]["id"];

/// The stateless EIP-7702 implementation MetaMask points an upgraded EOA at — the
/// same contract on every 7702-enabled chain, but sourced from the SDK's own
/// deployment registry (not hardcoded) so it tracks MetaMask's rollout as-is.
/// Returns null if this chain isn't in MetaMask's registry (can't upgrade here).
/**
 * Whether MetaMask's delegation framework exists on this chain.
 *
 * The registry is the authority, and it is accurate: Base, Arbitrum and OP
 * Sepolia are registered and grants succeed there; Arc (5042002) is not, and
 * MetaMask refuses with "External signature requests cannot sign delegations for
 * internal accounts" — it does not recognise the upgraded account as a smart
 * account on a chain whose framework it has no deployment for.
 *
 * Do NOT infer support from the wallet's getSupportedExecutionPermissions()
 * chain list. It returns the same 43 chains for every permission type, including
 * ones where signing is refused, so it describes chains MetaMask knows rather
 * than chains where a delegation can be signed.
 */
export function supportsDelegation(chainId: number): boolean {
  try {
    getSmartAccountsEnvironment(chainId);
    return true;
  } catch {
    return false;
  }
}

function statelessImpl(chainId: number): Address | null {
  try {
    const env = getSmartAccountsEnvironment(chainId);
    return env.implementations.EIP7702StatelessDeleGatorImpl as Address;
  } catch {
    return null;
  }
}

/// Reads the account's code straight off the chain the client is bound to and
/// checks it's the 7702 delegation designator pointing at MetaMask's implementation.
async function isSmartAccount(client: Client, address: Address, chainId: number): Promise<boolean> {
  const impl = statelessImpl(chainId);
  if (!impl) return false;
  const code = (await client.request({
    method: "eth_getCode",
    params: [address, "latest"],
  } as never)) as string | null;
  if (!code || code === "0x" || !code.toLowerCase().startsWith(DELEGATION_PREFIX)) return false;
  const target = `0x${code.slice(DELEGATION_PREFIX.length)}`;
  return target.toLowerCase() === impl.toLowerCase();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Ensure `address` is a smart account on `chainId` — prompting MetaMask's upgrade
/// dialog and waiting for the delegation code to land on-chain if it isn't yet.
/// No-ops if already upgraded on this chain. `client` must already be on `chainId`
/// (grantMandates.ts's connectorClientOnChain guarantees this).
/**
 * The implementation an EOA is 7702-delegated to, or null when it is not one.
 *
 * EIP-7702 writes 23 bytes at the account: 0xef0100 then the implementation
 * address. Anything else — empty, or real contract code — is not a delegation.
 */
async function delegationTargetOf(client: Client, address: Address): Promise<string | null> {
  const code = (await client.request({
    method: "eth_getCode",
    params: [address, "latest"],
  } as never)) as string | null;
  if (!code || !code.toLowerCase().startsWith("0xef0100")) return null;
  return `0x${code.slice(8, 48)}`;
}

export async function ensureSmartAccount(client: Client, address: Address, chainId: number): Promise<void> {
  // Checked BEFORE prompting. The upgrade is the only gas a subscriber ever pays
  // on this platform, and on a chain the framework is missing from they would pay
  // it and then be refused the permission anyway — charged for nothing. Ask the
  // registry first and say so instead.
  if (!supportsDelegation(chainId)) {
    throw new Error(
      `Spending permissions aren't available on chain ${chainId} yet — MetaMask's delegation ` +
        `framework isn't deployed there. Nothing was signed and no gas was spent.`
    );
  }

  if (await isSmartAccount(client, address, chainId)) return;

  /**
   * REFUSE BEFORE PROMPTING when the account belongs to another wallet's
   * implementation, because the prompt cannot succeed.
   *
   * isSmartAccount already compares the delegation target against
   * MetaMask's EIP7702StatelessDeleGatorImpl for this chain, so a false from
   * it means one of three things: a plain EOA, real contract code, or a
   * delegation to someone ELSE'S implementation. Only the first can be
   * upgraded from here. The third produces a MetaMask prompt that is refused
   * with a bare -32603 after the subscriber has agreed to it.
   *
   * Observed on Base, where a subscriber's account pointed at Coinbase's
   * EIP-7702 proxy while the same account carried MetaMask's own
   * implementation on Arbitrum, Optimism and Monad. Coinbase sponsors that
   * delegation, so it is free and leaves nothing the holder would remember.
   *
   * Checked here rather than caught below so no prompt is raised at all:
   * being asked to approve something that cannot work, and then being told
   * "an internal error was received", is the worst version of this.
   */
  const alreadyDelegated = await delegationTargetOf(client, address).catch(() => null);
  const expected = statelessImpl(chainId);
  if (alreadyDelegated && expected && alreadyDelegated.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `This account is already upgraded to a different kind of smart account on chain ` +
        `${chainId} — its code points at ${alreadyDelegated}, which MetaMask won't use. Switch ` +
        `it back to a standard account in the app that upgraded it (Coinbase Wallet and similar ` +
        `do this), or pay from a different account. Nothing was signed and no gas was spent.`
    );
  }

  console.info(`[upgrade] chain ${chainId} — prompting EIP-7702 smart-account upgrade for ${address}`);

  // This prompt is the ONLY gas a subscriber pays on this platform. Ask, right
  // here, whether the wallet would let us sponsor it instead — the answer decides
  // whether an ERC-7677 paymaster is worth building. Fire-and-forget: it must
  // never delay or fail an upgrade the subscriber is already confirming.
  void logPaymasterSupport(address, [chainId]);

  // `data` is deliberately omitted below (not `"0x"`) — MetaMask validates
  // calldata against /^0x[0-9a-f]+$/, which an empty string fails. Two no-op
  // self-calls, forced atomic: a plain EOA can't execute a batch atomically,
  // which is what triggers the upgrade offer rather than a plain send.
  try {
    await sendCalls(wagmiConfig, {
      chainId: chainId as ConfiguredChainId,
      forceAtomic: true,
      calls: [
        { to: address, value: 0n },
        { to: address, value: 0n },
      ],
    });
  } catch (e) {
    /**
     * SAY WHICH CONTRACT, when the account is already delegated elsewhere.
     *
     * MetaMask refuses an account delegated to an implementation it does
     * not recognise, and reports it as a bare -32603 "An internal error
     * was received", with "Account upgraded to unsupported contract"
     * buried two causes down. Nothing in that names the chain, the
     * account or the contract, and it is indistinguishable from a
     * transient wallet fault.
     *
     * Observed with a subscriber whose account was delegated to
     * Coinbase's EIP-7702 proxy on Base — Coinbase sponsors that
     * upgrade, so it is free and leaves nothing the holder would
     * remember — while the same account carried MetaMask's own
     * implementation on Arbitrum, Optimism and Monad. One chain of four,
     * which is why it read as random.
     *
     * The target is on chain and costs one eth_getCode, so the error can
     * name it rather than leaving the next person to decode 23 bytes.
     */
    const target = await delegationTargetOf(client, address).catch(() => null);
    if (target) {
      throw new Error(
        `This account is already upgraded to a different kind of smart account on chain ` +
          `${chainId} — its code points at ${target}, which MetaMask won't use. Switch it ` +
          `back to a standard account in the app that upgraded it (Coinbase Wallet and ` +
          `similar do this), or pay from a different account. Nothing was signed.`
      );
    }
    throw e;
  }

  for (let i = 0; i < UPGRADE_POLL_ATTEMPTS; i++) {
    if (await isSmartAccount(client, address, chainId)) {
      console.info(`[upgrade] chain ${chainId} — confirmed on-chain`);
      return;
    }
    await sleep(UPGRADE_POLL_MS);
  }
  throw new Error(
    "Smart account upgrade didn't confirm on-chain in time. Try again, or switch to a smart account manually in MetaMask (account menu → Switch to smart account), then retry."
  );
}

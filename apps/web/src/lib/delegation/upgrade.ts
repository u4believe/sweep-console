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
export async function ensureSmartAccount(client: Client, address: Address, chainId: number): Promise<void> {
  if (await isSmartAccount(client, address, chainId)) return;

  console.info(`[upgrade] chain ${chainId} — prompting EIP-7702 smart-account upgrade for ${address}`);

  // `data` is deliberately omitted below (not `"0x"`) — MetaMask validates
  // calldata against /^0x[0-9a-f]+$/, which an empty string fails. Two no-op
  // self-calls, forced atomic: a plain EOA can't execute a batch atomically,
  // which is what triggers the upgrade offer rather than a plain send.
  await sendCalls(wagmiConfig, {
    chainId: chainId as ConfiguredChainId,
    forceAtomic: true,
    calls: [
      { to: address, value: 0n },
      { to: address, value: 0n },
    ],
  });

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

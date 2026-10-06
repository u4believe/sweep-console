// Keep settlement able to pay the bridge fee.
//
// The burn spends `amount + maxFee` while the redemption only delivered `amount`
// — the platform absorbs the CCTP fee so the merchant receives the full sum (see
// burnCalls in delegation.ts). Before the split that difference came out of the
// relayer's own USDC, which it had plenty of because every platform fee accrued
// there. Neither of those is true now: settlement does the burning, and fees go
// to the treasury per payment, so nothing refills it on its own.
//
// Left alone, settlement drains by roughly maxFee per payment until a burn fails
// on insufficient balance — long after the subscriber's money has already been
// pulled, which is the worst place in the flow to run out.
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { ERC20_ABI } from "./abi";
import { rpcUrlForChain } from "./delegation";
import { getRelayerAccount, getSettlementAddress, settlementIsSeparate } from "./signers";

/// Top up when the balance falls below this. USDC micro-units.
function floorAmount(): bigint {
  return BigInt(process.env.SETTLEMENT_FLOAT_MIN ?? "1000000"); // 1 USDC
}

/// Bring it back up to this. USDC micro-units.
function targetAmount(): bigint {
  return BigInt(process.env.SETTLEMENT_FLOAT_TOPUP ?? "5000000"); // 5 USDC
}

/**
 * Make sure settlement can cover the bridge fee on `chainId`, topping up from the
 * relayer if it cannot.
 *
 * Never throws. A failed top-up is not a reason to abandon a payment that has
 * already pulled the subscriber's funds: the burn may still succeed on the
 * balance in hand, and if it does not, the bridge resumes on the next pass —
 * which is the behaviour it already has for every other transient failure.
 *
 * Nothing to do when settlement has not been split out: the relayer would be
 * paying itself.
 */
export async function ensureSettlementFloat(chainId: number, token: Address): Promise<void> {
  if (!settlementIsSeparate()) return;

  const floor = floorAmount();
  if (floor <= 0n) return;

  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrlForChain(chainId)] } },
  });

  try {
    const publicClient = createPublicClient({ chain, transport: http() });
    const settlement = getSettlementAddress();

    const held = (await publicClient.readContract({
      address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [settlement],
    })) as bigint;
    if (held >= floor) return;

    const funder = getRelayerAccount("hosted");
    const want = targetAmount() - held;
    const available = (await publicClient.readContract({
      address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [funder.address],
    })) as bigint;

    if (available === 0n) {
      // Worth saying plainly rather than once a burn fails. After the split the
      // relayer has no USDC income — its balance is whatever accrued before fees
      // started going to the treasury, and when that runs out this needs funding
      // from somewhere else.
      console.warn(
        `[float] settlement holds ${held} on chain ${chainId} and the relayer has nothing to send. ` +
          `Fund either account with USDC, or set CCTP_RENEWAL_SPEED=standard to stop paying a bridge fee.`
      );
      return;
    }

    const amount = available < want ? available : want;
    const walletClient = createWalletClient({ account: funder, chain, transport: http() });
    const hash: Hex = await walletClient.writeContract({
      address: token, abi: ERC20_ABI, functionName: "transfer", args: [settlement, amount], chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[float] topped settlement up by ${amount} on chain ${chainId} (${hash})`);
  } catch (e) {
    console.error(`[float] top-up failed on chain ${chainId}:`, e instanceof Error ? e.message : e);
  }
}

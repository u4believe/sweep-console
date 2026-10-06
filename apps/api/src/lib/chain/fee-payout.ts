// Move the platform's cut to the treasury, per payment.
//
// Both collection paths pull the GROSS amount to a relayer on the source chain
// and bridge only the merchant's share to Arc. That is deliberate — bridging the
// fee separately would cost two more transactions and, on a small payment, more
// than the fee is worth. What it left behind was the fee itself, sitting in the
// wallet whose private key signs every renewal, growing until someone moved it
// by hand.
//
// So the fee is swept the cheap way instead: one ERC-20 transfer on the chain it
// is already on, straight after the pull. The relayer holds it for seconds
// rather than indefinitely, and the treasury address — an EOA, so the same key
// controls it on every chain — ends up with the money.
//
// Deliberately NOT bridged to Arc. Consolidating across chains is a separate,
// occasional decision; making it part of every payment would spend a multiple of
// the fee to move it.
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { ERC20_ABI } from "./abi";
import { accountForDelegate } from "./signers";
import { rpcUrlForChain } from "./delegation";

function treasuryAddress(): Address | null {
  const t = process.env.PLATFORM_TREASURY_ADDRESS;
  return t && /^0x[0-9a-fA-F]{40}$/.test(t.trim()) ? (t.trim() as Address) : null;
}

export interface FeePayoutInput {
  chainId: number;
  token: Address;
  /** The account holding the fee — settlement, after the burn has taken its share. */
  from: Address;
  /** Exactly what this payment earned, net of what its burn cost. */
  amount: bigint;
}

/**
 * Send one payment's net fee from settlement to the treasury.
 *
 * Returns the tx hash, or null when there is nothing to do or the transfer
 * failed. Callers treat a null as non-fatal on purpose: the payment has already
 * settled for the merchant by this point, and a fee that stays in the relayer is
 * a reconciliation chore, not a lost payment. Failing the renewal over it would
 * turn an accounting inconvenience into a billing incident.
 */
export async function payFeeToTreasury(input: FeePayoutInput): Promise<Hex | null> {
  if (input.amount <= 0n) return null;

  const treasury = treasuryAddress();
  if (!treasury) {
    console.warn("[fee] PLATFORM_TREASURY_ADDRESS is not set — fee stays in the relayer");
    return null;
  }
  if (treasury.toLowerCase() === input.from.toLowerCase()) return null; // already there

  const chain = defineChain({
    id: input.chainId,
    name: `chain-${input.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrlForChain(input.chainId)] } },
  });

  try {
    const account = accountForDelegate(input.from);
    const publicClient = createPublicClient({ chain, transport: http() });
    const walletClient = createWalletClient({ account, chain, transport: http() });

    // An exact amount, not a sweep of the balance. Several collections can be in
    // flight at once, and a balance sweep would hand the treasury USDC that a
    // concurrent payment had redeemed and not yet burned — taking money out from
    // under its own bridge. Remitting precisely what this payment earned leaves
    // every other payment's funds untouched, and settlement holds nothing between
    // them rather than carrying a float to absorb the race.
    const held = (await publicClient.readContract({
      address: input.token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    if (held < input.amount) {
      // Can only mean a burn consumed more than planned. Leave it: the shortfall
      // stays as working capital and the next payment's remittance is unaffected.
      console.warn(
        `[fee] settlement holds ${held} on chain ${input.chainId}, this payment earned ` +
          `${input.amount} — leaving it in place`
      );
      return null;
    }

    const hash = await walletClient.writeContract({
      address: input.token,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [treasury, input.amount],
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      console.error(`[fee] transfer reverted on chain ${input.chainId}: ${hash}`);
      return null;
    }
    console.log(`[fee] ${input.amount} → treasury on chain ${input.chainId} (${hash})`);
    return hash;
  } catch (e) {
    console.error(`[fee] payout failed on chain ${input.chainId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

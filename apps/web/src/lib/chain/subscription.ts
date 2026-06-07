import { getPublicClient, getPlatformWalletClient, getContractAddress } from "./config";
import { SUBSCRIPTION_MANAGER_ABI } from "./abis";

/**
 * Calls renew() on the SubscriptionManager contract.
 * Used by the billing engine for recurring charges.
 * Returns the transaction hash, or throws on revert.
 */
export async function renewOnChain(
  onChainSubId: `0x${string}`,
  testMode: boolean
): Promise<{ txHash: `0x${string}`; blockNumber: bigint }> {
  const walletClient = getPlatformWalletClient(testMode);
  const publicClient = getPublicClient(testMode);
  const contractAddress = getContractAddress(testMode);

  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: "renew",
    args: [onChainSubId],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, blockNumber: receipt.blockNumber };
}

/**
 * Calls cancel() on-chain. Used when the developer cancels via API or retry exhausts.
 */
export async function cancelOnChain(
  onChainSubId: `0x${string}`,
  testMode: boolean
): Promise<`0x${string}`> {
  const walletClient = getPlatformWalletClient(testMode);
  const contractAddress = getContractAddress(testMode);

  return walletClient.writeContract({
    address: contractAddress,
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: "cancel",
    args: [onChainSubId],
  });
}

/**
 * Calls refund() on-chain. Admin only.
 */
export async function refundOnChain(
  onChainSubId: `0x${string}`,
  amount: bigint,
  testMode: boolean
): Promise<`0x${string}`> {
  const walletClient = getPlatformWalletClient(testMode);
  const contractAddress = getContractAddress(testMode);

  return walletClient.writeContract({
    address: contractAddress,
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: "refund",
    args: [onChainSubId, amount],
  });
}

/**
 * Reads isDueBilling() view. Used to double-check before calling renew().
 */
export async function isDueBillingOnChain(
  onChainSubId: `0x${string}`,
  testMode: boolean
): Promise<boolean> {
  const publicClient = getPublicClient(testMode);
  const contractAddress = getContractAddress(testMode);

  return publicClient.readContract({
    address: contractAddress,
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: "isDueBilling",
    args: [onChainSubId],
  });
}

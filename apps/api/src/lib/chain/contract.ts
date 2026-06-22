import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  decodeEventLog,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SUBSCRIPTION_MANAGER_ABI, ERC20_ABI } from "./abi";

// ─── Arc chain definitions ────────────────────────────────────────────────────

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network/"] },
  },
  testnet: true,
});

const arcMainnet = defineChain({
  id: 5042001,
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ARC_MAINNET_RPC_URL ?? "https://rpc.arc.network/"] },
  },
});

function chain() {
  return process.env.ARC_NETWORK === "mainnet" ? arcMainnet : arcTestnet;
}

// ─── Clients (platform arbiter wallet signs all billing-engine calls) ─────────

export function getManagerAddress(): Hex {
  const addr = process.env.SUBSCRIPTION_MANAGER_ADDRESS;
  if (!addr) throw new Error("SUBSCRIPTION_MANAGER_ADDRESS is not set");
  return addr as Hex;
}

export function getUsdcAddress(): Hex {
  return (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Hex;
}

export function getPublicClient() {
  return createPublicClient({ chain: chain(), transport: http() });
}

function getArbiterClient() {
  const privateKey = process.env.PLATFORM_PRIVATE_KEY;
  if (!privateKey) throw new Error("PLATFORM_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(privateKey as Hex);
  return createWalletClient({ account, chain: chain(), transport: http() });
}

// ─── Write helpers ────────────────────────────────────────────────────────────

export interface TxResult {
  txHash: string;
  blockNumber: bigint;
}

async function writeManager(
  functionName:
    | "settlePeriod"
    | "renewFromAllowance"
    | "refund"
    | "cancelSubscription"
    | "subscribeWithPermit",
  args: readonly unknown[]
): Promise<TxResult & { logs: DecodedLog[] }> {
  const publicClient = getPublicClient();
  const walletClient = getArbiterClient();

  const { request } = await publicClient.simulateContract({
    address: getManagerAddress(),
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName,
    args: args as never,
    account: walletClient.account,
  });

  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== "success") {
    throw new Error(`${functionName} transaction reverted: ${txHash}`);
  }

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    logs: decodeManagerLogs(receipt.logs),
  };
}

interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
}

function decodeManagerLogs(logs: { data: Hex; topics: [] | [Hex, ...Hex[]] }[]): DecodedLog[] {
  const decoded: DecodedLog[] = [];
  for (const log of logs) {
    try {
      const event = decodeEventLog({
        abi: SUBSCRIPTION_MANAGER_ABI,
        data: log.data,
        topics: log.topics,
      });
      decoded.push({ eventName: event.eventName, args: event.args as Record<string, unknown> });
    } catch {
      // log from another contract (e.g. USDC Transfer) — skip
    }
  }
  return decoded;
}

// ─── Billing-engine surface ───────────────────────────────────────────────────

export interface RenewResult extends TxResult {
  success: boolean;
  failureReason?: string;
  escrowed: boolean; // trial conversions escrow the first payment instead of pushing
}

/// Pulls one period from the subscriber's pre-approved allowance.
/// The contract emits PaymentFailed instead of reverting when funds are short,
/// so a mined tx can still be a failed renewal — inspect the logs.
export async function renewFromAllowance(onChainSubId: string): Promise<RenewResult> {
  const result = await writeManager("renewFromAllowance", [onChainSubId as Hex]);

  const failed = result.logs.find((l) => l.eventName === "PaymentFailed");
  if (failed) {
    return {
      ...result,
      success: false,
      failureReason: String(failed.args.reason ?? "Payment failed"),
      escrowed: false,
    };
  }

  const sub = await getOnChainSubscription(onChainSubId);
  return { ...result, success: true, escrowed: sub.escrowBalance > 0n };
}

export interface SettleResult extends TxResult {
  merchantShare: bigint;
  platformFee: bigint;
}

/// Pushes escrowed funds (merchant share + platform fee) once the window closed.
export async function settlePeriodOnChain(onChainSubId: string): Promise<SettleResult> {
  const result = await writeManager("settlePeriod", [onChainSubId as Hex]);
  const settled = result.logs.find((l) => l.eventName === "PeriodSettled");
  return {
    ...result,
    merchantShare: BigInt((settled?.args.merchantShare as bigint) ?? 0n),
    platformFee: BigInt((settled?.args.platformFee as bigint) ?? 0n),
  };
}

export interface RefundResult extends TxResult {
  refundedAmount: bigint;
}

/// Pro-rated refund — only USDC still in escrow can be refunded.
export async function refundOnChain(onChainSubId: string, refundPct: number): Promise<RefundResult> {
  const result = await writeManager("refund", [onChainSubId as Hex, refundPct]);
  const refunded = result.logs.find((l) => l.eventName === "Refunded");
  return { ...result, refundedAmount: BigInt((refunded?.args.amount as bigint) ?? 0n) };
}

export interface CancelResult extends TxResult {
  refundedEscrow: bigint;
}

/// Cancels on-chain and returns any remaining escrow to the subscriber.
export async function cancelOnChain(onChainSubId: string): Promise<CancelResult> {
  const result = await writeManager("cancelSubscription", [onChainSubId as Hex]);
  const cancelled = result.logs.find((l) => l.eventName === "SubscriptionCancelled");
  return { ...result, refundedEscrow: BigInt((cancelled?.args.refundedEscrow as bigint) ?? 0n) };
}

// ─── Platform-submitted (gasless) activations ────────────────────────────────

export interface SubscriptionActivationParams {
  subId: Hex;
  subscriber: Hex;
  merchantPayout: Hex;
  planId: Hex;
  amount: bigint;
  interval: bigint;
  trialDuration: bigint;
  settlementWindow: bigint;
  permitValue: bigint;
  permitDeadline: bigint;
  permitV: number;
  permitR: Hex;
  permitS: Hex;
}

/// Gasless same-chain Arc activation: the subscriber signs only an EIP-2612
/// permit; the platform arbiter submits this tx (and pays Arc gas), the permit
/// grants the recurring allowance, and the first period is pulled into
/// settlement-window escrow from the subscriber's existing Arc USDC.
export async function subscribeWithPermitOnChain(
  activation: SubscriptionActivationParams
): Promise<TxResult> {
  const result = await writeManager("subscribeWithPermit", [activation]);
  return { txHash: result.txHash, blockNumber: result.blockNumber };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export interface OnChainSubscription {
  subscriber: string;
  merchantPayout: string;
  planId: string;
  amount: bigint;
  interval: bigint;
  nextBillingDate: bigint;
  trialEnd: bigint;
  escrowBalance: bigint;
  settlementDeadline: bigint;
  settlementWindow: bigint;
  retryCount: number;
  status: number; // 0 None | 1 Trialing | 2 Active | 3 PastDue | 4 Cancelled
}

export async function getOnChainSubscription(onChainSubId: string): Promise<OnChainSubscription> {
  const publicClient = getPublicClient();
  const sub = await publicClient.readContract({
    address: getManagerAddress(),
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: "getSubscription",
    args: [onChainSubId as Hex],
  });
  return sub as unknown as OnChainSubscription;
}

/// Checks the subscriber still has both USDC balance and allowance for one period.
export async function checkSubscriberFunds(
  subscriberAddress: string,
  requiredAmount: bigint
): Promise<boolean> {
  try {
    const publicClient = getPublicClient();
    const [allowance, balance] = await Promise.all([
      publicClient.readContract({
        address: getUsdcAddress(),
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [subscriberAddress as Hex, getManagerAddress()],
      }),
      publicClient.readContract({
        address: getUsdcAddress(),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [subscriberAddress as Hex],
      }),
    ]);
    return (allowance as bigint) >= requiredAmount && (balance as bigint) >= requiredAmount;
  } catch {
    return false;
  }
}

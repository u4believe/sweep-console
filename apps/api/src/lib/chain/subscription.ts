// Billing-engine chain surface for the Subscription Protocol.
//
// Hybrid model: first payments / trial conversions sit in settlement-window
// escrow inside the SubscriptionManager contract; all renewals are pulled from
// the subscriber's pre-approved USDC allowance and PUSHED to the merchant's
// payout address in the same transaction. Merchants never claim.

export {
  renewFromAllowance,
  settlePeriodOnChain,
  refundOnChain,
  cancelOnChain,
  getOnChainSubscription,
  checkSubscriberFunds,
  getManagerAddress,
  getUsdcAddress,
  type RenewResult,
  type SettleResult,
  type RefundResult,
  type CancelResult,
  type OnChainSubscription,
  type TxResult,
} from "./contract";

// Settlement window helper — per plan, falling back to the platform default.
export function settlementWindowSeconds(planWindowHours?: number | null): number {
  const hours = planWindowHours ?? parseInt(process.env.SETTLEMENT_WINDOW_HOURS ?? "24", 10);
  return hours * 3600;
}

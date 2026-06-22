// ABI for SubscriptionManager.sol — keep in sync with packages/contracts/out/
// After `forge build`, regenerate from: out/SubscriptionManager.sol/SubscriptionManager.json

export const SUBSCRIPTION_MANAGER_ABI = [
  {
    type: "function",
    name: "subscribe",
    inputs: [
      { name: "subId", type: "bytes32" },
      { name: "merchantPayout", type: "address" },
      { name: "planId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "interval", type: "uint256" },
      { name: "trialDuration", type: "uint256" },
      { name: "settlementWindow", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "subscribeWithPermit",
    inputs: [
      {
        name: "activation",
        type: "tuple",
        components: [
          { name: "subId", type: "bytes32" },
          { name: "subscriber", type: "address" },
          { name: "merchantPayout", type: "address" },
          { name: "planId", type: "bytes32" },
          { name: "amount", type: "uint256" },
          { name: "interval", type: "uint256" },
          { name: "trialDuration", type: "uint256" },
          { name: "settlementWindow", type: "uint256" },
          { name: "permitValue", type: "uint256" },
          { name: "permitDeadline", type: "uint256" },
          { name: "permitV", type: "uint8" },
          { name: "permitR", type: "bytes32" },
          { name: "permitS", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "settlePeriod",
    inputs: [{ name: "subId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "renewFromAllowance",
    inputs: [{ name: "subId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "refund",
    inputs: [
      { name: "subId", type: "bytes32" },
      { name: "refundPct", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelSubscription",
    inputs: [{ name: "subId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getSubscription",
    inputs: [{ name: "subId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "subscriber", type: "address" },
          { name: "merchantPayout", type: "address" },
          { name: "planId", type: "bytes32" },
          { name: "amount", type: "uint256" },
          { name: "interval", type: "uint256" },
          { name: "nextBillingDate", type: "uint256" },
          { name: "trialEnd", type: "uint256" },
          { name: "escrowBalance", type: "uint256" },
          { name: "settlementDeadline", type: "uint256" },
          { name: "settlementWindow", type: "uint256" },
          { name: "retryCount", type: "uint8" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isDueBilling",
    inputs: [{ name: "subId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isDueSettlement",
    inputs: [{ name: "subId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  // Events
  {
    type: "event",
    name: "SubscriptionCreated",
    inputs: [
      { name: "subId", type: "bytes32", indexed: true },
      { name: "subscriber", type: "address", indexed: false },
      { name: "merchant", type: "address", indexed: false },
      { name: "planId", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SubscriptionRenewed",
    inputs: [
      { name: "subId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "nextBillingDate", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PeriodSettled",
    inputs: [
      { name: "subId", type: "bytes32", indexed: true },
      { name: "merchantShare", type: "uint256", indexed: false },
      { name: "platformFee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PaymentFailed",
    inputs: [
      { name: "subId", type: "bytes32", indexed: true },
      { name: "retryCount", type: "uint8", indexed: false },
      { name: "reason", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SubscriptionCancelled",
    inputs: [
      { name: "subId", type: "bytes32", indexed: true },
      { name: "refundedEscrow", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "subId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "pct", type: "uint8", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

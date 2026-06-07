// ABI for SubscriptionManager.sol — keep in sync with packages/contracts/out/
// After `forge build`, regenerate from: out/SubscriptionManager.sol/SubscriptionManager.json

export const SUBSCRIPTION_MANAGER_ABI = [
  // subscribe(bytes32,address,uint256,uint256,uint256)
  {
    type: "function",
    name: "subscribe",
    inputs: [
      { name: "subscriptionId", type: "bytes32" },
      { name: "merchant", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interval", type: "uint256" },
      { name: "trialDuration", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "renew",
    inputs: [{ name: "subscriptionId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancel",
    inputs: [{ name: "subscriptionId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimFunds",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "refund",
    inputs: [
      { name: "subscriptionId", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getSubscription",
    inputs: [{ name: "subscriptionId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "subscriber", type: "address" },
          { name: "merchant", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "interval", type: "uint256" },
          { name: "nextBillingAt", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "trialing", type: "bool" },
          { name: "trialEndAt", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isDueBilling",
    inputs: [{ name: "subscriptionId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getMerchantBalance",
    inputs: [{ name: "merchant", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  // Events
  {
    type: "event",
    name: "SubscriptionCreated",
    inputs: [
      { name: "subscriptionId", type: "bytes32", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "interval", type: "uint256", indexed: false },
      { name: "trialing", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SubscriptionRenewed",
    inputs: [
      { name: "subscriptionId", type: "bytes32", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SubscriptionCancelled",
    inputs: [
      { name: "subscriptionId", type: "bytes32", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "PaymentFailed",
    inputs: [
      { name: "subscriptionId", type: "bytes32", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "reason", type: "string", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
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

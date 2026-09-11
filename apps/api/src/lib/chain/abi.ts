// The ERC-20 surface this platform touches.
//
// The SubscriptionManager ABI lived here until its last caller went away: Arc is
// settlement-only now, so no contract of ours is called on any chain. What remains
// is USDC — balances and allowances — plus the wallet-granted permissions read
// elsewhere in lib/chain.


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

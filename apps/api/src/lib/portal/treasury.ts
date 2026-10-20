/**
 * What the platform's own accounts hold, for the operator screen.
 *
 * These are not merchant balances. They are the four addresses that make
 * settlement work, and each runs out in its own way:
 *
 *   settlement MSCA    ETH on Optimism only. Base and Arbitrum take gas from
 *                      USDC through Circle Paymaster v0.7, which is not
 *                      deployed on Optimism. It needs no USDC float — each
 *                      payment brings its own and tops the account toward
 *                      SETTLEMENT_GAS_FLOOR_USDC out of the platform's fee.
 *   delegate OWNERS    ETH on all three. The MSCAs hold nothing: their gas
 *                      sits as an EntryPoint deposit, and delegate-msca.ts:293
 *                      tops that up FROM THE OWNER EOA, which also pays for
 *                      the depositTo transaction. Send ETH to an MSCA and it
 *                      sits there paying for nothing.
 *   renewal EOA        USDC on Arc. Arc's gas token IS USDC, and this key —
 *                      not its MSCA — is what submits CCTP mints there.
 *
 * Running dry is silent in different places: a delegate without ETH stops
 * redeeming, and the Arc EOA without USDC stops minting AFTER the money has
 * been pulled and burned. Neither announces itself until a renewal fails, so
 * it is worth a screen.
 */

import { createPublicClient, formatEther, formatUnits, getAddress, http, type Address } from "viem";
import { base, arbitrum, optimism } from "viem/chains";
import { arcChain } from "../chain/contract";
import { getRelayerAccount } from "../chain/signers";
import { isMainnet } from "../gateway/chains";

/// balanceOf(address)
const BALANCE_OF = "0x70a08231";

const SOURCE_CHAINS = [
  { key: "base", chain: base, rpc: "https://mainnet.base.org", needsEth: false },
  { key: "arbitrum", chain: arbitrum, rpc: "https://arb1.arbitrum.io/rpc", needsEth: false },
  { key: "optimism", chain: optimism, rpc: "https://mainnet.optimism.io", needsEth: true },
] as const;

export interface TreasuryRow {
  /// "settlement" | "renewal" | "external" | "renewal-arc"
  role: string;
  address: string;
  chain: string;
  /// Formatted, not raw — the screen shows it and nothing computes on it.
  balance: string;
  symbol: string;
  /// True when this account needs this asset on this chain to function.
  required: boolean;
  /// Set when `required` and the balance is at or near zero.
  warning?: string;
}

function rpcFor(chainId: number, fallback: string): string {
  return process.env[`RPC_URL_${chainId}`] ?? process.env[`DELEGATION_RPC_${chainId}`] ?? fallback;
}

/**
 * Read every platform balance that matters.
 *
 * One failed read must not lose the rest — an operator screen that goes blank
 * because one RPC blinked is worse than one that reports a gap, so each cell
 * is settled independently and a failure shows as "?" rather than throwing.
 */
export async function readTreasury(): Promise<TreasuryRow[]> {
  const rows: TreasuryRow[] = [];
  const settlement = process.env.SETTLEMENT_MSCA_ADDRESS;
  const delegates: Array<[string, string | undefined]> = [
    ["renewal", process.env.RENEWAL_DELEGATE_MSCA_ADDRESS],
    ["external", process.env.EXTERNAL_RELAYER_MSCA_ADDRESS],
  ];

  await Promise.all(
    SOURCE_CHAINS.map(async ({ key, chain, rpc, needsEth }) => {
      const client = createPublicClient({ chain, transport: http(rpcFor(chain.id, rpc)) });

      const eth = async (who: string): Promise<string> => {
        try {
          return formatEther(await client.getBalance({ address: getAddress(who) as Address }));
        } catch {
          return "?";
        }
      };

      if (settlement) {
        rows.push({
          role: "settlement",
          address: settlement,
          chain: key,
          balance: await eth(settlement),
          symbol: "ETH",
          // Only Optimism: the other two are paid in USDC by the paymaster.
          required: needsEth,
        });
      }

      for (const [role, addr] of delegates) {
        if (!addr) continue;
        // The OWNER is what runs dry, not the MSCA. Reporting the MSCA's
        // balance would send an operator to top up an address that pays for
        // nothing, while the account that actually funds gas sits empty.
        let owner: string | null = null;
        try {
          owner = getRelayerAccount(role === "external" ? "external" : "hosted").address;
        } catch {
          /* key not configured — show the MSCA row without an owner */
        }
        rows.push({
          role,
          address: owner ?? addr,
          chain: key,
          balance: owner ? await eth(owner) : "?",
          symbol: "ETH",
          required: true,
        });
      }
    })
  );

  /**
   * Arc, which is the one that is easy to forget.
   *
   * The sender is the renewal delegate's KEY, not its MSCA — arcRelayer()
   * uses getRelayerAccount("hosted") and sends ordinary transactions. Showing
   * the MSCA address here would send someone to fund an account that pays for
   * nothing.
   */
  try {
    const arc = arcChain();
    const client = createPublicClient({ chain: arc, transport: http() });
    const who = getRelayerAccount("hosted").address;
    const usdc = (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Address;
    let balance = "?";
    try {
      const data = `${BALANCE_OF}${who.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
      const r = await client.call({ to: usdc, data });
      balance = formatUnits(r.data && r.data !== "0x" ? BigInt(r.data) : 0n, 6);
    } catch {
      /* leave "?" */
    }
    rows.push({
      role: "renewal-arc",
      address: who,
      chain: "arc",
      balance,
      symbol: "USDC",
      required: true,
    });
  } catch {
    /* no Arc config — omit the row rather than fail the screen */
  }

  const floor = Number(process.env.DELEGATE_MSCA_DEPOSIT_FLOOR_ETH ?? "0.002");
  for (const r of rows) {
    if (!r.required || r.balance === "?") continue;
    const n = Number(r.balance);
    if (n === 0) r.warning = "empty";
    else if (r.symbol === "ETH" && n < floor) r.warning = `below the ${floor} floor`;
    else if (r.symbol === "USDC" && n < 1) r.warning = "under 1 USDC";
  }

  return rows;
}

/// Whether this deployment has platform accounts worth showing at all.
export function treasuryConfigured(): boolean {
  return isMainnet() || !!process.env.SETTLEMENT_MSCA_ADDRESS;
}

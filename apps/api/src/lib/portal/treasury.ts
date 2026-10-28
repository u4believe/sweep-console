/**
 * What the platform's own accounts hold, for the operator screen.
 *
 * These are not merchant balances. They are the addresses that make settlement
 * work, and each runs out in its own way:
 *
 *   settlement MSCA    ETH on Optimism only. Base and Arbitrum take gas from
 *                      USDC through Circle Paymaster v0.7, which is not
 *                      deployed on Optimism. It needs no USDC float — each
 *                      payment brings its own and tops the account toward
 *                      SETTLEMENT_GAS_FLOOR_USDC out of the platform's fee.
 *   delegate OWNERS    ETH on all three, under either delegate design — which
 *                      is why this screen has always shown the owner and not
 *                      the MSCA, and why the number below stayed correct
 *                      across the switch. What changed is WHERE that ETH goes.
 *   renewal EOA        USDC on Arc. Arc's gas token IS USDC, and this key is
 *                      what submits CCTP mints there.
 *
 * UNDER THE MSCA DESIGN the owner's ETH moves into an EntryPoint deposit and
 * the operation spends it from there; the owner also pays for the depositTo.
 * Send ETH to an MSCA directly and it sits there paying for nothing.
 *
 * UNDER 7702 (DELEGATE_7702_ENABLED) the owner IS the delegate and pays for an
 * ordinary transaction. There is no deposit, no EntryPoint and no second
 * address — so a deposit figure would be a leftover, not a balance.
 *
 * Both can be live at once. A grant is immutable, so grants minted before the
 * switch still redeem through their MSCA while new ones redeem from the EOA,
 * and an operator needs to see whichever applies rather than one chosen for
 * them.
 *
 * Running dry is silent in different places: a delegate without ETH stops
 * redeeming, and the Arc EOA without USDC stops minting AFTER the money has
 * been pulled and burned. Neither announces itself until a renewal fails, so
 * it is worth a screen.
 */

import { createPublicClient, formatEther, formatUnits, getAddress, http, type Address } from "viem";
import { base, arbitrum, optimism } from "viem/chains";
import { arcChain } from "../chain/contract";
import { getRelayerAccount, type RelayerMode } from "../chain/signers";
import { isMainnet } from "../gateway/chains";
import { delegate7702Enabled } from "../chain/delegate-7702";

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
  /**
   * For a delegate row: what this ETH pays for.
   *
   * "7702"       the owner IS the delegate and sends ordinary transactions.
   * "entrypoint" the owner funds an EntryPoint deposit the MSCA spends from,
   *              so the deposit is a second number worth checking.
   */
  spends?: "7702" | "entrypoint";
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
  /**
   * Keyed on the ROLE, not on an MSCA address.
   *
   * These rows used to be gated on RENEWAL_DELEGATE_MSCA_ADDRESS and
   * EXTERNAL_RELAYER_MSCA_ADDRESS being set — while displaying the OWNER's
   * balance, which has nothing to do with those variables. Removing them
   * (correct once no grant names an MSCA, and correct under 7702 where there
   * is no MSCA at all) made both delegates vanish from the screen while their
   * owners still paid for every redeem.
   *
   * An operator screen whose rows disappear when configuration is tidied is
   * worse than one that is wrong: an empty section reads as "nothing to see"
   * rather than "this is no longer being watched". The accounts exist as long
   * as the KEYS exist, so the keys decide what is listed.
   */
  const delegates: Array<[string, RelayerMode]> = [["renewal", "hosted"]];
  /**
   * The rail's own delegate, listed only while it IS one.
   *
   * Since the rail's grants name the renewal delegate, "external" resolves
   * through getRelayerAccount's fallback to the renewal key wherever
   * EXTERNAL_RELAYER_PRIVATE_KEY is unset — and listing it then put the SAME
   * address on screen twice under two role names. Two rows reading as two
   * wallets to keep funded, when there is one, is the same class of mistake
   * as the vanishing rows this list was written to prevent: it misstates what
   * is being watched.
   *
   * Compared by ADDRESS rather than by reading the env var, because the key
   * can arrive by KMS as well, and the question here is only ever "is this a
   * second account someone has to fund".
   *
   * So a deployment that still has its own rail key keeps the row, and one
   * that has retired it loses it, with no per-environment branch: the sandbox
   * can hold the key while live does not, and each screen tells the truth
   * about itself.
   */
  try {
    if (getRelayerAccount("external").address !== getRelayerAccount("hosted").address) {
      delegates.push(["external", "external"]);
    }
  } catch {
    // Either key unreadable — fall through with renewal alone rather than
    // deciding this from a failure.
  }

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

      for (const [role, mode] of delegates) {
        // The OWNER is what runs dry, not the MSCA. Reporting the MSCA's
        // balance would send an operator to top up an address that pays for
        // nothing, while the account that actually funds gas sits empty.
        let owner: string | null = null;
        try {
          owner = getRelayerAccount(mode).address;
        } catch {
          // No key for this role at all. Still listed, with the balance
          // unknown, so the gap is visible rather than silent.
        }
        rows.push({
          role,
          address: owner ?? "(no key configured)",
          chain: key,
          balance: owner ? await eth(owner) : "?",
          symbol: "ETH",
          required: true,
          // Says what this ETH is FOR, which differs by design and decides
          // whether a deposit elsewhere also needs watching.
          spends: delegate7702Enabled() ? "7702" : "entrypoint",
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

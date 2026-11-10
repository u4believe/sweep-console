/**
 * The deployment's own answers, from GET /config.
 *
 * WHY THIS EXISTS. The landing page quoted the fee from
 * VITE_PLATFORM_FEE_BPS, which is baked at build time. Vercel had the
 * variable set to 250 and the page still said 2%, because the bundle
 * predated it — a rebuild is the only way a build-time constant changes, and
 * nobody rebuilds a marketing page to correct a number they cannot see is
 * wrong. Meanwhile the API charged 2.5%. The page under-quoted the platform's
 * own fee to every creator reading it.
 *
 * /config already serves platform_fee_bps from THE SAME READER the charging
 * paths use, and `mode` from the same isMainnet() that picks the chain set.
 * Asking it costs one request and makes both facts impossible to stale.
 *
 * The build-time values stay as the FIRST paint, so there is no flash of a
 * missing number; the API's answer replaces them a moment later and wins if
 * they ever disagree. A page that is briefly stale beats a page that is
 * permanently wrong.
 */
import { useEffect, useState } from "react";
import { isSandboxBuild } from "./mode";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export interface SweepConfig {
  /** Basis points, e.g. 250 for 2.5%. */
  platformFeeBps: number;
  /** True when this deployment is the sandbox. */
  isTest: boolean;
  /**
   * How settlement works here, and therefore what the page may claim.
   *
   *   "direct"  — paid and settled on the payer's own chain, one transaction
   *   "bridged" — pulled on the payer's chain, bridged, minted on Arc
   *
   * The page cannot know this at build time: one bundle serves a deployment
   * whose flag can change under it, and "Settled on Arc" baked into the
   * landing page would keep promising a chain nothing touches. So it is
   * served by /config beside the fee, which already works this way for the
   * same reason.
   */
  settlementModel: "direct" | "bridged";
  /**
   * The chains a payer may pay from, as THIS deployment serves them.
   *
   * The hosted checkout hardcoded three, which was fine while the list had
   * not moved in a year. Adding Monad to the API's table made that list
   * wrong in the quietest way available: the chain works end to end and a
   * payer simply never sees it offered.
   */
  sourceChains: Array<{ key: string; name: string }>;
  /** False until the API has answered; the values above are build-time until then. */
  /**
   * The host THIS API builds its own links with.
   *
   * Exposed so a page can tell whether it is served from the origin the
   * deployment is configured for. One bundle serves several hosts — the
   * real domain and every Vercel preview — and an API call from a preview
   * origin is refused by CORS, so a page loaded there breaks in ways that
   * point anywhere except at the address bar.
   */
  appUrl: string | null;
  loaded: boolean;
}

const FALLBACK_BPS = Number(import.meta.env.VITE_PLATFORM_FEE_BPS ?? "200");

/**
 * What to assume before /config answers.
 *
 * "direct" on purpose. The two readings fail differently: assuming direct and
 * being wrong understates a bridge the payer never sees anyway, while
 * assuming bridged and being wrong names Arc on a page where no transaction
 * will ever appear there. One is vague for a moment; the other is wrong in a
 * way a payer could act on.
 */
const FALLBACK_MODEL: "direct" | "bridged" = "direct";

/**
 * What to offer before /config answers.
 *
 * The three that have been there throughout. A chain added later appears the
 * moment config resolves, which is the right way round: showing a chain this
 * deployment does not serve would send a payer to a dead end, while showing
 * one late costs a few hundred milliseconds.
 */
const FALLBACK_CHAINS: Array<{ key: string; name: string }> = [
  { key: "base", name: "Base" },
  { key: "arbitrum", name: "Arbitrum" },
  { key: "optimism", name: "Optimism" },
];

export function useSweepConfig(): SweepConfig {
  const [cfg, setCfg] = useState<SweepConfig>({
    platformFeeBps: FALLBACK_BPS,
    isTest: isSandboxBuild(),
    settlementModel: FALLBACK_MODEL,
    sourceChains: FALLBACK_CHAINS,
    appUrl: null,
    loaded: false,
  });

  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive || !json) return;
        const d = (json.data ?? json) as {
          platform_fee_bps?: number;
          mode?: string;
          settlement_model?: string;
          source_chains?: Array<{ key: string; name: string }>;
          app_url?: string;
        };
        if (typeof d.platform_fee_bps !== "number") return;
        setCfg({
          platformFeeBps: d.platform_fee_bps,
          isTest: d.mode === "test",
          // Only "bridged" turns it back; anything else, including an older
          // API that does not send the field, reads as direct.
          settlementModel: d.settlement_model === "bridged" ? "bridged" : "direct",
          // An empty list would leave a payer no way to pay, so an API that
          // sends none keeps the fallback rather than blanking the picker.
          sourceChains: d.source_chains?.length ? d.source_chains : FALLBACK_CHAINS,
          appUrl: typeof d.app_url === "string" ? d.app_url : null,
          loaded: true,
        });
      })
      // Offline, blocked, or the API is down: keep the build-time values. The
      // page still renders a number, and it is the one this bundle was built
      // with rather than a blank.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return cfg;
}

/** "2.5%" — trailing zeros dropped, so 250 reads 2.5% and 200 reads 2%. */
export function formatFeePercent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** The fee taken off `amount`, to two decimals. */
export function feeOnAmount(amount: number, bps: number): string {
  return ((amount * bps) / 10_000).toFixed(2);
}

/** What the creator keeps from `amount`, to two decimals. */
export function keepsOfAmount(amount: number, bps: number): string {
  return (amount - (amount * bps) / 10_000).toFixed(2);
}

/**
 * How to say where a payment settles, for a given deployment.
 *
 * ONE PLACE, because the alternative was nine. "Settled on Arc" appeared on
 * the landing page, in both checkouts, on the dashboard and in the manage
 * screens, each written out by hand — so making it true again would have
 * meant finding all of them and agreeing with myself nine times.
 *
 * `chain` is the chain a payer actually used, where the caller knows it.
 * Without it the phrasing stays general, which is what a landing page needs
 * before anyone has chosen anything.
 */
export function settlementNote(
  model: "direct" | "bridged",
  chain?: string | null
): string {
  if (model === "bridged") return "Settled on Arc";
  if (!chain) return "Settled on the chain you pay from";
  return `Settled on ${chain}`;
}

/** The same fact as a sentence, for body copy rather than a label. */
export function settlementSentence(model: "direct" | "bridged"): string {
  return model === "bridged"
    ? "They pay from Base, Arbitrum or Optimism, and it settles to you on Arc."
    : "They pay from Base, Arbitrum, Optimism or Monad, and it lands in your wallet on that same chain.";
}

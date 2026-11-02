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
  /** False until the API has answered; the values above are build-time until then. */
  loaded: boolean;
}

const FALLBACK_BPS = Number(import.meta.env.VITE_PLATFORM_FEE_BPS ?? "200");

export function useSweepConfig(): SweepConfig {
  const [cfg, setCfg] = useState<SweepConfig>({
    platformFeeBps: FALLBACK_BPS,
    isTest: isSandboxBuild(),
    loaded: false,
  });

  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive || !json) return;
        const d = (json.data ?? json) as { platform_fee_bps?: number; mode?: string };
        if (typeof d.platform_fee_bps !== "number") return;
        setCfg({
          platformFeeBps: d.platform_fee_bps,
          isTest: d.mode === "test",
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

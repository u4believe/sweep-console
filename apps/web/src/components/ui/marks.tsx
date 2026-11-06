/**
 * The design package's own artwork.
 *
 * These are the files shipped in `Sweep Console landing page.zip` under
 * `assets/`, copied to `public/design/` and served as-is. They are not
 * redrawn, re-traced or approximated — the landing page and the checkout
 * reference the same PNG and SVGs the design does.
 *
 * This replaces the hand-built SVG components the app used before
 * (`ui/Logo.tsx`, `landing/ChainMarks.tsx`). Those were faithful enough to
 * pass unnoticed and wrong in the details that matter on a payment screen:
 * a subscriber recognises Base's mark, and a near-miss of it is worse than
 * no mark at all.
 *
 * `public/` rather than an import, because these are stable brand assets with
 * no build-time processing to gain — and because the paths then read the same
 * here as they do in the design's own HTML.
 */

const BASE = "/design";

export type ChainKey = "base" | "arbitrum" | "optimism" | "arc" | "monad";

/** The chain marks, keyed the way the rest of the app keys chains. */
export const CHAIN_ASSET: Partial<Record<ChainKey, string>> = {
  base: `${BASE}/chain-base.svg`,
  arbitrum: `${BASE}/chain-arbitrum.svg`,
  optimism: `${BASE}/chain-optimism.svg`,
  arc: `${BASE}/chain-arc.svg`,
  /**
   * monad: DELIBERATELY ABSENT until the real mark is dropped in beside the
   * others as `public/design/chain-monad.svg`.
   *
   * The note on ChainBadge applies here and is the reason this is a gap rather
   * than something hand-drawn: a payer recognises a chain's own mark, and an
   * approximation of it on the screen where they commit money is worse than
   * none. ChainMark renders a neutral monogram in the meantime, which is
   * visibly a placeholder and keeps the badge the same height as its
   * neighbours instead of collapsing the row.
   */
};

export const SWEEP_MARK = `${BASE}/sweep-mark.png`;
export const USDC_TOKEN = `${BASE}/token-usdc.svg`;
export const METAMASK_LOGO = `${BASE}/metamask-logo.svg`;
/**
 * The same mark with a WHITE wordmark, for dark grounds.
 *
 * The two files differ in exactly one thing: the lettering is #ffffff here
 * and #161616 in the other. The fox is identical. On the hero's navy strip
 * the dark wordmark is nearly unreadable, which is what this fixes — and
 * tinting the dark one with a filter would take the fox with it.
 */
export const METAMASK_LOGO_LIGHT = `${BASE}/metamask-logo-light.svg`;
export const CIRCLE_LOGO = `${BASE}/circle-logo.png`;

const CHAIN_KEYS: ChainKey[] = ["base", "arbitrum", "optimism", "arc", "monad"];

export function isChainKey(k: string): k is ChainKey {
  return (CHAIN_KEYS as string[]).includes(k);
}

/**
 * A chain's mark, at the design's default of 24px.
 *
 * `alt=""` throughout: every call site puts the chain's name in text beside
 * the mark, so naming it again is a screen reader saying "Base Base".
 *
 * `chain` is a plain string because every caller has one — `chain_key` off
 * an API row — and a cast at each site would turn an unknown chain into a
 * broken image. An unrecognised key renders nothing, so a new chain the API
 * knows about and this does not degrades to a label with no mark rather than
 * a missing-image glyph on a payment screen.
 *
 * `opacity` dims a chain that is not selected or not yet granted, which is
 * how the authorize and manage screens show state.
 */
export function ChainMark({
  chain,
  size = 24,
  opacity,
}: {
  chain: string;
  size?: number;
  opacity?: number;
}) {
  if (!isChainKey(chain)) return null;
  const asset = CHAIN_ASSET[chain];
  if (!asset) {
    // A known chain with no mark yet. Same footprint, obviously a stand-in.
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          flex: "none",
          opacity,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: size * 0.3,
          background: "var(--color-neutral-200)",
          color: "var(--color-neutral-700)",
          fontSize: size * 0.5,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {chain.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={asset}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain", flex: "none", opacity }}
    />
  );
}

/**
 * The Sweep mark. 26px in the design's header, 22 in the console's rail.
 *
 * `onDark` renders it as a white silhouette. The SVG this replaced took a
 * `fill`, which a PNG cannot; `brightness(0) invert(1)` is the equivalent —
 * it crushes the artwork to black and flips it, so the shape survives and
 * the colour does not. Only for a dark ground, where the mark's own colours
 * would otherwise disappear into it.
 */
export function SweepMark({ size = 26, onDark = false }: { size?: number; onDark?: boolean }) {
  return (
    <img
      src={SWEEP_MARK}
      alt=""
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        flex: "none",
        ...(onDark ? { filter: "brightness(0) invert(1)" } : {}),
      }}
    />
  );
}

/**
 * The USDC token.
 *
 * `size` omitted fills its parent, which is how the hero uses it: the design
 * sizes the coin in `em` on a wrapper so it tracks the heading, and a fixed
 * px here would be correct at exactly one breakpoint.
 */
export function UsdcMark({ size }: { size?: number }) {
  if (size === undefined) {
    return <img src={USDC_TOKEN} alt="" style={{ display: "block", width: "100%", height: "100%" }} />;
  }
  return (
    <img
      src={USDC_TOKEN}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain", flex: "none" }}
    />
  );
}

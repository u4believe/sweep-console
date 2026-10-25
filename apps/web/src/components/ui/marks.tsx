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

export type ChainKey = "base" | "arbitrum" | "optimism" | "arc";

/** The chain marks, keyed the way the rest of the app keys chains. */
export const CHAIN_ASSET: Record<ChainKey, string> = {
  base: `${BASE}/chain-base.svg`,
  arbitrum: `${BASE}/chain-arbitrum.svg`,
  optimism: `${BASE}/chain-optimism.svg`,
  arc: `${BASE}/chain-arc.svg`,
};

export const SWEEP_MARK = `${BASE}/sweep-mark.png`;
export const USDC_TOKEN = `${BASE}/token-usdc.svg`;
export const METAMASK_LOGO = `${BASE}/metamask-logo.svg`;
export const CIRCLE_LOGO = `${BASE}/circle-logo.png`;

export function isChainKey(k: string): k is ChainKey {
  return k in CHAIN_ASSET;
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
  return (
    <img
      src={CHAIN_ASSET[chain]}
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

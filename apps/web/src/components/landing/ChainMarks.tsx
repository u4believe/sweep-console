/**
 * Chain marks, taken verbatim from the design's own inline SVGs.
 *
 * Each fills from a design token rather than a fixed hex, so the marks follow
 * the theme — ink on the ground by default, accent where the design calls for
 * emphasis (the "settle on Arc" end of the chain rail).
 */

interface MarkProps {
  height?: number;
  /** Fill with the accent instead of the ink colour. */
  accent?: boolean;
}

const fillOf = (accent?: boolean) => (accent ? "var(--color-accent)" : "var(--color-text)");

export function ArcMark({ height = 19, accent }: MarkProps) {
  return (
    <svg
      viewBox="0 0 31 32"
      height={height}
      aria-label="Arc"
      style={{ display: "block", flex: "none", height, width: "auto" }}
    >
      <path
        d="M0 32C0.260374 24.166 1.59328 16.8547 3.82135 11.1696C6.64316 3.96673 10.728 0 15.3227 0C19.9174 0 24.0016 3.96673 26.824 11.1696C28.292 14.9157 29.372 19.3668 30.0119 24.2089C30.0691 24.6414 30.1178 25.0809 30.1678 25.5195C30.184 25.5466 30.1938 25.5718 30.1905 25.5923C30.1905 25.5923 30.5666 27.9326 30.6465 32H30.604C30.0462 31.5439 23.4681 26.3931 12.5636 27.8845C12.7282 26.0457 12.9544 24.2565 13.2467 22.5415C13.2617 22.4538 13.2789 22.3692 13.2942 22.2821C17.5711 22.1536 21.3146 22.6486 24.1853 23.2972C24.1746 23.2293 24.1657 23.1594 24.1547 23.0918C23.5647 19.4302 22.6941 16.0779 21.5717 13.2131C19.7364 8.52888 17.3416 5.61852 15.3227 5.61852C13.3038 5.61852 10.909 8.52888 9.07379 13.2131C8.62954 14.3462 8.22512 15.5545 7.86244 16.8291C7.35258 18.615 6.92424 20.5296 6.58214 22.5413C6.0758 25.5124 5.75944 28.6987 5.64292 32H0Z"
        fill={fillOf(accent)}
      />
    </svg>
  );
}

export function BaseMark({ height = 19, accent }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" width={height} height={height} aria-label="Base" style={{ display: "block", flex: "none" }}>
      <path d="M18.5 3.13 A 11 11 0 1 0 18.5 20.87 Z" fill={fillOf(accent)} />
    </svg>
  );
}

export function ArbitrumMark({ height = 19, accent }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" width={height} height={height} aria-label="Arbitrum" style={{ display: "block", flex: "none" }}>
      <path d="M12 1.4 21.1 6.7 V17.3 L12 22.6 L2.9 17.3 V6.7 Z" fill="none" stroke={fillOf(accent)} strokeWidth="1.7" />
      <path d="M12 6.4 15.7 16.2 H13.7 L12 11.5 L10.3 16.2 H8.3 Z" fill={fillOf(accent)} />
    </svg>
  );
}

export function OptimismMark({ height = 19, accent }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" width={height} height={height} aria-label="Optimism" style={{ display: "block", flex: "none" }}>
      <circle cx="12" cy="12" r="11" fill={fillOf(accent)} />
      <circle cx="8.7" cy="12.6" r="2.9" fill="none" stroke="var(--color-bg)" strokeWidth="1.9" />
      <path
        d="M14.4 16.1 V9.1 h2.5 a2.2 2.2 0 0 1 0 4.4 H14.4"
        fill="none"
        stroke="var(--color-bg)"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * A simplified MetaMask fox, drawn as flat facets rather than traced from the
 * brand asset: enough to be recognised beside "Connect wallet", small enough to
 * stay legible at 18px, and no binary to ship.
 */
export function MetaMaskMark({ height = 18 }: { height?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={height}
      height={height}
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    >
      {/* ears */}
      <path d="M3 3.2 10.1 8.0 8.9 4.6Z" fill="#E2761B" />
      <path d="M21 3.2 13.9 8.05 15.1 4.6Z" fill="#E2761B" />
      {/* jaw */}
      <path d="M4.6 16.2 6.3 19.3 9.0 18.3 8.0 16.3Z" fill="#E4761B" />
      <path d="M19.4 16.2 17.7 19.3 15.0 18.3 16.0 16.3Z" fill="#E4761B" />
      {/* brow and head */}
      <path d="M8.9 4.6 10.1 8.0 13.9 8.05 15.1 4.6 12 3.5Z" fill="#F6851B" />
      <path d="M10.1 8.0 8.0 11.6 8.0 16.3 16.0 16.3 16.0 11.6 13.9 8.05Z" fill="#F6851B" />
      {/* snout */}
      <path d="M8.0 16.3 16.0 16.3 15.0 18.3 9.0 18.3Z" fill="#C0AD9E" />
      <path d="M9.0 18.3 12 19.4 15.0 18.3 12 17.3Z" fill="#D7C1B3" />
    </svg>
  );
}

import type { FC } from "react";

// Brand-colored chain logo badges used on the crypto checkout. Inline SVG so
// they render offline with no asset pipeline.

// The official Arc network mark (arch "A" symbol from arc.io) on a navy badge.
export function ArcLogo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="arc-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2c416a" />
          <stop offset="1" stopColor="#0a1124" />
        </linearGradient>
        <linearGradient id="arc-arch" x1="0.3" y1="0" x2="0.7" y2="1" gradientUnits="objectBoundingBox">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.6" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="22" fill="url(#arc-bg)" />
      <g transform="translate(26 22) scale(1.12)">
        <path
          fill="url(#arc-arch)"
          d="M23.8574 0C31.0115 0 37.371 6.19775 41.7656 17.4521C44.0513 23.3056 45.7332 30.2603 46.7295 37.8262C46.8186 38.5019 46.8939 39.1888 46.9717 39.874C46.9969 39.9162 47.0119 39.9553 47.0068 39.9873C47.0068 39.9873 47.5924 43.6447 47.7168 50H47.6514C46.7829 49.2873 36.54 41.2389 19.5615 43.5693C19.8177 40.6962 20.1699 37.9004 20.625 35.2207C20.6482 35.0838 20.6755 34.9514 20.6992 34.8154C27.3585 34.6146 33.1876 35.3879 37.6572 36.4014C37.6406 36.2954 37.6263 36.1865 37.6094 36.0811C36.6906 30.3599 35.3355 25.1217 33.5879 20.6455C30.7304 13.3264 27.001 8.77832 23.8574 8.77832C20.7141 8.77863 16.9853 13.3266 14.1279 20.6455C13.4363 22.4157 12.8068 24.3036 12.2422 26.2949C11.4483 29.0854 10.7807 32.0773 10.248 35.2207C9.45968 39.8629 8.96755 44.8418 8.78613 50H0C0.405408 37.7593 2.48104 26.3352 5.9502 17.4521C10.3437 6.19798 16.7036 0.000184295 23.8574 0Z"
        />
      </g>
    </svg>
  );
}

export function BaseLogo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#0052FF" />
      <path
        fill="#fff"
        d="M15.97 26.88c5.98 0 10.83-4.85 10.83-10.84S21.95 5.2 15.97 5.2C10.3 5.2 5.64 9.57 5.18 15.13h14.34v1.82H5.18c.46 5.56 5.12 9.93 10.79 9.93z"
      />
    </svg>
  );
}

export function ArbitrumLogo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#213147" />
      <path fill="#12AAFF" d="M16.9 9.6l4.7 8.1-2.4 1.4-4.7-8.1z" />
      <path fill="#9DCCED" d="M14.5 13.3l2.4 4.1-2.4 4.2-2.4-4.1z" />
      <path fill="#fff" d="M16 7.1l6.6 11.4-2.2 1.3L16 11.6l-4.4 8.2-2.2-1.3z" opacity=".0" />
      <path fill="#fff" d="M11.2 18.9l2.3-4 1.2 2.1-1.4 2.5 4.1 2.4-1.2 2.1z" opacity="0" />
      <path
        fill="#fff"
        d="M15.1 8.7c.5-.9 1.4-.9 1.9 0l5.7 9.9c.3.6.1 1-.5 1.3l-1.6.9-5.6-9.8-3.4 6 2.3 1.3-1.4.8c-.6.3-1 .1-1.3-.5l-1-1.7c-.3-.5-.3-1 0-1.5z"
      />
    </svg>
  );
}

export function OptimismLogo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#FF0420" />
      <path
        fill="#fff"
        d="M11.3 19.6c-1 0-1.8-.24-2.43-.7-.62-.48-.93-1.16-.93-2.04 0-.18.02-.4.06-.66.11-.6.27-1.33.47-2.18.58-2.34 2.07-3.5 4.48-3.5.65 0 1.24.11 1.76.33.52.21.93.53 1.23.96.3.42.45.92.45 1.5 0 .17-.02.39-.06.65-.13.74-.29 1.46-.48 2.18-.3 1.16-.81 2.03-1.55 2.61-.74.57-1.73.86-2.97.86zm.18-1.83c.48 0 .89-.14 1.22-.43.34-.29.58-.73.73-1.32.21-.84.36-1.57.47-2.19.04-.18.06-.37.06-.56 0-.78-.41-1.17-1.22-1.17-.48 0-.9.14-1.24.43-.33.29-.57.73-.72 1.32-.16.62-.33 1.35-.49 2.19-.04.17-.06.35-.06.55 0 .79.42 1.18 1.25 1.18z"
      />
      <path
        fill="#fff"
        d="M17.3 19.46c-.09 0-.16-.03-.21-.09-.04-.07-.05-.14-.04-.23l1.55-7.3c.02-.1.07-.18.15-.24.08-.06.16-.09.25-.09h2.99c.83 0 1.5.17 2 .52.51.34.77.84.77 1.49 0 .19-.02.38-.07.59-.19.9-.59 1.56-1.18 1.99-.58.43-1.38.64-2.4.64h-1.52l-.52 2.4c-.02.1-.07.18-.15.24-.08.06-.16.09-.25.09zm3.45-4.36c.33 0 .61-.09.85-.27.25-.18.41-.44.49-.78.02-.13.04-.25.04-.35 0-.22-.06-.38-.19-.5-.13-.12-.35-.18-.65-.18h-1.35l-.44 2.08z"
      />
    </svg>
  );
}

export type ChainKey = "base" | "arbitrum" | "optimism";

const LOGOS: Record<ChainKey, FC<{ className?: string }>> = {
  base: BaseLogo,
  arbitrum: ArbitrumLogo,
  optimism: OptimismLogo,
};

const LABELS: Record<ChainKey, string> = {
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
};

export function ChainBadge({
  chain,
  selected,
  onClick,
  disabled,
}: {
  chain: ChainKey;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const Logo = LOGOS[chain];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-1 flex-col items-center gap-2 rounded-xl border px-3 py-3 transition disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? "border-brand-500 bg-brand-50 ring-2 ring-brand-500/30"
          : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
      }`}
    >
      <Logo className="h-7 w-7" />
      <span className="text-xs font-medium text-gray-700">{LABELS[chain]}</span>
    </button>
  );
}

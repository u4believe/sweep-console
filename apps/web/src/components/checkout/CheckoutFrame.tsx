import type { ReactNode } from "react";

export const RULE = "1px solid var(--color-divider)";
export const HAIRLINE = "1px solid var(--color-divider)";

export type Rail = "pick" | "pay" | "done";

const STEPS: { id: Rail; n: string; label: string }[] = [
  { id: "pick", n: "01", label: "Choose a plan" },
  { id: "pay", n: "02", label: "Payment details" },
  { id: "done", n: "03", label: "Confirmation" },
];

/**
 * The chrome every checkout step sits inside: the merchant header, the step
 * rail, and the surface ground the content floats on.
 *
 * The rail is a progress indicator, not navigation — steps aren't clickable,
 * because moving between them has to go through the flow's own guards (email
 * verification, tier sync). "Change plan" in the payment column is the one
 * supported way back.
 */
export function CheckoutFrame({
  merchant,
  isTestMode,
  cancelUrl,
  rail,
  children,
}: {
  merchant: { name: string };
  isTestMode: boolean;
  cancelUrl: string;
  rail: Rail;
  children: ReactNode;
}) {
  const activeIdx = STEPS.findIndex((s) => s.id === rail);

  return (
    <div
      className="flex min-h-screen flex-col"
      style={{ background: "var(--color-neutral-200)", color: "var(--color-text)" }}
    >
      <header
        className="flex flex-wrap items-center gap-3.5"
        style={{
          padding: "16px clamp(18px,3vw,32px)",
          background: "var(--color-bg)",
          borderBottom: RULE,
        }}
      >
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 16, letterSpacing: "-0.01em" }}>
          {merchant.name}
        </span>
        {/* Short. The sentence it replaces — "no real USDC is charged" — is
            the one thing this badge must never say on a live checkout, and at
            full length it read as a banner rather than a state. */}
        {isTestMode && (
          <span
            style={{
              fontSize: 11, fontWeight: 600, padding: "4px 9px", borderRadius: 5,
              background: "var(--color-accent-200)", color: "var(--color-accent)",
            }}
          >
            Test mode
          </span>
        )}
        <button
          type="button"
          className="swp-navitem ml-auto cursor-pointer"
          style={{
            width: 32, height: 32, display: "grid", placeItems: "center",
            border: 0, borderRadius: 8, background: "transparent",
            color: "var(--color-neutral-800)", fontSize: 20, lineHeight: 1,
          }}
          onClick={() => window.location.assign(cancelUrl)}
          aria-label="Cancel checkout"
        >
          ×
        </button>
      </header>

      <div
        className="flex overflow-x-auto"
        style={{ background: "var(--color-bg)", borderBottom: RULE, padding: "0 clamp(8px,2vw,20px)" }}
      >
        {STEPS.map((s, i) => {
          const done = i < activeIdx;
          const on = i === activeIdx;
          return (
            <div
              key={s.id}
              className="flex items-center gap-2.5 whitespace-nowrap"
              style={{
                borderBottom: `2px solid ${on ? "var(--color-accent)" : "transparent"}`,
                color: on ? "var(--color-accent)" : done ? "var(--color-text)" : "var(--color-neutral-700)",
                padding: "13px 14px 11px",
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  color: on ? "var(--color-accent)" : "var(--color-neutral-700)",
                }}
              >
                {s.n}
              </span>
              {s.label}
            </div>
          );
        })}
      </div>

      {/* 1040, not 1180: the content is one 540px card now rather than a
          full-bleed two-column split, and the wider frame left it adrift. */}
      <div className="w-full flex-1" style={{ maxWidth: 1040, margin: "0 auto" }}>
        {children}
      </div>
    </div>
  );
}

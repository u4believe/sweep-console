import type { ReactNode } from "react";

export const RULE = "2px solid var(--color-divider)";
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
      style={{ background: "var(--color-surface)", color: "var(--color-text)" }}
    >
      <header
        className="flex flex-wrap items-center gap-3.5"
        style={{ padding: "16px 32px", background: "var(--color-bg)", borderBottom: RULE }}
      >
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 16 }}>
          {merchant.name}
        </span>
        {isTestMode && (
          <span className="tag tag-accent ml-auto">Test mode — no real USDC is charged</span>
        )}
        <button
          type="button"
          className={`btn btn-ghost${isTestMode ? "" : " ml-auto"}`}
          style={{ color: "var(--color-neutral-700)", fontSize: 12 }}
          onClick={() => window.location.assign(cancelUrl)}
          aria-label="Cancel checkout"
        >
          ✕
        </button>
      </header>

      <div
        className="flex overflow-x-auto"
        style={{ background: "var(--color-bg)", borderBottom: RULE, padding: "0 32px" }}
      >
        {STEPS.map((s, i) => {
          const done = i < activeIdx;
          const on = i === activeIdx;
          return (
            <div
              key={s.id}
              className="flex items-center gap-2.5 whitespace-nowrap"
              style={{
                borderBottom: `3px solid ${on ? "var(--color-accent)" : "transparent"}`,
                color: on || done ? "var(--color-text)" : "var(--color-neutral-600)",
                padding: "13px 22px 11px",
                fontSize: 13,
              }}
            >
              <span
                style={{
                  fontFamily: "ui-monospace, Menlo, monospace",
                  fontSize: 11,
                  color: on ? "var(--color-accent)" : "var(--color-neutral-600)",
                }}
              >
                {s.n}
              </span>
              {s.label}
            </div>
          );
        })}
      </div>

      <div className="mx-auto w-full flex-1" style={{ maxWidth: 1180 }}>
        {children}
      </div>
    </div>
  );
}

import { useState } from "react";
import { Section } from "@/components/portal/primitives";
import { WithdrawSection } from "./WithdrawSection";
import { PayoutRoutesSection } from "./PayoutRoutesSection";

/**
 * One withdrawal, two destinations.
 *
 * These were two stacked cards, which read as two different features and
 * invited the question the dashboard should never raise: which of these is
 * the withdrawal? They are the same act — move my revenue out — differing
 * only in where it lands, so they are one card with a choice at the top and
 * exactly one form beneath it.
 *
 * The choice is not remembered between visits. Same-chain is the ordinary
 * case and the safe default; a creator who last used the cross-chain path
 * should still be shown the plain one first rather than find a foreign
 * address field waiting for them.
 */
type Mode = "same" | "cross";

const TABS: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "same", label: "Withdraw", hint: "To an address on the same chain" },
  { id: "cross", label: "Cross-chain withdraw", hint: "To Solana, Polygon, Tron and more" },
];

export function WithdrawPanel({ walletId }: { walletId: string }) {
  const [mode, setMode] = useState<Mode>("same");

  return (
    <Section title="Withdraw revenue">
      {/* A segmented control rather than a dropdown: there are two options,
          both worth naming, and a creator should be able to see the other one
          exists without opening anything. */}
      <div
        role="tablist"
        aria-label="Withdrawal type"
        className="mb-4 inline-flex"
        style={{
          border: "1px solid var(--color-divider)",
          borderRadius: "var(--radius-md)",
          padding: 3,
          gap: 3,
        }}
      >
        {TABS.map((t) => {
          const on = mode === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              type="button"
              onClick={() => setMode(t.id)}
              title={t.hint}
              style={{
                font: "inherit",
                fontSize: 12.5,
                fontWeight: 600,
                padding: "7px 14px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                cursor: "pointer",
                background: on ? "var(--color-accent)" : "transparent",
                color: on ? "#fff" : "var(--color-neutral-700)",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Keyed, so switching tabs starts the other flow clean rather than
          carrying a half-filled address or a stale quote across. */}
      {mode === "same" ? (
        <WithdrawSection key="same" walletId={walletId} embedded />
      ) : (
        <PayoutRoutesSection key="cross" embedded />
      )}
    </Section>
  );
}

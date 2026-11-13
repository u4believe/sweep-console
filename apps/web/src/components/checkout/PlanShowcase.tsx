import { useState } from "react";
import { formatUnits } from "viem";
import { HAIRLINE } from "./CheckoutFrame";
import { settlementNote } from "@/lib/useSweepConfig";

// Matches CheckoutShell's labels exactly — a preview that priced differently
// from the real thing would be worse than no preview.
const INTERVAL_LABELS: Record<string, string> = {
  daily: "/ day",
  weekly: "/ week",
  monthly: "/ month",
  yearly: "/ year",
};

/**
 * The checkout's blue, solid.
 *
 * `.btn-primary` fills with --color-accent-fill, a gradient that runs out to
 * #6B6EEA — on a full-width button that violet end is most of what the eye
 * sees, so step 01 read purple beside step 02's solid-blue chain selection.
 * One flat accent here makes the two steps the same colour.
 */
const ACCENT_SOLID = "var(--color-accent)";

/** One choosable option, priced. The plan's own terms are the tier with a null id. */
export interface ShowcaseTier {
  id: string | null;
  name: string;
  amount: number;
  interval: string;
  trialDays: number;
  features: string[];
}

/**
 * Checkout step 01 — choose a plan — drawn in step 02's language.
 *
 * It was a full-width pricing table: a 52px headline over separate cards, each
 * with its own button. Step 02 is one centred 540px card with a hairline
 * header row and radio rows marked by an accent bar. Two steps of one
 * checkout looked like two different products, so this is now the same card:
 * a header, one row per tier, the selected tier's features beneath it, and a
 * single button.
 *
 * It lives apart from CheckoutShell so the merchant portal can render the exact
 * same markup as a preview. A preview must not be a checkout in a costume: it
 * omits onChoose, and with no handler there is nothing here that can reach a
 * session, a wallet, or a payment — the rows still select, so a merchant can
 * see each tier's features, but the button is inert.
 */
export function PlanShowcase({
  merchantName,
  description,
  tierOptions,
  recommendedTierId,
  onChoose,
}: {
  merchantName: string;
  description?: string | null;
  tierOptions: ShowcaseTier[];
  /** A tier id, or the literal "default" for the plan's own terms. Null = no badge. */
  recommendedTierId?: string | null;
  /** Omit to render an inert button (preview). */
  onChoose?: (tierId: string | null) => void;
}) {
  // The merchant picks the recommended tier on the plan screen. No pick means
  // no badge — a guess and a deliberate choice would look identical.
  const isRecommended = (t: ShowcaseTier) =>
    recommendedTierId === "default" ? t.id === null : !!recommendedTierId && t.id === recommendedTierId;

  // Start on the recommended tier when there is one, so the common case is a
  // single click; otherwise the first.
  const initial = tierOptions.find(isRecommended) ?? tierOptions[0];
  const [selected, setSelected] = useState<string | null>(initial?.id ?? null);
  const chosen = tierOptions.find((t) => t.id === selected) ?? initial;

  const price = (t: ShowcaseTier) => (t.amount === 0 ? "Free" : formatUnits(BigInt(t.amount), 6));

  return (
    <div
      className="mx-auto w-full"
      style={{ maxWidth: 1040, padding: "clamp(16px,3vw,28px) clamp(16px,3vw,32px) 22px" }}
    >
      {/* Same card as step 02: width, ground, radius, ring and shadow. */}
      <div
        className="mx-auto w-full"
        style={{
          maxWidth: 540,
          background: "var(--color-bg)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 0 0 1px var(--color-neutral-400), var(--shadow-lg)",
          overflow: "hidden",
        }}
      >
        {/* Header row, set like step 02's "Your plan" row. */}
        <div style={{ padding: "11px 18px 9px", borderBottom: HAIRLINE }}>
          <p
            className="m-0 uppercase"
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.1em",
              lineHeight: 1.3,
              color: "var(--color-neutral-800)",
            }}
          >
            Choose your plan
          </p>
          <p className="m-0 mt-1" style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.15 }}>
            {merchantName}
          </p>
          <p className="m-0 mt-1.5" style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--color-neutral-700)" }}>
            {description || "Pay in USDC from any supported chain. Cancel anytime from your own wallet."}
          </p>
        </div>

        {/* Tier rows — the chain rows' radio pattern: hairline between, a
            3px accent bar and surface fill on the selected one. */}
        <div role="radiogroup" aria-label="Plans" className="flex flex-col">
          {tierOptions.map((t, i) => {
            const on = (chosen?.id ?? null) === t.id;
            return (
              <button
                key={t.id ?? "default"}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setSelected(t.id)}
                className="flex items-center gap-3.5 text-left"
                style={{
                  background: on ? "var(--color-surface)" : "transparent",
                  border: 0,
                  borderTop: i === 0 ? 0 : HAIRLINE,
                  borderLeft: `3px solid ${on ? ACCENT_SOLID : "transparent"}`,
                  padding: "11px 18px 11px 15px",
                  cursor: "pointer",
                  fontFamily: "var(--font-body)",
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 14.5 }}>
                      {t.name}
                    </span>
                    {isRecommended(t) && <span className="tag tag-outline">Recommended</span>}
                  </span>
                  <span className="mt-0.5 block" style={{ fontSize: 11.5, color: "var(--color-neutral-700)" }}>
                    {t.trialDays > 0 ? `${t.trialDays}-day free trial` : "No trial"}
                  </span>
                </span>
                <span className="shrink-0" style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 14 }}>
                  {price(t)}{" "}
                  {t.amount > 0 && (
                    <span style={{ fontSize: 11.5, fontWeight: 500, color: "var(--color-neutral-700)" }}>
                      USDC {INTERVAL_LABELS[t.interval] ?? ""}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {/* What the selected tier includes — shown for one tier at a time, so
            the rows stay a comparison of name and price, as step 02 is. */}
        {chosen && (
          <div style={{ borderTop: HAIRLINE, padding: "12px 18px 4px" }}>
            <p
              className="m-0 uppercase"
              style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", color: "var(--color-neutral-800)" }}
            >
              {chosen.name} includes
            </p>
            <div className="mt-2 flex flex-col gap-[6px]">
              {(chosen.features.length ? chosen.features : ["Full access"]).map((f, i) => (
                <span key={i} className="flex gap-2.5" style={{ fontSize: 13, lineHeight: 1.45 }}>
                  <span style={{ color: ACCENT_SOLID, fontWeight: 700 }}>✓</span>
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        <div style={{ padding: "14px 18px 16px" }}>
          <button
            type="button"
            onClick={onChoose && chosen ? () => onChoose(chosen.id) : undefined}
            // Inert in preview: drawn, so the merchant sees the real card,
            // but not clickable.
            disabled={!onChoose}
            className="btn btn-block"
            style={{
              padding: "12px 16px",
              background: ACCENT_SOLID,
              color: "var(--color-accent-ink, #fff)",
              ...(onChoose ? {} : { cursor: "default", opacity: 1 }),
            }}
          >
            {chosen && chosen.amount === 0 ? "Start free →" : `Continue with ${chosen?.name ?? "this plan"} →`}
          </button>
          <p className="m-0 mt-2.5 text-center" style={{ fontSize: 11.5, color: "var(--color-neutral-700)" }}>
            {settlementNote()} · gasless renewals · one signature covers every supported chain
          </p>
        </div>
      </div>
    </div>
  );
}

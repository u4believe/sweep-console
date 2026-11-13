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
 * sees, so step 01 read purple beside step 02's solid-blue selection. One flat
 * accent makes the two steps the same colour.
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

/** The small uppercase label step 02 uses for "Your plan" and "Pay from". */
const kicker = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.1em",
  lineHeight: 1.3,
  color: "var(--color-neutral-800)",
} as const;

/** Step 02's mono row number, "01", "02" — accent, not body ink. */
const rowNumber = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 12,
  fontWeight: 600,
  color: ACCENT_SOLID,
  minWidth: 20,
} as const;

/**
 * Checkout step 01 — one card per plan, each drawn as step 02's card.
 *
 * The layout is the pricing table it always was: a heading, then a card per
 * tier side by side, each with its own button. What changed is the card. It
 * was a bordered box with a 54px price; it is now the payment-details card in
 * miniature — the same ring and shadow, a hairline header row with the plan
 * and its price, numbered hairline rows beneath, "Network fee · Covered" and
 * "Due today" as step 02 ends, and the same solid blue — so choosing a plan
 * and paying for it look like one checkout.
 *
 * It lives apart from CheckoutShell so the merchant portal can render the exact
 * same markup as a preview. A preview must not be a checkout in a costume: it
 * omits onChoose, and with no handler there is nothing here that can reach a
 * session, a wallet, or a payment — the cards simply have no live buttons.
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
  /** Omit to render inert cards (preview). */
  onChoose?: (tierId: string | null) => void;
}) {
  // The merchant picks this on the plan screen. No pick means no badge — a
  // guess and a deliberate choice would look identical.
  const recommendedId = recommendedTierId === "default" ? null : recommendedTierId ?? undefined;

  return (
    <div style={{ padding: "clamp(28px,5vw,52px) clamp(16px,3vw,32px) 44px" }}>
      <p
        className="m-0 uppercase"
        style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.14em", color: ACCENT_SOLID, marginBottom: 10 }}
      >
        {merchantName}
      </p>
      <h1
        className="m-0"
        style={{ fontSize: "clamp(34px, 5vw, 52px)", letterSpacing: "-0.04em", lineHeight: 1.02, marginBottom: 10 }}
      >
        Choose your plan
      </h1>
      <p className="m-0" style={{ fontSize: 15.5, lineHeight: 1.6, color: "var(--color-neutral-800)", marginBottom: 32 }}>
        {description || "Pay in USDC from any supported chain. Cancel anytime from your own wallet."}
      </p>

      {/* auto-fit sizes the track from the content: two tiers make two
          columns, five wrap, without being told how many there are. */}
      <div
        className="grid items-stretch"
        style={{ gap: 16, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,280px),1fr))" }}
      >
        {tierOptions.map((t) => {
          const free = t.amount === 0;
          const recommended = recommendedTierId === "default" ? t.id === null : t.id === recommendedId;
          const features = t.features.length ? t.features : ["Full access"];
          const amount = free ? "Free" : formatUnits(BigInt(t.amount), 6);
          const dueToday = free || t.trialDays > 0 ? "Free" : amount;

          return (
            <div
              key={t.id ?? "default"}
              className="flex flex-col"
              style={{
                background: "var(--color-bg)",
                borderRadius: "var(--radius-lg)",
                overflow: "hidden",
                // Step 02's ring and shadow. The recommended card swaps the
                // neutral ring for the accent one, as the selected chain row
                // swaps its bar.
                boxShadow: recommended
                  ? `0 0 0 2px ${ACCENT_SOLID}, var(--shadow-lg)`
                  : "0 0 0 1px var(--color-neutral-400), var(--shadow-lg)",
              }}
            >
              {/* Header row — step 02's "Your plan" row: name left, price right. */}
              <div
                className="flex flex-wrap items-baseline justify-between"
                style={{ gap: 10, padding: "11px 18px 9px", borderBottom: HAIRLINE }}
              >
                <div>
                  {/* Fixed height, so the Recommended tag (taller than the
                      kicker) cannot push one card's rows below its
                      neighbours'. Every header is the same height with or
                      without it. */}
                  <div className="flex items-center gap-2" style={{ height: 22 }}>
                    <p className="m-0 uppercase" style={kicker}>Plan</p>
                    {recommended && <span className="tag tag-outline">Recommended</span>}
                  </div>
                  <p className="m-0 mt-1" style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.15 }}>
                    {t.name}
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p className="m-0" style={{ fontWeight: 700, fontSize: 22, letterSpacing: "-0.03em", lineHeight: 1.15 }}>
                    {amount}{" "}
                    {!free && (
                      <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: 0, color: "var(--color-neutral-800)" }}>
                        USDC {INTERVAL_LABELS[t.interval] ?? ""}
                      </span>
                    )}
                  </p>
                  <p className="m-0 mt-0.5" style={{ fontSize: 12, color: "var(--color-neutral-800)" }}>
                    {t.trialDays > 0 ? `${t.trialDays}-day free trial` : "No trial"}
                  </p>
                </div>
              </div>

              {/* Numbered hairline rows, as step 02 numbers its email, wallet
                  and chain rows. */}
              <div className="flex flex-1 flex-col" style={{ padding: "2px 18px 0" }}>
                {features.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3"
                    style={{ padding: "10px 0", borderTop: i === 0 ? 0 : HAIRLINE, fontSize: 13.5, lineHeight: 1.4 }}
                  >
                    <span style={rowNumber}>{String(i + 1).padStart(2, "0")}</span>
                    <span>{f}</span>
                  </div>
                ))}
              </div>

              {/* Step 02's closing rows. */}
              <div style={{ padding: "0 18px" }}>
                <div
                  className="flex items-center justify-between"
                  style={{ borderTop: HAIRLINE, padding: "10px 0", fontSize: 13 }}
                >
                  <span>Network fee</span>
                  <span style={{ color: ACCENT_SOLID, fontWeight: 600 }}>Covered by Sweep Console</span>
                </div>
                <div
                  className="flex items-baseline justify-between"
                  style={{ borderTop: HAIRLINE, padding: "10px 0 12px" }}
                >
                  <span style={{ fontWeight: 700, fontSize: 14.5 }}>Due today</span>
                  <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: "-0.02em" }}>
                    {dueToday}{" "}
                    {dueToday !== "Free" && (
                      <span style={{ fontSize: 11.5, fontWeight: 500, color: "var(--color-neutral-700)" }}>USDC</span>
                    )}
                  </span>
                </div>
              </div>

              <div style={{ padding: "0 18px 16px" }}>
                <button
                  type="button"
                  onClick={onChoose ? () => onChoose(t.id) : undefined}
                  // Inert in preview: drawn, so the merchant sees the real
                  // card, but not clickable.
                  disabled={!onChoose}
                  className="btn btn-block"
                  style={{
                    padding: "12px 16px",
                    background: ACCENT_SOLID,
                    color: "var(--color-accent-ink, #fff)",
                    ...(onChoose ? {} : { cursor: "default", opacity: 1 }),
                  }}
                >
                  {free ? "Start free →" : `Choose ${t.name} →`}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="m-0" style={{ fontSize: 11.5, color: "var(--color-neutral-700)", marginTop: 18 }}>
        {settlementNote()} · gasless renewals · one signature covers every supported chain
      </p>
    </div>
  );
}

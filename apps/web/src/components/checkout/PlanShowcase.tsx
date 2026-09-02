import { formatUnits } from "viem";
import { RULE, HAIRLINE } from "./CheckoutFrame";

// Matches CheckoutShell's labels exactly — a preview that priced differently
// from the real thing would be worse than no preview.
const INTERVAL_LABELS: Record<string, string> = {
  daily: "/ day",
  weekly: "/ week",
  monthly: "/ month",
  yearly: "/ year",
};

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
 * The pricing table a subscriber sees before paying — the whole of checkout step
 * 01, minus the frame around it.
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
  // One "recommended" tier takes the surface fill, mirroring the landing pricing.
  // The merchant picks this on the plan screen. No pick means no badge — we
  // deliberately no longer guess at the middle card, because a guess and a
  // deliberate choice looked identical and there was no way to clear one.
  const recommendedId = recommendedTierId === "default" ? null : recommendedTierId ?? undefined;

  // Columns follow the tier count instead of always being three. Three was only
  // right at exactly three: two tiers left an empty column and a stretched gap,
  // and four or more wrapped into a ragged row. Four splits 2x2, six 3x3 — an odd
  // count above three has no even split, so it takes three and leaves a short
  // last row. Below md everything is one column, as before.
  const count = tierOptions.length;
  const columns = count <= 3 ? count : count % 3 === 0 ? 3 : count % 2 === 0 ? 2 : 3;
  // Written as whole literals so Tailwind's scanner emits these classes.
  const columnClass = columns === 3 ? "md:grid-cols-3" : columns === 2 ? "md:grid-cols-2" : "";

  return (
    <div style={{ padding: "44px 32px 64px" }}>
      <p
        className="m-0 uppercase"
        style={{ fontSize: 10, letterSpacing: "0.16em", color: "var(--color-accent)", marginBottom: 8 }}
      >
        {merchantName}
      </p>
      <h1
        className="m-0"
        style={{ fontSize: "clamp(32px, 5vw, 52px)", letterSpacing: "-0.035em", lineHeight: 1, marginBottom: 6 }}
      >
        Choose your plan
      </h1>
      <p className="m-0" style={{ fontSize: 15, color: "var(--color-neutral-800)", marginBottom: 32 }}>
        {description || "Pay in USDC from any supported chain. Cancel anytime from your own wallet."}
      </p>

      <div
        className={`grid ${columnClass}`}
        style={{ borderTop: RULE, borderBottom: RULE, background: "var(--color-bg)" }}
      >
        {tierOptions.map((t) => {
          const free = t.amount === 0;
          const recommended = recommendedTierId === "default" ? t.id === null : t.id === recommendedId;
          const features = t.features.length ? t.features : ["Full access"];
          return (
            <div
              key={t.id ?? "default"}
              className="flex flex-col gap-3"
              style={{
                padding: 28,
                borderLeft: HAIRLINE,
                background: recommended ? "var(--color-surface)" : "transparent",
              }}
            >
              <div className="flex items-center gap-2.5" style={{ minHeight: 22 }}>
                <span className="uppercase" style={{ fontSize: 11, letterSpacing: "0.14em" }}>{t.name}</span>
                {recommended && <span className="tag tag-outline">Recommended</span>}
              </div>

              <p
                className="m-0"
                style={{
                  fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 54,
                  lineHeight: 1, letterSpacing: "-0.04em",
                }}
              >
                {free ? "Free" : formatUnits(BigInt(t.amount), 6)}
                {!free && (
                  <span style={{ fontSize: 15, fontWeight: 400, color: "var(--color-neutral-700)" }}>
                    {INTERVAL_LABELS[t.interval] ?? ""}
                  </span>
                )}
              </p>

              <p className="m-0" style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>
                {t.trialDays > 0 ? `${t.trialDays}-day free trial` : "No trial"}
              </p>

              <div
                className="flex flex-col gap-[7px]"
                style={{ borderTop: HAIRLINE, paddingTop: 16, marginTop: 4 }}
              >
                {features.map((f, i) => (
                  <span key={i} className="flex gap-2.5" style={{ fontSize: 13, lineHeight: 1.45 }}>
                    <span style={{ color: "var(--color-accent)", fontFamily: "var(--font-heading)", fontWeight: 800 }}>
                      —
                    </span>
                    {f}
                  </span>
                ))}
              </div>

              <button
                type="button"
                onClick={onChoose ? () => onChoose(t.id) : undefined}
                // Inert in preview: still drawn, so the merchant sees the real
                // card, but not focusable and not clickable.
                disabled={!onChoose}
                className="btn btn-primary btn-block"
                style={{
                  marginTop: "auto",
                  padding: "12px 16px",
                  ...(onChoose ? {} : { cursor: "default", opacity: 1 }),
                }}
              >
                {free ? "Start free →" : `Choose ${t.name} →`}
              </button>
            </div>
          );
        })}
      </div>

      <p className="m-0" style={{ fontSize: 11.5, color: "var(--color-neutral-700)", marginTop: 16 }}>
        Settled on Arc · gasless renewals · one signature covers every supported chain
      </p>
    </div>
  );
}

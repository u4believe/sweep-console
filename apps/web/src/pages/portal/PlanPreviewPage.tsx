import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CheckoutFrame } from "@/components/checkout/CheckoutFrame";
import { PlanShowcase, type ShowcaseTier } from "@/components/checkout/PlanShowcase";
import { featureList, type Plan } from "./plan-model";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * How this plan's pricing will look to a subscriber — and nothing more.
 *
 * "Preview checkout" used to point at the payment link, which mints a real
 * checkout session and drops the merchant into the payment flow: wallet prompts,
 * an OTP to their own inbox, a live session burned on every look. This renders
 * the same pricing table from the merchant's own plan data instead. There is no
 * session, no wallet, no OTP and no payment path reachable from here — the cards'
 * buttons are inert, because PlanShowcase is given no onChoose.
 */
export function PlanPreviewPage() {
  const { planId = "" } = useParams();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [merchantName, setMerchantName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/portal/plans`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Plan[]; error?: { message?: string } }) => {
        const match = json.data?.find((p) => p.id === planId);
        if (match) setPlan(match);
        else setError(json.error?.message ?? "That plan no longer exists.");
      })
      .catch(() => setError("Could not reach the API server"));

    // The subscriber sees the merchant's own name in the checkout header.
    fetch(`${API_URL}/portal/me`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: { name?: string } }) => setMerchantName(json.data?.name ?? ""))
      .catch(() => { /* falls back to the plan name below */ });
  }, [planId]);

  // Every option a subscriber can pick, default tier first — the same shape and
  // order CheckoutShell builds.
  const tierOptions: ShowcaseTier[] = useMemo(() => {
    if (!plan) return [];
    return [
      {
        id: null,
        name: plan.default_tier_name || plan.name,
        amount: plan.amount,
        interval: plan.interval,
        trialDays: plan.trial_days,
        features: featureList(plan.default_features),
      },
      ...(plan.tiers ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        amount: t.amount,
        interval: t.interval,
        trialDays: t.trial_days,
        features: featureList(t.features),
      })),
    ];
  }, [plan]);

  if (error || !plan) {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        style={{ background: "var(--color-surface)", padding: "0 32px" }}
      >
        <div style={{ maxWidth: 560, width: "100%", borderTop: "2px solid var(--color-divider)", paddingTop: 28 }}>
          <h1 className="m-0" style={{ fontSize: "clamp(28px, 4vw, 44px)", letterSpacing: "-0.03em", marginBottom: 10 }}>
            {error ? "Preview unavailable" : "Loading preview…"}
          </h1>
          <p className="m-0" style={{ fontSize: 15, color: "var(--color-neutral-800)" }}>
            {error || "One moment while we fetch this plan."}
          </p>
          {error && (
            <Link className="btn btn-secondary" style={{ marginTop: 20, padding: "9px 14px" }} to="/plans">
              ← Back to plans
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Unmistakably a preview: the frame below is a faithful copy of the
          subscriber's screen, so it needs a banner that is not. */}
      <div
        className="flex flex-wrap items-center gap-3"
        style={{
          padding: "10px 32px",
          background: "var(--color-text)",
          color: "var(--color-bg)",
          fontSize: 12.5,
        }}
      >
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800 }}>Preview</span>
        <span style={{ opacity: 0.75 }}>
          How “{plan.name}” appears to a subscriber. Nothing here is live — no payment can be made.
          {tierOptions.length === 1 &&
            " With a single tier, checkout skips this screen and opens on payment details."}
        </span>
        <Link
          to={`/plans/${plan.id}`}
          className="ml-auto"
          style={{ color: "var(--color-bg)", textDecoration: "underline", whiteSpace: "nowrap" }}
        >
          ← Back to plan
        </Link>
      </div>

      <CheckoutFrame
        merchant={{ name: merchantName || plan.name }}
        isTestMode
        // The frame's ✕ cancels a checkout; in a preview it just goes back.
        cancelUrl={`/plans/${plan.id}`}
        rail="pick"
      >
        <PlanShowcase
          merchantName={merchantName || plan.name}
          description={plan.description}
          tierOptions={tierOptions}
          recommendedTierId={plan.recommended_tier_id}
        />
      </CheckoutFrame>
    </>
  );
}

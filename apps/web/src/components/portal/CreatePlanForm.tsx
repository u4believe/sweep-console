import { useState } from "react";
import { useNavigate } from "react-router-dom";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const INTERVALS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
] as const;

/**
 * Creates a plan and its FIRST tier — and stops there.
 *
 * A plan's own name/price/interval/trial are its default tier; every further
 * tier is added afterwards on the plan screen, one at a time, each by its own
 * scoped request. This form deliberately does not collect a second tier: the
 * previous version created the plan and then looped POSTs for every tier draft,
 * logging failures to the console, so a tier could silently fail to exist while
 * the merchant was told the plan was created.
 *
 * Price and interval are permanent once saved — subscriptions snapshot them at
 * checkout — so they are stated as permanent here rather than after the fact.
 */
export function CreatePlanForm() {
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tierName, setTierName] = useState("");
  const [price, setPrice] = useState("");
  const [interval, setInterval] = useState<string>("monthly");
  const [trialDays, setTrialDays] = useState("0");
  const [features, setFeatures] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const priceNum = Number(price);
  const trialNum = Number(trialDays);
  const priceValid = Number.isFinite(priceNum) && priceNum > 0;
  const trialValid = Number.isInteger(trialNum) && trialNum >= 0 && trialNum <= 365;
  const valid = name.trim().length > 0 && priceValid && trialValid;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError("");

    try {
      const featureList = features.split("\n").map((s) => s.trim()).filter(Boolean);
      const metadata: Record<string, unknown> = {};
      if (tierName.trim()) metadata.defaultTierName = tierName.trim();
      if (featureList.length) metadata.defaultFeatures = featureList;

      const res = await fetch(`${API_URL}/portal/plans`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          // USDC micro-units — round so a price like 29.99 doesn't land on .9999
          amount: Math.round(priceNum * 1_000_000),
          currency: "USDC",
          interval,
          trial_days: trialNum,
          metadata,
        }),
      });
      const data = (await res.json()) as { id?: string; error?: { message?: string } };
      if (!res.ok || !data.id) throw new Error(data.error?.message ?? "Couldn't create the plan.");

      // Straight to the plan, where further tiers are added one at a time.
      navigate(`/plans/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the plan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div style={{ borderTop: "2px solid var(--color-divider)", paddingTop: 20 }}>
        <p
          className="m-0 uppercase"
          style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-neutral-600)", marginBottom: 12 }}
        >
          Plan
        </p>

        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <div className="field">
            <label htmlFor="plan-name">Plan name</label>
            <input
              id="plan-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Pro"
              maxLength={60}
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="plan-desc">Description — optional</label>
            <input
              id="plan-desc"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Full access to every feature"
              maxLength={200}
            />
          </div>
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--color-divider)", marginTop: 22, paddingTop: 20 }}>
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <p
            className="m-0 uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-neutral-600)" }}
          >
            First tier
          </p>
          <span className="tag tag-neutral">Price &amp; interval permanent once saved</span>
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <div className="field">
            <label htmlFor="tier-name">Tier name — optional</label>
            <input
              id="tier-name"
              className="input"
              value={tierName}
              onChange={(e) => setTierName(e.target.value)}
              placeholder="Defaults to the plan name"
              maxLength={60}
            />
          </div>
          <div className="field">
            <label htmlFor="tier-price">Price (USDC)</label>
            <input
              id="tier-price"
              className="input"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="29.00"
              inputMode="decimal"
            />
          </div>
          <div className="field">
            <label htmlFor="tier-interval">Interval</label>
            <select
              id="tier-interval"
              className="input"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>{i.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tier-trial">Trial days</label>
            <input
              id="tier-trial"
              className="input"
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
              inputMode="numeric"
            />
          </div>
        </div>

        <div className="field mt-3">
          <label htmlFor="tier-feats">Features — one per line</label>
          <textarea
            id="tier-feats"
            className="input"
            style={{ minHeight: 92 }}
            value={features}
            onChange={(e) => setFeatures(e.target.value)}
            placeholder={"Unlimited projects\nPriority support"}
          />
        </div>

        {price.length > 0 && !priceValid && (
          <p className="m-0 mt-2" style={{ fontSize: 12, color: "var(--color-accent-700)" }}>
            Enter a price above zero.
          </p>
        )}
        {!trialValid && (
          <p className="m-0 mt-2" style={{ fontSize: 12, color: "var(--color-accent-700)" }}>
            Trial days must be a whole number between 0 and 365.
          </p>
        )}
      </div>

      {error && (
        <p className="m-0" style={{ marginTop: 16, fontSize: 13, color: "var(--color-accent-700)" }}>
          {error}
        </p>
      )}

      <div
        className="flex flex-wrap items-center gap-3"
        style={{ borderTop: "2px solid var(--color-divider)", marginTop: 24, paddingTop: 20 }}
      >
        <button
          type="submit"
          className="btn btn-primary"
          style={{ padding: "12px 20px" }}
          disabled={!valid || saving}
        >
          {saving ? "Creating…" : "Create plan"}
        </button>
        <span style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>
          You get a shareable checkout link straight away.
        </span>
      </div>

      <p
        className="m-0"
        style={{ fontSize: 12, color: "var(--color-neutral-700)", marginTop: 14, maxWidth: "62ch", lineHeight: 1.6 }}
      >
        Add more tiers on the next screen, one at a time. Each is created independently, appears on
        the same checkout link the moment it exists, and can be removed later without touching the
        others.
      </p>
    </form>
  );
}

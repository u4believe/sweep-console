import { useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const INTERVALS = ["daily", "weekly", "monthly", "yearly"] as const;

/**
 * Creates ONE new tier on an existing plan.
 *
 * Price and interval are set here and only here — once the tier exists they are
 * fixed, because subscriptions snapshot them at checkout. Creating a tier is a
 * single scoped request: it never rewrites or revalidates any sibling tier.
 */
export function AddTierForm({ planId, onAdded }: { planId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [interval, setInterval] = useState<string>("monthly");
  const [trialDays, setTrialDays] = useState("0");
  const [feats, setFeats] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    setName(""); setPrice(""); setInterval("monthly"); setTrialDays("0"); setFeats("");
    setError("");
  }

  const priceNum = Number(price);
  const trialNum = Number(trialDays);
  const valid =
    name.trim().length > 0 &&
    Number.isFinite(priceNum) && priceNum > 0 &&
    Number.isInteger(trialNum) && trialNum >= 0 && trialNum <= 365;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/portal/plans/${planId}/tiers`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          // USDC micro-units — round to avoid a float like 29.99 * 1e6 landing on .9999
          amount: Math.round(priceNum * 1_000_000),
          interval,
          trial_days: trialNum,
          features: feats.split("\n").map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? "Couldn't add the tier.");
      }
      reset();
      setOpen(false);
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the tier.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-secondary"
        style={{ marginTop: 16, padding: "9px 14px" }}
        onClick={() => setOpen(true)}
      >
        + Add tier
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      style={{ borderTop: "2px solid var(--color-divider)", marginTop: 16, paddingTop: 18 }}
    >
      <div className="mb-3 flex items-baseline gap-3">
        <h4 className="m-0" style={{ fontSize: 17 }}>New tier</h4>
        <p className="m-0" style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>
          Price and interval are permanent once saved.
        </p>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <div className="field">
          <label htmlFor="nt-name">Tier name</label>
          <input
            id="nt-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Pro"
            maxLength={60}
          />
        </div>
        <div className="field">
          <label htmlFor="nt-price">Price (USDC)</label>
          <input
            id="nt-price"
            className="input"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="29.00"
            inputMode="decimal"
          />
        </div>
        <div className="field">
          <label htmlFor="nt-interval">Interval</label>
          <select
            id="nt-interval"
            className="input"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          >
            {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="nt-trial">Trial days</label>
          <input
            id="nt-trial"
            className="input"
            value={trialDays}
            onChange={(e) => setTrialDays(e.target.value)}
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="field mt-3">
        <label htmlFor="nt-feats">Features — one per line</label>
        <textarea
          id="nt-feats"
          className="input"
          style={{ minHeight: 84 }}
          value={feats}
          onChange={(e) => setFeats(e.target.value)}
          placeholder={"Unlimited projects\nPriority support"}
        />
      </div>

      {error && (
        <p className="m-0 mt-2" style={{ fontSize: 12, color: "var(--color-accent-700)" }}>{error}</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button type="submit" className="btn btn-primary" style={{ padding: "9px 14px" }} disabled={!valid || saving}>
          {saving ? "Adding…" : "Add tier"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ color: "var(--color-neutral-700)" }}
          onClick={() => { reset(); setOpen(false); }}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const INTERVALS = [
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "weekly", label: "Weekly" },
  { value: "daily", label: "Daily" },
];

interface TierDraft {
  name: string;
  amount: string;
  interval: string;
  trial_days: string;
  features: string; // one feature per line
}

const toMicro = (dollars: string) => Math.round(parseFloat(dollars) * 1_000_000);
const parseFeatures = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

// ─── Small presentational helpers ─────────────────────────────────────────────

function SectionLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-brand-600">
        <span className="text-brand-400">❖</span>
        {children}
      </div>
      {hint && <p className="mt-0.5 text-sm text-gray-400">{hint}</p>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

/// The price / interval / trial row shared by every tier card.
function TierTerms({
  amount, interval, trialDays, onAmount, onInterval, onTrial,
}: {
  amount: string; interval: string; trialDays: string;
  onAmount: (v: string) => void; onInterval: (v: string) => void; onTrial: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <Field label="Price">
        <div className="relative">
          <span className="absolute left-3 top-2.5 text-gray-400">$</span>
          <input
            type="number" value={amount} onChange={(e) => onAmount(e.target.value)}
            min="0.01" step="0.01" placeholder="9.99" className="input-field w-full pl-7"
          />
        </div>
      </Field>
      <Field label="Interval">
        <select value={interval} onChange={(e) => onInterval(e.target.value)} className="input-field w-full">
          {INTERVALS.map((iv) => <option key={iv.value} value={iv.value}>{iv.label}</option>)}
        </select>
      </Field>
      <Field label="Trial">
        <input
          type="number" value={trialDays} onChange={(e) => onTrial(e.target.value)}
          min="0" max="365" placeholder="0" className="input-field w-full"
        />
      </Field>
    </div>
  );
}

export function CreatePlanForm() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Plan-level details.
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Default tier.
  const [defaultTierName, setDefaultTierName] = useState("");
  const [defaultFeatures, setDefaultFeatures] = useState("");
  const [amount, setAmount] = useState("");
  const [interval, setInterval] = useState("monthly");
  const [trialDays, setTrialDays] = useState("0");

  // Additional tiers.
  const [tiers, setTiers] = useState<TierDraft[]>([]);
  const addTier = () =>
    setTiers((t) => [...t, { name: "", amount: "", interval: "monthly", trial_days: "0", features: "" }]);
  const removeTier = (i: number) => setTiers((t) => t.filter((_, idx) => idx !== i));
  const updateTier = (i: number, field: keyof TierDraft, value: string) =>
    setTiers((t) => t.map((tier, idx) => (idx === i ? { ...tier, [field]: value } : tier)));

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const baseAmount = toMicro(amount);
    if (!name.trim() || !Number.isFinite(baseAmount) || baseAmount <= 0) {
      setError("Enter a plan name and a valid price for the default tier.");
      return;
    }
    for (const [i, t] of tiers.entries()) {
      const a = toMicro(t.amount);
      if (!t.name.trim() || !Number.isFinite(a) || a <= 0) {
        setError(`Tier ${i + 1} needs a name and a valid price.`);
        return;
      }
    }

    setLoading(true);
    try {
      const meta: Record<string, unknown> = {};
      if (defaultTierName.trim()) meta.defaultTierName = defaultTierName.trim();
      const defFeatures = parseFeatures(defaultFeatures);
      if (defFeatures.length) meta.defaultFeatures = defFeatures;

      const res = await fetch(`${API_URL}/portal/plans`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          amount: baseAmount,
          currency: "USDC",
          interval,
          trial_days: parseInt(trialDays || "0", 10),
          metadata: meta,
        }),
      });
      const data = (await res.json()) as { id?: string; error?: { message?: string } };
      if (!res.ok || !data.id) {
        setError(data.error?.message ?? "Failed to create plan");
        return;
      }

      for (const t of tiers) {
        const tierRes = await fetch(`${API_URL}/portal/plans/${data.id}/tiers`, {
          credentials: "include",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: t.name.trim(),
            amount: toMicro(t.amount),
            interval: t.interval,
            trial_days: parseInt(t.trial_days || "0", 10),
            features: parseFeatures(t.features),
          }),
        });
        if (!tierRes.ok) console.error("[create-plan] tier add failed", await tierRes.text().catch(() => ""));
      }

      navigate("/plans");
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {error && (
        <p className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          <span>⚠</span>{error}
        </p>
      )}

      {/* ─── Plan details ─────────────────────────────────────────── */}
      <section>
        <SectionLabel hint="Basic info shown to subscribers at checkout.">Plan details</SectionLabel>
        <div className="rounded-xl border border-dashed border-gray-300 p-5">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <Field label="Plan name" hint="Your product, e.g. Acme Pro.">
              <input
                type="text" value={name} onChange={(e) => setName(e.target.value)}
                required placeholder="Acme Pro" className="input-field w-full"
              />
            </Field>
            <Field label="Description" hint="Optional — a short line about the plan.">
              <input
                type="text" value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Full access to all features" className="input-field w-full"
              />
            </Field>
          </div>
        </div>
      </section>

      {/* ─── Pricing tiers ────────────────────────────────────────── */}
      <section>
        <SectionLabel hint="Subscribers pick one tier at checkout. The first card is the default — add more for extra price points.">
          Pricing tiers
        </SectionLabel>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Default tier */}
          <div className="rounded-xl border border-dashed border-brand-300 bg-brand-50/40 p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">Default tier</span>
            </div>
            <div className="space-y-3">
              <Field label="Tier name" hint="Shown in the checkout picker — defaults to the plan name.">
                <input
                  type="text" value={defaultTierName} onChange={(e) => setDefaultTierName(e.target.value)}
                  placeholder="Basic" className="input-field w-full"
                />
              </Field>
              <TierTerms
                amount={amount} interval={interval} trialDays={trialDays}
                onAmount={setAmount} onInterval={setInterval} onTrial={setTrialDays}
              />
              <Field label="Features" hint="One per line — listed under this tier at checkout.">
                <textarea
                  value={defaultFeatures} onChange={(e) => setDefaultFeatures(e.target.value)}
                  rows={3} placeholder={"Unlimited projects\nEmail support\nUp to 5 seats"}
                  className="input-field w-full"
                />
              </Field>
            </div>
          </div>

          {/* Additional tiers */}
          {tiers.map((t, i) => (
            <div key={i} className="rounded-xl border border-dashed border-gray-300 p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">Tier {i + 1}</span>
                <button type="button" onClick={() => removeTier(i)} className="text-xs font-medium text-red-600 hover:underline">
                  Remove
                </button>
              </div>
              <div className="space-y-3">
                <Field label="Tier name" hint="Shown in the checkout picker.">
                  <input
                    type="text" value={t.name} onChange={(e) => updateTier(i, "name", e.target.value)}
                    placeholder="Enterprise" className="input-field w-full"
                  />
                </Field>
                <TierTerms
                  amount={t.amount} interval={t.interval} trialDays={t.trial_days}
                  onAmount={(v) => updateTier(i, "amount", v)}
                  onInterval={(v) => updateTier(i, "interval", v)}
                  onTrial={(v) => updateTier(i, "trial_days", v)}
                />
                <Field label="Features" hint="One per line.">
                  <textarea
                    value={t.features} onChange={(e) => updateTier(i, "features", e.target.value)}
                    rows={3} placeholder={"Everything in Basic\nPriority support\nUnlimited seats"}
                    className="input-field w-full"
                  />
                </Field>
              </div>
            </div>
          ))}

          {/* Add tier */}
          <button
            type="button" onClick={addTier}
            className="flex min-h-[120px] items-center justify-center rounded-xl border-2 border-dashed border-gray-300 text-sm font-medium text-gray-500 hover:border-brand-400 hover:text-brand-600"
          >
            + Add another tier
          </button>
        </div>
      </section>

      {/* ─── Actions ──────────────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-3 pt-2">
        <button
          type="submit" disabled={loading}
          className="btn-primary w-full max-w-xs py-3 text-base disabled:opacity-50"
        >
          {loading
            ? "Creating…"
            : tiers.length > 0
              ? `Create plan + ${tiers.length} tier${tiers.length === 1 ? "" : "s"}`
              : "Create plan"}
        </button>
        <button type="button" onClick={() => navigate("/plans")} className="text-sm font-medium text-gray-500 hover:text-gray-700">
          Cancel
        </button>
      </div>
    </form>
  );
}

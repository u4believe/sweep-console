import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface Tier {
  id: string;
  name: string;
  amount: number;
  interval: string;
  trial_days: number;
}

interface Plan {
  id: string;
  name: string;
  description: string | null;
  amount: number;
  currency: string;
  interval: string;
  trial_days: number;
  subscribers: number;
  default_tier_name?: string | null;
  tiers?: Tier[];
}

interface PaymentLink {
  id: string;
  url: string;
  plan_id: string;
}

const INTERVAL_LABELS: Record<string, string> = {
  daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly",
};

function LinkCell({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="max-w-[200px] truncate rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">
        {url.replace(/^https?:\/\//, "")}
      </code>
      <button
        onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        className="rounded px-2 py-0.5 text-xs font-medium text-brand-600 hover:bg-brand-50"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

export function PlansPage() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Plan | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tierModal, setTierModal] = useState<Plan | null>(null);
  const [tierForm, setTierForm] = useState({ name: "", amount: "", interval: "monthly", trial_days: "0" });
  const [addingTier, setAddingTier] = useState(false);
  const [error, setError] = useState("");

  const loadPlans = () =>
    fetch(`${API_URL}/portal/plans`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Plan[]; error?: { message?: string } }) => {
        if (json.data) setPlans(json.data);
        else setError(json.error?.message ?? "Failed to load plans");
      })
      .catch(() => setError("Could not reach the API server"));

  useEffect(() => {
    loadPlans();

    // Pre-populate any payment links the merchant already created
    fetch(`${API_URL}/portal/payment-links`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: PaymentLink[] }) => {
        if (json.data) {
          setLinks(Object.fromEntries(json.data.map((l) => [l.plan_id, l.url])));
        }
      })
      .catch(() => { /* non-critical */ });
  }, []);

  const createLink = async (planId: string) => {
    setCreating(planId);
    try {
      const res = await fetch(`${API_URL}/portal/payment-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ plan_id: planId }),
      });
      const json = await res.json();
      if (res.ok && json.url) {
        setLinks((prev) => ({ ...prev, [planId]: json.url as string }));
      } else {
        setError(json.error?.message ?? "Failed to create payment link");
      }
    } catch {
      setError("Could not reach the API server");
    } finally {
      setCreating(null);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_URL}/portal/plans/${confirmDelete.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error?.message ?? "Failed to delete plan");
      }
      setPlans((prev) => (prev ? prev.filter((p) => p.id !== confirmDelete.id) : prev));
      setConfirmDelete(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete plan");
    } finally {
      setDeleting(false);
    }
  };

  const addTier = async () => {
    if (!tierModal) return;
    const amount = Math.round(parseFloat(tierForm.amount) * 1_000_000);
    if (!tierForm.name.trim() || !Number.isFinite(amount) || amount <= 0) {
      setError("A tier needs a name and a positive amount.");
      return;
    }
    setAddingTier(true);
    try {
      const res = await fetch(`${API_URL}/portal/plans/${tierModal.id}/tiers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: tierForm.name.trim(),
          amount,
          interval: tierForm.interval,
          trial_days: Number(tierForm.trial_days) || 0,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error?.message ?? "Failed to add tier");
      }
      await loadPlans();
      setTierModal(null);
      setTierForm({ name: "", amount: "", interval: "monthly", trial_days: "0" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add tier");
    } finally {
      setAddingTier(false);
    }
  };

  if (error) return <div className="rounded-xl bg-red-50 p-6 text-sm text-red-600">{error}</div>;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Plans</h1>
        <Link to="/plans/new" className="btn-primary">+ New Plan</Link>
      </div>

      {plans === null ? (
        <div className="card overflow-hidden animate-pulse">
          <div className="h-10 bg-gray-50 border-b border-gray-100" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="px-6 py-4 border-b border-gray-100 flex gap-6">
              <div className="h-4 w-32 rounded bg-gray-100" />
              <div className="h-4 w-20 rounded bg-gray-100" />
            </div>
          ))}
        </div>
      ) : plans.length === 0 ? (
        <div className="card flex flex-col items-center py-16 text-center">
          <p className="text-gray-400">No plans yet.</p>
          <p className="mt-1 text-sm text-gray-400">Create a plan to start accepting subscriptions.</p>
          <Link to="/plans/new" className="btn-primary mt-4 text-sm">Create your first plan</Link>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-6 py-3">Plan</th>
                <th className="px-6 py-3">Price</th>
                <th className="px-6 py-3">Interval</th>
                <th className="px-6 py-3">Trial</th>
                <th className="px-6 py-3">Subscribers</th>
                <th className="px-6 py-3">Payment link</th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {plans.map((plan) => (
                <tr key={plan.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <p className="font-medium text-gray-900">{plan.name}</p>
                    <code className="font-mono text-xs text-gray-400">{plan.id}</code>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                        {plan.default_tier_name || plan.name} ${(plan.amount / 1_000_000).toFixed(2)}/{plan.interval}
                        <span className="ml-1 text-gray-400">· default</span>
                      </span>
                      {(plan.tiers ?? []).map((t) => (
                        <span key={t.id} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                          {t.name} ${(t.amount / 1_000_000).toFixed(2)}/{t.interval}
                        </span>
                      ))}
                      <button
                        onClick={() => setTierModal(plan)}
                        className="text-xs font-medium text-brand-600 hover:underline"
                      >
                        + Add tier
                      </button>
                    </div>
                  </td>
                  <td className="px-6 py-4 font-medium text-gray-900">
                    ${(plan.amount / 1_000_000).toFixed(2)} {plan.currency}
                  </td>
                  <td className="px-6 py-4 text-gray-600">{INTERVAL_LABELS[plan.interval]}</td>
                  <td className="px-6 py-4 text-gray-600">
                    {plan.trial_days > 0 ? `${plan.trial_days} days` : "None"}
                  </td>
                  <td className="px-6 py-4 text-gray-600">{plan.subscribers}</td>
                  <td className="px-6 py-4">
                    {links[plan.id] ? (
                      <LinkCell url={links[plan.id]!} />
                    ) : (
                      <button
                        onClick={() => createLink(plan.id)}
                        disabled={creating === plan.id}
                        className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {creating === plan.id ? "Creating…" : "Create link"}
                      </button>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={() => setConfirmDelete(plan)}
                      className="text-xs font-medium text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tierModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Add a tier to {tierModal.name}</h3>
            <p className="mt-1 text-xs text-gray-500">
              Tiers are additive — existing subscribers keep their terms. New tiers can't change a tier already in use.
            </p>
            <div className="mt-4 space-y-3">
              <input
                value={tierForm.name}
                onChange={(e) => setTierForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Tier name (e.g. Pro)"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
              <div className="flex gap-2">
                <input
                  value={tierForm.amount}
                  onChange={(e) => setTierForm((f) => ({ ...f, amount: e.target.value }))}
                  placeholder="Amount (USDC, e.g. 25)"
                  inputMode="decimal"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
                <select
                  value={tierForm.interval}
                  onChange={(e) => setTierForm((f) => ({ ...f, interval: e.target.value }))}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                >
                  <option value="daily">daily</option>
                  <option value="weekly">weekly</option>
                  <option value="monthly">monthly</option>
                  <option value="yearly">yearly</option>
                </select>
              </div>
              <input
                value={tierForm.trial_days}
                onChange={(e) => setTierForm((f) => ({ ...f, trial_days: e.target.value }))}
                placeholder="Trial days (0 for none)"
                inputMode="numeric"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setTierModal(null)}
                disabled={addingTier}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={addTier}
                disabled={addingTier}
                className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
              >
                {addingTier ? "Adding…" : "Add tier"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Delete {confirmDelete.name}?</h3>
            <p className="mt-2 text-sm text-gray-600">
              {confirmDelete.subscribers > 0 ? (
                <>
                  This will <strong>cancel and refund {confirmDelete.subscribers} active
                  subscriber{confirmDelete.subscribers === 1 ? "" : "s"}</strong> — any escrowed
                  funds are returned to them on-chain, and they're emailed that billing has stopped.
                  This can&apos;t be undone.
                </>
              ) : (
                <>This plan has no active subscribers. It will be closed and kept for your records. This can&apos;t be undone.</>
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={deleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "Closing…" : "Delete plan"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

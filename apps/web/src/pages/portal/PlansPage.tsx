import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/portal/PageHeader";
import {
  EmptyNote,
  ErrorNote,
  KpiBand,
  Mono,
  Section,
  TableSkeleton,
  type Kpi,
} from "@/components/portal/primitives";
import { type Plan, type PaymentLink } from "./plan-model";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const INTERVAL_LABELS: Record<string, string> = {
  daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly",
};

export function PlansPage() {
  const navigate = useNavigate();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/portal/plans`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Plan[]; error?: { message?: string } }) => {
        if (json.data) setPlans(json.data);
        else setError(json.error?.message ?? "Failed to load plans");
      })
      .catch(() => setError("Could not reach the API server"));

    // Pre-populate any payment links the merchant already created
    fetch(`${API_URL}/portal/payment-links`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: PaymentLink[] }) => {
        if (json.data) setLinks(Object.fromEntries(json.data.map((l) => [l.plan_id, l.url])));
      })
      .catch(() => { /* non-critical */ });
  }, []);

  async function createLink(planId: string) {
    setCreating(planId);
    try {
      const res = await fetch(`${API_URL}/portal/payment-links`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: planId }),
      });
      const json = await res.json() as { data?: PaymentLink; url?: string; error?: { message?: string } };
      const url = json.data?.url ?? json.url;
      if (url) setLinks((prev) => ({ ...prev, [planId]: url }));
    } finally {
      setCreating(null);
    }
  }

  const kpis: Kpi[] = useMemo(() => {
    const rows = plans ?? [];
    const subs = rows.reduce((n, p) => n + p.subscribers, 0);
    const mrr = rows.reduce((sum, p) => sum + p.mrr, 0);
    return [
      { label: "Active plans", value: String(rows.length) },
      { label: "Subscribers", value: String(subs) },
      { label: "MRR", value: (mrr / 1_000_000).toFixed(2), unit: "USDC", accent: true },
    ];
  }, [plans]);

  if (error) {
    return (
      <>
        <PageHeader kicker="Catalogue" title="Plans" />
        <ErrorNote>{error}</ErrorNote>
      </>
    );
  }

  return (
    <>
      <PageHeader
        kicker="Catalogue"
        title="Plans"
        action={<Link to="/plans/new" className="btn btn-primary">New plan</Link>}
      />

      <KpiBand items={kpis} loading={plans === null} size={34} />

      <Section bordered={false}>
        {plans === null ? (
          <TableSkeleton rows={3} cols={6} />
        ) : plans.length === 0 ? (
          <EmptyNote title="No plans yet." hint="Create a plan to start accepting subscriptions." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Tiers</th>
                  <th>Price</th>
                  <th>Interval</th>
                  <th>Trial</th>
                  <th>Subscribers</th>
                  <th>Checkout link</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td style={{ cursor: "pointer" }} onClick={() => navigate(`/plans/${plan.id}`)}>
                      <p className="m-0" style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 15 }}>
                        {plan.name}
                      </p>
                      <Mono size={11}>
                        <span style={{ color: "var(--color-neutral-600)" }}>{plan.id}</span>
                      </Mono>
                    </td>
                    <td>
                      {/* Every option a subscriber can pick, priced, as pills that
                          wrap onto as many rows as the plan needs. Ordered by price
                          the way checkout orders them, so the cell reads as a price
                          ladder rather than in insertion order. The plan's own terms
                          are the default option and carry the marker. */}
                      <div className="flex flex-wrap gap-1.5" style={{ maxWidth: 260 }}>
                        {[
                          {
                            key: "default",
                            name: plan.default_tier_name || plan.name,
                            amount: plan.amount,
                            interval: plan.interval,
                            isDefault: true,
                          },
                          ...(plan.tiers ?? []).map((t) => ({
                            key: t.id,
                            name: t.name,
                            amount: t.amount,
                            interval: t.interval,
                            isDefault: false,
                          })),
                        ]
                          .sort((a, b) => a.amount - b.amount)
                          .map((t) => (
                            <span key={t.key} className="tag tag-neutral" style={{ whiteSpace: "nowrap" }}>
                              {t.name} {(t.amount / 1_000_000).toFixed(2)}
                              {/* The Interval column states the plan's own interval;
                                  name it here only for a tier that bills differently,
                                  which that column cannot show. */}
                              {t.interval !== plan.interval && ` ${INTERVAL_LABELS[t.interval] ?? t.interval}`}
                              {t.isDefault && " · default"}
                            </span>
                          ))}
                      </div>
                    </td>
                    <td style={{ fontFamily: "var(--font-heading)", fontWeight: 800 }}>
                      {(plan.amount / 1_000_000).toFixed(2)}
                    </td>
                    <td style={{ color: "var(--color-neutral-700)" }}>{INTERVAL_LABELS[plan.interval]}</td>
                    <td style={{ color: "var(--color-neutral-700)" }}>
                      {plan.trial_days > 0 ? `${plan.trial_days} days` : "None"}
                    </td>
                    <td style={{ fontFamily: "var(--font-heading)", fontWeight: 800 }}>{plan.subscribers}</td>
                    <td>
                      {links[plan.id] ? (
                        <Mono size={11.5}>
                          <span style={{ color: "var(--color-neutral-700)" }}>
                            {links[plan.id]!.replace(/^https?:\/\//, "")}
                          </span>
                        </Mono>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: "5px 10px", fontSize: 12 }}
                          onClick={() => createLink(plan.id)}
                          disabled={creating === plan.id}
                        >
                          {creating === plan.id ? "Creating…" : "Create link"}
                        </button>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ fontSize: 12 }}
                        onClick={() => navigate(`/plans/${plan.id}`)}
                      >
                        Open →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

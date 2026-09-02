import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "@/components/portal/PageHeader";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";
import {
  Dialog,
  ErrorNote,
  Kicker,
  KpiBand,
  Mono,
  StatusTag,
  type Kpi,
} from "@/components/portal/primitives";
import { TierEditor } from "@/components/portal/TierEditor";
import { AddTierForm } from "@/components/portal/AddTierForm";
import { type Plan, type PaymentLink } from "./plan-model";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const INTERVAL_LABELS: Record<string, string> = {
  daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly",
};

/** Chains a subscriber can pay from — mirrors SUPPORTED_SOURCE_CHAINS plus Arc. */
const ACCEPTED_CHAINS = ["Arc", "Base", "Arbitrum", "Optimism"];

interface Subscription {
  id: string;
  email: string | null;
  planName: string;
  status: string;
  currentPeriodEnd: string;
}

export function PlanDetailPage() {
  const { planId = "" } = useParams();
  const navigate = useNavigate();

  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Kept apart from `error`, which replaces the whole screen when the plan
  // itself fails to load. A refused deletion belongs inside the dialog.
  const [deleteError, setDeleteError] = useState("");
  const [copied, setCopied] = useState(false);
  const [creatingLink, setCreatingLink] = useState(false);
  /** Tier id mid-write while the Recommended badge moves. */
  const [recommending, setRecommending] = useState<string | null>(null);

  /**
   * Mint this plan's shareable checkout link. The Plans list can do this too;
   * having it here as well means a merchant who has just created a plan and
   * landed on its page can finish the job without going back a screen.
   */
  async function createLink() {
    setCreatingLink(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/portal/payment-links`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: planId }),
      });
      const json = (await res.json()) as {
        data?: PaymentLink;
        url?: string;
        error?: { message?: string };
      };
      const url = json.data?.url ?? json.url;
      if (!url) throw new Error(json.error?.message ?? "Couldn't create the checkout link.");
      setLink(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the checkout link.");
    } finally {
      setCreatingLink(false);
    }
  }

  /**
   * Move the "Recommended" badge, or clear it by picking the tier that already
   * has it. Exactly one option can hold it, which is why this is a single field
   * on the plan rather than a flag per tier.
   */
  async function setRecommended(tierId: string, alreadyOn: boolean) {
    setRecommending(tierId);
    setError("");
    try {
      const res = await fetch(`${API_URL}/portal/plans/${planId}/recommended`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recommended_tier_id: alreadyOn ? null : tierId }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? "Couldn't set the recommended tier.");
      }
      await loadPlans();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't set the recommended tier.");
    } finally {
      setRecommending(null);
    }
  }

  function loadPlans() {
    return fetch(`${API_URL}/portal/plans`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Plan[]; error?: { message?: string } }) => {
        if (json.data) setPlans(json.data);
        else setError(json.error?.message ?? "Failed to load plan");
      })
      .catch(() => setError("Could not reach the API server"));
  }

  useEffect(() => {
    void loadPlans();

    fetch(`${API_URL}/portal/subscriptions`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Subscription[] }) => { if (json.data) setSubs(json.data); })
      .catch(() => { /* non-critical */ });

    fetch(`${API_URL}/portal/payment-links`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: PaymentLink[] }) => {
        const match = json.data?.find((l) => l.plan_id === planId);
        if (match) setLink(match.url);
      })
      .catch(() => { /* non-critical */ });
  }, [planId]);

  const plan = plans?.find((p) => p.id === planId) ?? null;
  const planSubs = useMemo(
    () => (plan ? subs.filter((s) => s.planName === plan.name) : []),
    [subs, plan]
  );

  const kpis: Kpi[] = plan
    ? [
        { label: "Price", value: (plan.amount / 1_000_000).toFixed(2), unit: "USDC" },
        { label: "Interval", value: INTERVAL_LABELS[plan.interval] ?? plan.interval },
        { label: "Subscribers", value: String(plan.subscribers) },
        {
          label: "MRR",
          value: (plan.mrr / 1_000_000).toFixed(2),
          unit: "USDC",
          accent: true,
        },
      ]
    : [];

  async function doDelete() {
    setDeleting(true);
    setDeleteError("");
    try {
      // Closing a plan cancels every live subscription on it, so it is guarded:
      // apiFetch surfaces the confirmation prompt and replays this once proven.
      const res = await apiFetch(`/portal/plans/${planId}`, { method: "DELETE" });
      if (res.ok) navigate("/plans");
      else if (!(await wasCancelled(res))) setDeleteError(await messageOf(res, "Couldn't close this plan."));
    } finally {
      setDeleting(false);
    }
  }

  if (error) {
    return (
      <>
        <PageHeader kicker="Plan" title="Plan" onBack={() => navigate("/plans")} />
        <ErrorNote>{error}</ErrorNote>
      </>
    );
  }

  if (plans && !plan) {
    return (
      <>
        <PageHeader kicker="Plan" title="Not found" onBack={() => navigate("/plans")} />
        <ErrorNote>No plan with id {planId}.</ErrorNote>
      </>
    );
  }

  return (
    <>
      <PageHeader
        kicker="Plan"
        title={plan?.name ?? "…"}
        onBack={() => navigate("/plans")}
      />

      <KpiBand items={kpis} loading={!plan} size={32} />

      <div className="grid lg:grid-cols-[1.4fr_1fr]">
        <section
          style={{ padding: "26px 32px", borderRight: "1px solid var(--color-divider)" }}
        >
          <h3 className="m-0 mb-3.5" style={{ fontSize: 20, letterSpacing: "-0.02em" }}>Tiers</h3>

          <div style={{ borderTop: "2px solid var(--color-divider)" }}>
            {/* The plan's own terms are the default option at checkout. There is
                no PlanTier row behind them, so TierEditor patches the plan itself
                (planDefault) and offers no Remove — but the merchant gets the same
                editor, with the same price/interval lock, as any other tier. */}
            {plan && (
              <TierEditor
                planDefault
                tier={{
                  id: "default",
                  name: plan.default_tier_name || plan.name,
                  amount: plan.amount,
                  interval: plan.interval,
                  trial_days: plan.trial_days,
                  features: plan.default_features ?? null,
                }}
                planId={planId}
                isDefault
                isRecommended={plan.recommended_tier_id === "default"}
                onRecommend={() => void setRecommended("default", plan.recommended_tier_id === "default")}
                recommending={recommending === "default"}
                subscriberCount={planSubs.length}
                onChanged={() => void loadPlans()}
              />
            )}

            {(plan?.tiers ?? []).map((t) => (
              <TierEditor
                key={t.id}
                tier={t}
                planId={planId}
                isDefault={t.name === plan?.default_tier_name}
                isRecommended={plan?.recommended_tier_id === t.id}
                onRecommend={() => void setRecommended(t.id, plan?.recommended_tier_id === t.id)}
                recommending={recommending === t.id}
                subscriberCount={planSubs.length}
                onChanged={() => void loadPlans()}
              />
            ))}
            {plan && (plan.tiers ?? []).length === 0 && (
              <p className="m-0" style={{ padding: "18px 0", color: "var(--color-neutral-700)", fontSize: 13 }}>
                This plan has no additional tiers — subscribers are billed the plan&apos;s own terms.
              </p>
            )}
          </div>

          {plan && <AddTierForm planId={planId} onAdded={() => void loadPlans()} />}

          <p
            className="m-0"
            style={{ fontSize: 12, color: "var(--color-neutral-700)", marginTop: 12, maxWidth: "60ch" }}
          >
            Tiers live independently of each other. Removing one retires it from checkout so no new
            subscriber can pick it; everyone already on it keeps billing on the terms they signed up
            with, and no other tier is touched.
          </p>

          <h3
            className="m-0"
            style={{
              fontSize: 20, letterSpacing: "-0.02em", margin: "32px 0 14px",
              borderTop: "2px solid var(--color-divider)", paddingTop: 26,
            }}
          >
            Subscribers on this plan
          </h3>
          {planSubs.length === 0 ? (
            <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
              No subscribers on this plan yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr><th>Subscriber</th><th>Status</th><th>Renews</th></tr>
                </thead>
                <tbody>
                  {planSubs.map((s) => (
                    <tr key={s.id}>
                      <td>{s.email ?? "—"}</td>
                      <td><StatusTag status={s.status} /></td>
                      <td style={{ color: "var(--color-neutral-700)" }}>
                        {new Date(s.currentPeriodEnd).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside style={{ padding: "26px 32px" }}>
          <h3 className="m-0 mb-3.5" style={{ fontSize: 20, letterSpacing: "-0.02em" }}>Checkout link</h3>
          <div style={{ borderTop: "1px solid var(--color-divider)", paddingTop: 12 }}>
            {link ? (
              <>
                <p className="m-0" style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, wordBreak: "break-all" }}>
                  {link}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link className="btn btn-primary" style={{ padding: "9px 14px" }} to={`/plans/${planId}/preview`}>
                    Preview
                  </Link>
                  <a className="btn btn-secondary" style={{ padding: "9px 14px" }} href={link} target="_blank" rel="noreferrer">
                    Open checkout
                  </a>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: "9px 14px" }}
                    onClick={() => {
                      void navigator.clipboard.writeText(link);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="m-0 mb-3" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
                  No checkout link yet. Create one to start sharing this plan.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ padding: "9px 14px" }}
                    onClick={() => void createLink()}
                    disabled={creatingLink}
                  >
                    {creatingLink ? "Creating…" : "Create link"}
                  </button>
                  <Link className="btn btn-secondary" style={{ padding: "9px 14px" }} to={`/plans/${planId}/preview`}>
                    Preview
                  </Link>
                </div>
              </>
            )}
          </div>

          <div style={{ borderTop: "1px solid var(--color-divider)", marginTop: 22, paddingTop: 14 }}>
            <Kicker>Accepted</Kicker>
            <div className="flex flex-wrap gap-1.5">
              {ACCEPTED_CHAINS.map((c) => (
                <span key={c} className="tag tag-neutral">{c}</span>
              ))}
            </div>
          </div>

          <div style={{ borderTop: "2px solid var(--color-accent)", marginTop: 26, paddingTop: 14 }}>
            <p
              className="m-0 mb-2 uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-accent)" }}
            >
              Danger zone
            </p>
            <p
              className="m-0 mb-3"
              style={{ fontSize: 12.5, color: "var(--color-neutral-800)", lineHeight: 1.6 }}
            >
              Deleting cancels and refunds every active subscriber on-chain. This can&apos;t be undone.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: "9px 14px" }}
              onClick={() => setConfirmDelete(true)}
            >
              Delete plan
            </button>
          </div>
        </aside>
      </div>

      {confirmDelete && plan && (
        <Dialog
          title={`Delete ${plan.name}?`}
          onDismiss={() => { if (!deleting) setConfirmDelete(false); }}
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={doDelete} disabled={deleting}>
                {deleting ? "Closing…" : "Delete plan"}
              </button>
            </>
          }
        >
          {plan.subscribers > 0 ? (
            <>
              This will <strong>cancel and refund {plan.subscribers} active
              subscriber{plan.subscribers === 1 ? "" : "s"}</strong> — any escrowed funds are
              returned to them on-chain, and they&apos;re emailed that billing has stopped.
            </>
          ) : (
            <>This plan has no active subscribers. It will be closed and kept for your records.</>
          )}
          {deleteError && <div style={{ marginTop: 12 }}><ErrorNote>{deleteError}</ErrorNote></div>}
        </Dialog>
      )}
    </>
  );
}

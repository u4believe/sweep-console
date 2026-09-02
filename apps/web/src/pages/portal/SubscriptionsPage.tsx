import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/portal/PageHeader";
import {
  EmptyNote,
  ErrorNote,
  FilterTabs,
  Mono,
  Section,
  StatusTag,
  TableSkeleton,
  shortAddress,
} from "@/components/portal/primitives";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface Subscription {
  id: string;
  externalRef: string;
  email: string | null;
  planName: string;
  status: string;
  currentPeriodEnd: string;
  walletAddress: string;
  isTestMode: boolean;
}

type Filter = "all" | "active" | "trialing" | "past_due" | "cancelled";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "trialing", label: "Trialing" },
  { id: "past_due", label: "Past due" },
  { id: "cancelled", label: "Cancelled" },
];

export function SubscriptionsPage() {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    fetch(`${API_URL}/portal/subscriptions`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Subscription[]; error?: { message?: string } }) => {
        if (json.data) setSubs(json.data);
        else setError(json.error?.message ?? "Failed to load subscriptions");
      })
      .catch(() => setError("Could not reach the API server"));
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: subs?.length ?? 0 };
    for (const s of subs ?? []) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [subs]);

  const shown = useMemo(
    () => (filter === "all" ? subs ?? [] : (subs ?? []).filter((s) => s.status === filter)),
    [subs, filter]
  );

  return (
    <>
      <PageHeader kicker="Customers" title="Subscriptions" />

      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : (
        <>
          <FilterTabs
            tabs={FILTERS.map((f) => ({ ...f, count: counts[f.id] ?? 0 }))}
            active={filter}
            onSelect={setFilter}
          />

          <Section bordered={false}>
            {subs === null ? (
              <TableSkeleton cols={6} />
            ) : shown.length === 0 ? (
              <EmptyNote
                title={filter === "all" ? "No subscriptions yet." : `No ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} subscriptions.`}
                hint={filter === "all" ? "Subscribers appear here once they complete checkout." : undefined}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Subscriber</th>
                      <th>Plan</th>
                      <th>Status</th>
                      <th>Renews</th>
                      <th>Wallet</th>
                      <th>ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((sub) => (
                      <tr key={sub.id}>
                        <td>
                          <p className="m-0">{sub.email ?? "—"}</p>
                          <Mono size={11}>
                            <span style={{ color: "var(--color-neutral-600)" }}>{sub.externalRef}</span>
                          </Mono>
                        </td>
                        <td>{sub.planName}</td>
                        <td><StatusTag status={sub.status} /></td>
                        <td style={{ color: "var(--color-neutral-700)" }}>
                          {new Date(sub.currentPeriodEnd).toLocaleDateString()}
                        </td>
                        <td style={{ color: "var(--color-neutral-700)" }}>
                          <Mono>{shortAddress(sub.walletAddress)}</Mono>
                        </td>
                        <td style={{ color: "var(--color-neutral-700)" }}>
                          <Mono>{sub.id}</Mono>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}

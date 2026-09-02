import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/portal/PageHeader";
import {
  EmptyNote,
  ErrorNote,
  KpiBand,
  Mono,
  Section,
  StatusTag,
  TableSkeleton,
} from "@/components/portal/primitives";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  type: string;
  planName: string | null;
  txHash: string | null;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  initial: "Initial", renewal: "Renewal", refund: "Refund",
};

/// Shows the hash truncated (a full one blows out the column) but copies the
/// whole thing — a partial hash is useless for looking a tx up on an explorer.
function TxHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={hash}
      aria-label={copied ? "Transaction hash copied" : `Copy transaction hash ${hash}`}
      onClick={() => {
        void navigator.clipboard.writeText(hash);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="btn btn-ghost"
      style={{ fontSize: 12, fontFamily: "ui-monospace, Menlo, monospace", padding: "2px 4px" }}
    >
      {copied ? "Copied" : `${hash.slice(0, 8)}…`}
    </button>
  );
}

export function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/portal/payments`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Payment[]; error?: { message?: string } }) => {
        if (json.data) setPayments(json.data);
        else setError(json.error?.message ?? "Failed to load payments");
      })
      .catch(() => setError("Could not reach the API server"));
  }, []);

  const kpis = useMemo(() => {
    const rows = payments ?? [];
    const settled = rows
      .filter((p) => p.status === "succeeded" && p.type !== "refund")
      .reduce((sum, p) => sum + p.amount, 0);
    const failed = rows.filter((p) => p.status === "failed").length;
    return [
      { label: "Settled total", value: (settled / 1_000_000).toFixed(2), unit: "USDC" },
      { label: "Renewals", value: String(rows.filter((p) => p.type === "renewal").length) },
      { label: "Failed", value: String(failed), accent: failed > 0 },
      { label: "Refunded", value: String(rows.filter((p) => p.type === "refund").length) },
    ];
  }, [payments]);

  return (
    <>
      <PageHeader kicker="Revenue" title="Payments" />

      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : (
        <>
          <KpiBand items={kpis} loading={payments === null} size={34} />

          <Section bordered={false}>
            {payments === null ? (
              <TableSkeleton cols={6} />
            ) : payments.length === 0 ? (
              <EmptyNote
                title="No payments yet."
                hint="Payments appear here after subscribers complete checkout."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Amount</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Plan</th>
                      <th>Date</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((payment) => (
                      <tr key={payment.id}>
                        <td style={{ fontFamily: "var(--font-heading)", fontWeight: 800 }}>
                          {(payment.amount / 1_000_000).toFixed(2)}{" "}
                          <span style={{ fontSize: 11, fontWeight: 400, color: "var(--color-neutral-600)" }}>
                            {payment.currency}
                          </span>
                        </td>
                        <td>{TYPE_LABELS[payment.type] ?? payment.type}</td>
                        <td><StatusTag status={payment.status} /></td>
                        <td>{payment.planName ?? "—"}</td>
                        <td style={{ color: "var(--color-neutral-700)" }}>
                          {new Date(payment.createdAt).toLocaleDateString()}
                        </td>
                        <td style={{ color: "var(--color-neutral-700)" }}>
                          {payment.txHash ? <TxHash hash={payment.txHash} /> : <Mono>—</Mono>}
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

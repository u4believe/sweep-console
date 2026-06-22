import { useEffect, useState } from "react";

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

const STATUS_COLORS: Record<string, string> = {
  succeeded: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  pending: "bg-yellow-100 text-yellow-700",
  refunded: "bg-gray-100 text-gray-500",
};

const TYPE_LABELS: Record<string, string> = {
  initial: "Initial", renewal: "Renewal", refund: "Refund",
};

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

  if (error) return <div className="rounded-xl bg-red-50 p-6 text-sm text-red-600">{error}</div>;

  const totalSucceeded = (payments ?? [])
    .filter((p) => p.status === "succeeded" && p.type !== "refund")
    .reduce((sum, p) => sum + p.amount, 0);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-gray-900">Payments</h1>
      <p className="mb-6 text-sm text-gray-500">
        Total revenue:{" "}
        <span className="font-semibold text-gray-900">${(totalSucceeded / 1_000_000).toFixed(2)} USDC</span>
      </p>

      {payments === null ? (
        <div className="card overflow-hidden animate-pulse">
          <div className="h-10 bg-gray-50 border-b border-gray-100" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-6 py-4 border-b border-gray-100 flex gap-6">
              <div className="h-4 w-20 rounded bg-gray-100" />
              <div className="h-4 w-16 rounded bg-gray-100" />
            </div>
          ))}
        </div>
      ) : payments.length === 0 ? (
        <div className="card flex flex-col items-center py-16 text-center">
          <p className="text-gray-400">No payments yet.</p>
          <p className="mt-1 text-sm text-gray-400">Payments appear here after subscribers complete checkout.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-6 py-3">Amount</th>
                <th className="px-6 py-3">Type</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Plan</th>
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payments.map((payment) => (
                <tr key={payment.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 font-semibold text-gray-900">
                    ${(payment.amount / 1_000_000).toFixed(2)}{" "}
                    <span className="text-xs font-normal text-gray-400">{payment.currency}</span>
                  </td>
                  <td className="px-6 py-4 text-gray-600">{TYPE_LABELS[payment.type] ?? payment.type}</td>
                  <td className="px-6 py-4">
                    <span className={`badge ${STATUS_COLORS[payment.status] ?? "bg-gray-100 text-gray-500"}`}>
                      {payment.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-700">{payment.planName ?? "—"}</td>
                  <td className="px-6 py-4 text-gray-500">{new Date(payment.createdAt).toLocaleDateString()}</td>
                  <td className="px-6 py-4">
                    {payment.txHash
                      ? <code className="font-mono text-xs text-gray-500">{payment.txHash.slice(0, 8)}...</code>
                      : <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

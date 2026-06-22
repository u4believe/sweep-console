import { useEffect, useState } from "react";

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

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  trialing: "bg-blue-100 text-blue-700",
  past_due: "bg-yellow-100 text-yellow-700",
  cancelled: "bg-gray-100 text-gray-500",
  paused: "bg-orange-100 text-orange-700",
};

export function SubscriptionsPage() {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/portal/subscriptions`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Subscription[]; error?: { message?: string } }) => {
        if (json.data) setSubs(json.data);
        else setError(json.error?.message ?? "Failed to load subscriptions");
      })
      .catch(() => setError("Could not reach the API server"));
  }, []);

  if (error) return <div className="rounded-xl bg-red-50 p-6 text-sm text-red-600">{error}</div>;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Subscriptions</h1>

      {subs === null ? (
        <div className="card overflow-hidden animate-pulse">
          <div className="h-10 bg-gray-50 border-b border-gray-100" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-6 py-4 border-b border-gray-100 flex gap-6">
              <div className="h-4 w-28 rounded bg-gray-100" />
              <div className="h-4 w-20 rounded bg-gray-100" />
            </div>
          ))}
        </div>
      ) : subs.length === 0 ? (
        <div className="card flex flex-col items-center py-16 text-center">
          <p className="text-gray-400">No subscriptions yet.</p>
          <p className="mt-1 text-sm text-gray-400">Subscribers will appear here once they complete checkout.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-6 py-3">Subscriber</th>
                <th className="px-6 py-3">Plan</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Period End</th>
                <th className="px-6 py-3">Wallet</th>
                <th className="px-6 py-3">ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {subs.map((sub) => (
                <tr key={sub.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <p className="text-gray-900">{sub.email ?? "—"}</p>
                    <p className="font-mono text-xs text-gray-400">{sub.externalRef}</p>
                  </td>
                  <td className="px-6 py-4 text-gray-700">{sub.planName}</td>
                  <td className="px-6 py-4">
                    <span className={`badge ${STATUS_COLORS[sub.status] ?? "bg-gray-100 text-gray-500"}`}>
                      {sub.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-600">{new Date(sub.currentPeriodEnd).toLocaleDateString()}</td>
                  <td className="px-6 py-4 font-mono text-xs text-gray-500">
                    {sub.walletAddress.slice(0, 6)}...{sub.walletAddress.slice(-4)}
                  </td>
                  <td className="px-6 py-4">
                    <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">{sub.id}</code>
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

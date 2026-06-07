import { prisma } from "@/lib/prisma";

const DEV_MERCHANT_ID = process.env.DEV_MERCHANT_ID ?? "";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  trialing: "bg-blue-100 text-blue-700",
  past_due: "bg-yellow-100 text-yellow-700",
  cancelled: "bg-gray-100 text-gray-500",
  paused: "bg-orange-100 text-orange-700",
};

export default async function SubscriptionsPage() {
  const subs = DEV_MERCHANT_ID
    ? await prisma.subscription.findMany({
        where: { merchantId: DEV_MERCHANT_ID },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      })
    : [];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Subscriptions</h1>

      {subs.length === 0 ? (
        <div className="card flex flex-col items-center py-16 text-center">
          <p className="text-gray-400">No subscriptions yet.</p>
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
                  <td className="px-6 py-4 font-mono text-xs text-gray-700">
                    {sub.externalRef}
                  </td>
                  <td className="px-6 py-4 text-gray-700">{sub.plan.name}</td>
                  <td className="px-6 py-4">
                    <span
                      className={`badge ${STATUS_COLORS[sub.status] ?? "bg-gray-100 text-gray-500"}`}
                    >
                      {sub.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {sub.currentPeriodEnd.toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 font-mono text-xs text-gray-500">
                    {sub.walletAddress.slice(0, 6)}...{sub.walletAddress.slice(-4)}
                  </td>
                  <td className="px-6 py-4">
                    <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">
                      {sub.subscriptionId}
                    </code>
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

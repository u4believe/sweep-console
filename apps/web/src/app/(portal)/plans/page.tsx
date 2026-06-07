import { prisma } from "@/lib/prisma";
import Link from "next/link";

const DEV_MERCHANT_ID = process.env.DEV_MERCHANT_ID ?? "";

const INTERVAL_LABELS: Record<string, string> = {
  daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly",
};

export default async function PlansPage() {
  const plans = DEV_MERCHANT_ID
    ? await prisma.plan.findMany({
        where: { merchantId: DEV_MERCHANT_ID, archived: false },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { subscriptions: true } },
        },
      })
    : [];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Plans</h1>
        <Link href="/plans/new" className="btn-primary">
          + New Plan
        </Link>
      </div>

      {plans.length === 0 ? (
        <div className="card flex flex-col items-center py-16 text-center">
          <p className="text-gray-400">No plans yet.</p>
          <p className="mt-1 text-sm text-gray-400">
            Create a plan to start accepting subscriptions.
          </p>
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
                <th className="px-6 py-3">ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {plans.map((plan) => (
                <tr key={plan.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <p className="font-medium text-gray-900">{plan.name}</p>
                    {plan.description && (
                      <p className="text-xs text-gray-400">{plan.description}</p>
                    )}
                  </td>
                  <td className="px-6 py-4 font-medium text-gray-900">
                    ${(Number(plan.amount) / 1_000_000).toFixed(2)} {plan.currency}
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {INTERVAL_LABELS[plan.interval]}
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {plan.trialDays > 0 ? `${plan.trialDays} days` : "None"}
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {plan._count.subscriptions}
                  </td>
                  <td className="px-6 py-4">
                    <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">
                      {plan.planId}
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

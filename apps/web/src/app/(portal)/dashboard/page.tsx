import { prisma } from "@/lib/prisma";

// Placeholder merchant ID — in production this comes from the session
const DEV_MERCHANT_ID = process.env.DEV_MERCHANT_ID ?? "";

async function getStats(merchantId: string) {
  const [activeSubs, revenue, plans, failedPayments] = await Promise.all([
    prisma.subscription.count({
      where: { merchantId, status: { in: ["active", "trialing"] } },
    }),
    prisma.payment.aggregate({
      where: { merchantId, status: "succeeded", type: { in: ["initial", "renewal"] } },
      _sum: { amount: true },
    }),
    prisma.plan.count({ where: { merchantId, archived: false } }),
    prisma.payment.count({ where: { merchantId, status: "failed" } }),
  ]);

  return {
    activeSubs,
    totalRevenue: Number(revenue._sum.amount ?? 0n),
    plans,
    failedPayments,
  };
}

export default async function DashboardPage() {
  const stats = DEV_MERCHANT_ID ? await getStats(DEV_MERCHANT_ID) : null;

  const cards = [
    {
      label: "Active Subscriptions",
      value: stats?.activeSubs ?? "—",
      color: "bg-brand-50 text-brand-700",
    },
    {
      label: "Total Revenue (USDC)",
      value: stats ? `$${(stats.totalRevenue / 1_000_000).toFixed(2)}` : "—",
      color: "bg-blue-50 text-blue-700",
    },
    {
      label: "Active Plans",
      value: stats?.plans ?? "—",
      color: "bg-purple-50 text-purple-700",
    },
    {
      label: "Failed Payments",
      value: stats?.failedPayments ?? "—",
      color: "bg-red-50 text-red-700",
    },
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Dashboard</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="card p-6">
            <p className="text-sm font-medium text-gray-500">{card.label}</p>
            <p className={`mt-2 text-3xl font-bold ${card.color.split(" ")[1]}`}>{card.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 card p-6">
        <h2 className="mb-1 text-lg font-semibold text-gray-900">Quick Start</h2>
        <p className="mb-4 text-sm text-gray-500">
          Integrate SweepConsole into your app in two steps:
        </p>
        <ol className="space-y-3 text-sm text-gray-700">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">1</span>
            <span>Create a plan below, then call <code className="rounded bg-gray-100 px-1 font-mono text-xs">POST /v1/checkout/session</code> with <code className="rounded bg-gray-100 px-1 font-mono text-xs">plan_id</code> and <code className="rounded bg-gray-100 px-1 font-mono text-xs">external_ref</code> from your server.</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">2</span>
            <span>Register a webhook endpoint to receive <code className="rounded bg-gray-100 px-1 font-mono text-xs">subscription.created</code> and upgrade the user in your database.</span>
          </li>
        </ol>
      </div>
    </div>
  );
}

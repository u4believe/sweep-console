import { prisma } from "@/lib/prisma";

const DEV_MERCHANT_ID = process.env.DEV_MERCHANT_ID ?? "";

export default async function WebhooksPage() {
  const endpoints = DEV_MERCHANT_ID
    ? await prisma.webhookEndpoint.findMany({
        where: { merchantId: DEV_MERCHANT_ID, isActive: true },
        include: {
          _count: { select: { deliveries: true } },
          deliveries: {
            orderBy: { createdAt: "desc" },
            take: 5,
          },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Webhooks</h1>
      </div>

      <div className="mb-6 card p-6 bg-gray-50">
        <h2 className="mb-2 text-sm font-semibold text-gray-900">Register via API</h2>
        <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-xs text-green-400">
{`POST /v1/webhooks
Authorization: Bearer live_your_api_key

{
  "url": "https://yourapp.com/webhooks/sweep",
  "events": ["subscription.created", "subscription.renewed", "subscription.cancelled"]
}`}
        </pre>
      </div>

      {endpoints.length === 0 ? (
        <div className="card flex flex-col items-center py-16 text-center">
          <p className="text-gray-400">No webhook endpoints registered.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {endpoints.map((ep) => (
            <div key={ep.id} className="card p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-mono text-sm font-medium text-gray-900">{ep.url}</p>
                  <code className="mt-1 text-xs text-gray-400">{ep.endpointId}</code>
                </div>
                <span className="badge bg-green-100 text-green-700">Active</span>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {ep.events.map((ev) => (
                  <span key={ev} className="badge bg-gray-100 text-gray-600">
                    {ev}
                  </span>
                ))}
              </div>

              <div className="mt-3 text-sm text-gray-500">
                {ep._count.deliveries} events delivered
              </div>

              {ep.deliveries.length > 0 && (
                <div className="mt-4 overflow-hidden rounded-lg border border-gray-100">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-left">
                      <tr>
                        <th className="px-4 py-2 text-gray-500">Event</th>
                        <th className="px-4 py-2 text-gray-500">Status</th>
                        <th className="px-4 py-2 text-gray-500">When</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {ep.deliveries.map((d) => (
                        <tr key={d.id}>
                          <td className="px-4 py-2 font-mono text-gray-700">{d.eventType}</td>
                          <td className="px-4 py-2">
                            <span
                              className={`badge ${
                                d.status === "delivered"
                                  ? "bg-green-100 text-green-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {d.status}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-gray-500">
                            {d.createdAt.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

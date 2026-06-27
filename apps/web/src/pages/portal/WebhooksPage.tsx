import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const ALL_EVENTS = [
  "checkout.session.completed",
  "subscription.created",
  "subscription.renewed",
  "subscription.past_due",
  "subscription.cancelled",
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
] as const;

interface Delivery {
  id: string;
  eventType: string;
  status: string;
  createdAt: string;
}

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  deliveryCount: number;
  recentDeliveries: Delivery[];
}

interface NewEndpointSecret {
  id: string;
  url: string;
  secret: string;
}

export function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [formUrl, setFormUrl] = useState("");
  const [formEvents, setFormEvents] = useState<string[]>([...ALL_EVENTS]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [newSecret, setNewSecret] = useState<NewEndpointSecret | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  function loadEndpoints() {
    fetch(`${API_URL}/portal/webhooks`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: WebhookEndpoint[]; error?: { message?: string } }) => {
        if (json.data) setEndpoints(json.data);
        else setError(json.error?.message ?? "Failed to load webhooks");
      })
      .catch(() => setError("Could not reach the API server"));
  }

  useEffect(() => { loadEndpoints(); }, []);

  function toggleEvent(ev: string) {
    setFormEvents((prev) =>
      prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (formEvents.length === 0) { setFormError("Select at least one event"); return; }
    setSubmitting(true);
    setFormError("");
    try {
      const res = await fetch(`${API_URL}/portal/webhooks`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: formUrl, events: formEvents }),
      });
      const data = await res.json() as { id?: string; url?: string; secret?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(data.error?.message ?? "Failed to create endpoint");
      setNewSecret({ id: data.id!, url: data.url!, secret: data.secret! });
      setShowForm(false);
      setFormUrl("");
      setFormEvents([...ALL_EVENTS]);
      loadEndpoints();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(endpointId: string) {
    if (!confirm("Remove this webhook endpoint?")) return;
    setDeleting(endpointId);
    try {
      await fetch(`${API_URL}/portal/webhooks/${endpointId}`, {
        method: "DELETE",
        credentials: "include",
      });
      loadEndpoints();
    } finally {
      setDeleting(null);
    }
  }

  if (error) return <div className="rounded-xl bg-red-50 p-6 text-sm text-red-600">{error}</div>;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Webhooks</h1>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition"
          >
            + Add endpoint
          </button>
        )}
      </div>

      {/* New endpoint secret — shown once after creation */}
      {newSecret && (
        <div className="mb-6 rounded-xl border border-green-200 bg-green-50 p-5">
          <p className="mb-2 font-semibold text-green-800">Endpoint created — save your signing secret now</p>
          <p className="mb-3 text-sm text-green-700">This secret is shown only once. Use it to verify webhook signatures.</p>
          <div className="flex items-center gap-2 rounded-lg bg-white border border-green-200 px-4 py-2.5 font-mono text-sm text-gray-900 break-all">
            {newSecret.secret}
            <button
              onClick={() => navigator.clipboard.writeText(newSecret.secret)}
              className="ml-auto shrink-0 text-xs text-blue-600 hover:underline"
            >
              Copy
            </button>
          </div>
          <button onClick={() => setNewSecret(null)} className="mt-3 text-xs text-gray-400 hover:text-gray-600">Dismiss</button>
        </div>
      )}

      {/* Add endpoint form */}
      {showForm && (
        <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-6">
          <h2 className="mb-4 text-base font-semibold text-gray-900">New webhook endpoint</h2>
          {formError && (
            <p className="mb-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{formError}</p>
          )}
          <form onSubmit={handleCreate} className="space-y-5">
            <div>
              <label className="block mb-1.5 text-sm font-medium text-gray-700">Endpoint URL</label>
              <input
                type="url"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="https://yourapp.com/webhooks/sweep"
                required
                className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block mb-2 text-sm font-medium text-gray-700">Events to receive</label>
              <div className="flex flex-wrap gap-2">
                {ALL_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formEvents.includes(ev)}
                      onChange={() => toggleEvent(ev)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm font-mono text-gray-700">{ev}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition"
              >
                {submitting ? "Creating…" : "Create endpoint"}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setFormError(""); }}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {endpoints === null ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card p-6 animate-pulse space-y-3">
              <div className="h-4 w-64 rounded bg-gray-200" />
              <div className="h-3 w-32 rounded bg-gray-100" />
            </div>
          ))}
        </div>
      ) : endpoints.length === 0 ? (
        <div className="card flex flex-col items-center py-16 text-center">
          <p className="text-gray-400">No webhook endpoints registered.</p>
          <p className="mt-1 text-sm text-gray-400">Click "Add endpoint" above to get started.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {endpoints.map((ep) => (
            <div key={ep.id} className="card p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium text-gray-900 break-all">{ep.url}</p>
                  <code className="mt-1 text-xs text-gray-400">{ep.id}</code>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="badge bg-green-100 text-green-700">Active</span>
                  <button
                    onClick={() => handleDelete(ep.id)}
                    disabled={deleting === ep.id}
                    className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50 disabled:opacity-50 transition"
                  >
                    {deleting === ep.id ? "Removing…" : "Remove"}
                  </button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {ep.events.map((ev) => (
                  <span key={ev} className="badge bg-gray-100 text-gray-600">{ev}</span>
                ))}
              </div>
              <div className="mt-3 text-sm text-gray-500">{ep.deliveryCount} events delivered</div>
              {ep.recentDeliveries.length > 0 && (
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
                      {ep.recentDeliveries.map((d) => (
                        <tr key={d.id}>
                          <td className="px-4 py-2 font-mono text-gray-700">{d.eventType}</td>
                          <td className="px-4 py-2">
                            <span className={`badge ${d.status === "delivered" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                              {d.status}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-gray-500">{new Date(d.createdAt).toLocaleString()}</td>
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

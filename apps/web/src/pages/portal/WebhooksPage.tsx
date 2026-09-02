import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal/PageHeader";
import { Dialog, EmptyNote, ErrorNote, Kicker, Mono, StatusTag } from "@/components/portal/primitives";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/// The event list is served with the endpoint listing rather than hard-coded
/// here. It used to be a local constant, and it had drifted from the one the
/// API validates against — the form pre-selected two events the server refused,
/// so a default submission failed with a bare "Validation failed".
interface AvailableEvent {
  id: string;
  description: string;
}

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
  const [formUrl, setFormUrl] = useState("");
  const [availableEvents, setAvailableEvents] = useState<AvailableEvent[]>([]);
  const [formEvents, setFormEvents] = useState<string[]>([]);
  // Once the merchant has picked events themselves, a reload must not silently
  // re-tick everything under them.
  const [eventsTouched, setEventsTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [newSecret, setNewSecret] = useState<NewEndpointSecret | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Secrets are never in the listing — they arrive one at a time, on request,
  // and live only in this map until the page unmounts.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [secretBusy, setSecretBusy] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmRoll, setConfirmRoll] = useState<string | null>(null);
  const [rolledId, setRolledId] = useState<string | null>(null);

  async function revealSecret(endpointId: string) {
    setSecretBusy(endpointId);
    setSecretError((m) => ({ ...m, [endpointId]: "" }));
    const res = await apiFetch(`/portal/webhooks/${endpointId}/secret`, { method: "POST" });
    setSecretBusy(null);
    if (!res.ok) {
      if (!(await wasCancelled(res))) {
        const message = await messageOf(res, "Couldn't read the secret.");
        setSecretError((m) => ({ ...m, [endpointId]: message }));
      }
      return;
    }
    const { secret } = (await res.json()) as { secret: string };
    setRevealed((m) => ({ ...m, [endpointId]: secret }));
  }

  async function rollSecret(endpointId: string) {
    setSecretBusy(endpointId);
    setSecretError((m) => ({ ...m, [endpointId]: "" }));
    const res = await apiFetch(`/portal/webhooks/${endpointId}/roll`, { method: "POST" });
    setSecretBusy(null);
    setConfirmRoll(null);
    if (!res.ok) {
      if (!(await wasCancelled(res))) {
        const message = await messageOf(res, "Couldn't roll the secret.");
        setSecretError((m) => ({ ...m, [endpointId]: message }));
      }
      return;
    }
    const { secret } = (await res.json()) as { secret: string };
    // Shown immediately: the old secret is already dead, so the merchant needs
    // this value in front of them, not behind another click.
    setRevealed((m) => ({ ...m, [endpointId]: secret }));
    setRolledId(endpointId);
  }

  function copySecret(endpointId: string, secret: string) {
    void navigator.clipboard.writeText(secret);
    setCopiedId(endpointId);
    setTimeout(() => setCopiedId((c) => (c === endpointId ? null : c)), 2000);
  }

  function loadEndpoints() {
    fetch(`${API_URL}/portal/webhooks`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: WebhookEndpoint[]; available_events?: AvailableEvent[]; error?: { message?: string } }) => {
        if (json.data) setEndpoints(json.data);
        else setError(json.error?.message ?? "Failed to load webhooks");
        if (json.available_events) {
          setAvailableEvents(json.available_events);
          if (!eventsTouched) setFormEvents(json.available_events.map((e) => e.id));
        }
      })
      .catch(() => setError("Could not reach the API server"));
  }

  useEffect(() => { loadEndpoints(); }, []);

  function toggleEvent(ev: string) {
    setEventsTouched(true);
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
      const data = await res.json() as {
        id?: string; url?: string; secret?: string;
        error?: { message?: string; details?: Record<string, string> };
      };
      if (!res.ok) {
        // A rejected URL explains itself in details.url — the top-level message
        // is only ever "Validation failed", which tells the merchant nothing.
        throw new Error(data.error?.details?.url ?? data.error?.message ?? "Failed to create endpoint");
      }
      setNewSecret({ id: data.id!, url: data.url!, secret: data.secret! });
      setFormUrl("");
      setFormEvents(availableEvents.map((e) => e.id));
      setEventsTouched(false);
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

  if (error) {
    return (
      <>
        <PageHeader kicker="Developers" title="Webhooks" />
        <ErrorNote>{error}</ErrorNote>
      </>
    );
  }

  return (
    <>
      <PageHeader kicker="Developers" title="Webhooks" />

      <div style={{ padding: "24px 32px" }}>
        {/* Signing secret — shown once, immediately after creation. */}
        {newSecret && (
          <div
            style={{
              border: "2px solid var(--color-accent)",
              background: "var(--color-accent-100)",
              padding: "18px 20px",
              marginBottom: 24,
            }}
          >
            <p
              className="m-0 mb-1"
              style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 15 }}
            >
              Endpoint created — save your signing secret now
            </p>
            <p className="m-0 mb-3" style={{ fontSize: 12.5, color: "var(--color-accent-800)" }}>
              Shown only once. Use it to verify webhook signatures.
            </p>
            <div
              className="flex items-center gap-3"
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-divider)",
                padding: "10px 14px",
              }}
            >
              <code style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, wordBreak: "break-all" }}>
                {newSecret.secret}
              </code>
              <button
                type="button"
                className="btn btn-ghost ml-auto shrink-0"
                style={{ fontSize: 12 }}
                onClick={() => {
                  void navigator.clipboard.writeText(newSecret.secret);
                  setSecretCopied(true);
                  setTimeout(() => setSecretCopied(false), 2000);
                }}
              >
                {secretCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ color: "var(--color-neutral-700)", fontSize: 12, marginTop: 10, padding: 0 }}
              onClick={() => setNewSecret(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {endpoints === null ? (
          <div className="space-y-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} style={{ borderTop: "2px solid var(--color-divider)", padding: "22px 0" }}>
                <div className="mb-2 h-4 w-64 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
                <div className="h-3 w-32 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
              </div>
            ))}
          </div>
        ) : endpoints.length === 0 ? (
          <EmptyNote
            title="No webhook endpoints registered."
            hint="Add one below to start receiving events."
          />
        ) : (
          endpoints.map((ep) => (
            <div key={ep.id} style={{ borderTop: "2px solid var(--color-divider)", padding: "22px 0 26px" }}>
              <div className="flex flex-wrap items-start gap-3.5">
                <div className="min-w-0">
                  <p
                    className="m-0 mb-1"
                    style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14, wordBreak: "break-all" }}
                  >
                    {ep.url}
                  </p>
                  <Mono size={11}>
                    <span style={{ color: "var(--color-neutral-600)" }}>{ep.id}</span>
                  </Mono>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2.5">
                  <StatusTag status="active" />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: 12 }}
                    onClick={() => handleDelete(ep.id)}
                    disabled={deleting === ep.id}
                  >
                    {deleting === ep.id ? "Removing…" : "Remove"}
                  </button>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {ep.events.map((ev) => (
                  <span
                    key={ev}
                    className="tag tag-neutral"
                    style={{ fontFamily: "ui-monospace, Menlo, monospace" }}
                  >
                    {ev}
                  </span>
                ))}
              </div>

              <div
                className="flex flex-wrap items-center gap-3"
                style={{
                  marginTop: 14,
                  border: `1px solid ${rolledId === ep.id ? "var(--color-accent)" : "var(--color-divider)"}`,
                  background: rolledId === ep.id ? "var(--color-accent-100)" : "var(--color-surface)",
                  padding: "10px 14px",
                }}
              >
                <span
                  className="uppercase"
                  style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-neutral-600)" }}
                >
                  Signing secret
                </span>
                <code
                  style={{
                    fontFamily: "ui-monospace, Menlo, monospace",
                    fontSize: 12.5,
                    wordBreak: "break-all",
                    minWidth: 0,
                  }}
                >
                  {revealed[ep.id] ?? "whsec_••••••••••••••••••••••••"}
                </code>

                <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
                  {revealed[ep.id] ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ fontSize: 12 }}
                        onClick={() => copySecret(ep.id, revealed[ep.id]!)}
                      >
                        {copiedId === ep.id ? "Copied" : "Copy"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ fontSize: 12, color: "var(--color-neutral-700)" }}
                        onClick={() => {
                          setRevealed(({ [ep.id]: _drop, ...rest }) => rest);
                          setRolledId((r) => (r === ep.id ? null : r));
                        }}
                      >
                        Hide
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ fontSize: 12 }}
                      onClick={() => void revealSecret(ep.id)}
                      disabled={secretBusy === ep.id}
                    >
                      {secretBusy === ep.id ? "Checking…" : "Reveal"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: 12, color: "var(--color-neutral-700)" }}
                    onClick={() => setConfirmRoll(ep.id)}
                    disabled={secretBusy === ep.id}
                  >
                    Roll
                  </button>
                </span>
              </div>

              {rolledId === ep.id && (
                <p className="m-0" style={{ fontSize: 12, color: "var(--color-accent-800)", marginTop: 8 }}>
                  New secret in place. The previous one stopped verifying immediately — copy this
                  into your handler now.
                </p>
              )}
              {secretError[ep.id] && (
                <p className="m-0" style={{ fontSize: 12, color: "var(--color-accent-700)", marginTop: 8 }}>
                  {secretError[ep.id]}
                </p>
              )}

              <p className="m-0" style={{ fontSize: 12, color: "var(--color-neutral-700)", margin: "14px 0" }}>
                {ep.deliveryCount} events delivered
              </p>

              {ep.recentDeliveries.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr><th>Event</th><th>Status</th><th>When</th></tr>
                    </thead>
                    <tbody>
                      {ep.recentDeliveries.map((d) => (
                        <tr key={d.id}>
                          <td><Mono size={12.5}>{d.eventType}</Mono></td>
                          <td><StatusTag status={d.status} /></td>
                          <td style={{ color: "var(--color-neutral-700)" }}>
                            {new Date(d.createdAt).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))
        )}

        {/* Add an endpoint — a permanent section, as in the design. */}
        <div
          className="grid gap-8 lg:grid-cols-[1.2fr_1fr]"
          style={{ borderTop: "2px solid var(--color-divider)", paddingTop: 22, marginTop: 8 }}
        >
          <form onSubmit={handleCreate}>
            <h3 className="m-0 mb-3.5" style={{ fontSize: 20, letterSpacing: "-0.02em" }}>
              Add an endpoint
            </h3>

            {formError && (
              <p className="m-0 mb-3" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>
                {formError}
              </p>
            )}

            <div className="field" style={{ marginBottom: 16 }}>
              <label htmlFor="wh-url">Endpoint URL</label>
              <input
                id="wh-url"
                className="input"
                type="url"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="https://yourapp.com/webhooks/sweep"
                required
              />
              <p className="m-0" style={{ marginTop: 5, fontSize: 11.5, color: "var(--color-neutral-600)", lineHeight: 1.5 }}>
                Must be <strong>https://</strong> and reachable on the public internet — deliveries
                carry subscriber and payment data. Testing locally? Expose your machine with a
                tunnel such as ngrok and use that URL.
              </p>
            </div>

            <Kicker>Events to receive</Kicker>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {availableEvents.map((ev) => (
                <label key={ev.id} className="flex cursor-pointer items-start gap-2" style={{ fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={formEvents.includes(ev.id)}
                    onChange={() => toggleEvent(ev.id)}
                    style={{ accentColor: "var(--color-accent)", width: 15, height: 15, marginTop: 2, flex: "none" }}
                  />
                  <span className="min-w-0">
                    <Mono size={12.5}>{ev.id}</Mono>
                    <span className="block" style={{ fontSize: 11.5, color: "var(--color-neutral-700)", lineHeight: 1.45 }}>
                      {ev.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            <button type="submit" className="btn btn-primary" style={{ marginTop: 18 }} disabled={submitting}>
              {submitting ? "Creating…" : "Create endpoint"}
            </button>
          </form>

          <aside style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
            <Kicker>Verifying deliveries</Kicker>
            <p className="m-0 mb-3">
              Every delivery carries an <Mono size={12.5}>X-Sweep-Signature</Mono> header — an
              HMAC-SHA256 of the raw request body, formatted <Mono size={12.5}>sha256=&lt;hex&gt;</Mono>.
            </p>
            <p className="m-0">
              Compute the same HMAC with your endpoint's signing secret and compare before trusting
              an event. Retries reuse the event id, so keep your handler idempotent.
            </p>
          </aside>
        </div>
      </div>
      {confirmRoll && (
        <Dialog
          title="Roll this signing secret?"
          onDismiss={() => { if (secretBusy !== confirmRoll) setConfirmRoll(null); }}
          actions={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmRoll(null)}
                disabled={secretBusy === confirmRoll}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void rollSecret(confirmRoll)}
                disabled={secretBusy === confirmRoll}
              >
                {secretBusy === confirmRoll ? "Rolling…" : "Roll secret"}
              </button>
            </>
          }
        >
          Your handler will <strong>reject every event</strong> from the moment this returns until
          you paste the new secret into it. Roll it if the current one may have leaked — otherwise
          reveal it instead.
        </Dialog>
      )}
    </>
  );
}

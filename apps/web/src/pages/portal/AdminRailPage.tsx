import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal/PageHeader";
import { EmptyNote, ErrorNote, Mono, Section, TableSkeleton, shortAddress } from "@/components/portal/primitives";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface Waiting {
  merchant_id: string;
  name: string;
  email: string;
  payout_wallet: string | null;
  requested_at: string | null;
  account_age_days: number;
  plans: number;
  subscriptions: number;
}

interface Holder {
  merchant_id: string;
  name: string;
  email: string;
  payout_wallet: string | null;
  granted_at: string | null;
  granted_by: string | null;
  mandates: number;
  charges: number;
}

export function AdminRailPage() {
  const [waiting, setWaiting] = useState<Waiting[] | null>(null);
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/portal/admin/rail`, { credentials: "include" });
      const json = (await r.json()) as {
        data?: { waiting: Waiting[]; holders: Holder[] };
        error?: { message?: string };
      };
      if (json.data) {
        setWaiting(json.data.waiting);
        setHolders(json.data.holders);
      } else {
        setError(json.error?.message ?? "Failed to load the rail queue");
      }
    } catch {
      setError("Could not reach the API server");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /// One decision, one code. Named in the confirm because granting the wrong row
  /// should take effort, and because the step-up prompt that follows does not
  /// say which account it is for.
  async function decide(merchantId: string, name: string, enabled: boolean) {
    const question = enabled
      ? `Grant the payment rail to ${name}?\n\nThey will be able to create mandates and collect USDC from payers who authorize them. They'll be emailed.`
      : `Withdraw the payment rail from ${name}?\n\nExisting mandates stay live on chain and are NOT revoked by this — withdraw the entitlement and revoke the mandates if the intent is to stop charges.`;
    if (!confirm(question)) return;

    setBusy(merchantId);
    setError("");
    try {
      const res = await apiFetch(`/portal/admin/rail/${merchantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        if (await wasCancelled(res)) return;
        throw new Error(await messageOf(res, "Couldn't update the entitlement."));
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update the entitlement.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader kicker="Operator" title="Payment rail access" />

      {error && <ErrorNote>{error}</ErrorNote>}

      <Section bordered={false}>
        <p className="m-0 mb-4" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
          The rail decides whether an account may solicit recurring wallet authorizations with Sweep as the
          collection mechanism. Granted by hand, per account, and confirmed with your authenticator each time.
        </p>

        <h3 className="m-0 mb-2" style={{ fontSize: 15, fontWeight: 600 }}>
          Awaiting a decision{waiting ? ` (${waiting.length})` : ""}
        </h3>
        {waiting === null ? (
          <TableSkeleton cols={5} />
        ) : waiting.length === 0 ? (
          <EmptyNote title="Nothing waiting." hint="Requests appear here when a creator asks for the rail." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Requested</th>
                  <th>Payout wallet</th>
                  <th>History</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {waiting.map((m) => (
                  <tr key={m.merchant_id}>
                    <td>
                      <p className="m-0">{m.name}</p>
                      <Mono size={11}><span style={{ color: "var(--color-neutral-600)" }}>{m.email}</span></Mono>
                    </td>
                    <td style={{ color: "var(--color-neutral-700)" }}>
                      {m.requested_at ? new Date(m.requested_at).toLocaleDateString() : "—"}
                      <span className="block" style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>
                        account {m.account_age_days}d old
                      </span>
                    </td>
                    <td>
                      {/* The fact the decision turns on: granting an account that
                          cannot be paid only moves the failure to a charge that
                          dies after the payer has signed. */}
                      {m.payout_wallet ? (
                        <Mono size={12}>{shortAddress(m.payout_wallet)}</Mono>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--color-accent-700)" }}>not linked</span>
                      )}
                    </td>
                    <td style={{ color: "var(--color-neutral-700)", fontSize: 12 }}>
                      {m.plans} plan{m.plans === 1 ? "" : "s"} · {m.subscriptions} subscriber
                      {m.subscriptions === 1 ? "" : "s"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ fontSize: 12, padding: "5px 12px" }}
                        disabled={busy === m.merchant_id}
                        onClick={() => void decide(m.merchant_id, m.name, true)}
                      >
                        {busy === m.merchant_id ? "Working…" : "Grant"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section bordered={false}>
        <h3 className="m-0 mb-2" style={{ fontSize: 15, fontWeight: 600 }}>
          Has the rail{holders ? ` (${holders.length})` : ""}
        </h3>
        {holders === null ? (
          <TableSkeleton cols={4} />
        ) : holders.length === 0 ? (
          <EmptyNote title="No account has the rail yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Granted</th>
                  <th>Activity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {holders.map((m) => (
                  <tr key={m.merchant_id}>
                    <td>
                      <p className="m-0">{m.name}</p>
                      <Mono size={11}><span style={{ color: "var(--color-neutral-600)" }}>{m.email}</span></Mono>
                    </td>
                    <td style={{ color: "var(--color-neutral-700)", fontSize: 12 }}>
                      {m.granted_at ? new Date(m.granted_at).toLocaleDateString() : "—"}
                      {/* Who decided. The reason this panel uses an identity
                          rather than a shared secret. */}
                      <span className="block" style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>
                        {m.granted_by ?? "before this was recorded"}
                      </span>
                    </td>
                    <td style={{ color: "var(--color-neutral-700)", fontSize: 12 }}>
                      {m.mandates} mandate{m.mandates === 1 ? "" : "s"} · {m.charges} charge
                      {m.charges === 1 ? "" : "s"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: 12, padding: "5px 12px" }}
                        disabled={busy === m.merchant_id}
                        onClick={() => void decide(m.merchant_id, m.name, false)}
                      >
                        {busy === m.merchant_id ? "Working…" : "Withdraw"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

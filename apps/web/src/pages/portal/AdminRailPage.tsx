import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal/PageHeader";
import { EmptyNote, ErrorNote, Mono, Section, TableSkeleton, shortAddress } from "@/components/portal/primitives";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";
import { friendlyError, throwApiError } from "@/lib/errors";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/// An account asking to be switched on for live mode. Separate from a rail
/// request: live lets an account take real money at all, the rail lets it
/// additionally solicit standing claims on a payer's wallet.
interface LiveWaiting {
  merchant_id: string;
  name: string;
  email: string;
  payout_wallet: string | null;
  requested_at: string | null;
  plans: number;
  subscriptions: number;
  totp_enrolled: boolean;
}

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
  const [liveWaiting, setLiveWaiting] = useState<LiveWaiting[] | null>(null);
  const [waiting, setWaiting] = useState<Waiting[] | null>(null);
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // The live queue first: the rail grant refuses an account that is not
      // live, so an operator working top to bottom does them in an order that
      // works rather than one that errors.
      const lr = await fetch(`${API_URL}/portal/admin/live`, { credentials: "include" });
      const ljson = (await lr.json()) as { data?: { waiting: LiveWaiting[] } };
      if (ljson.data) setLiveWaiting(ljson.data.waiting);

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

  /// Activating an account for live mode. Same shape as the rail decision —
  /// one code per decision, the account named in the confirm.
  async function decideLive(merchantId: string, name: string, live: boolean) {
    if (!window.confirm(
      live
        ? `Activate ${name} for live mode?\n\nThey will be able to issue a live API key and take real ` +
          `USDC from payers. Reviewed by hand for exactly this reason.`
        : `Deactivate ${name}?\n\nTheir live API key stops working.`
    )) return;
    setBusy(merchantId);
    try {
      const res = await apiFetch(`/portal/admin/live/${merchantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live }),
      });
      if (!res.ok) {
        if (await wasCancelled(res)) return;
        await throwApiError(res, await messageOf(res, "Couldn't change that account."));
      }
      await load();
    } catch (e) {
      setError(friendlyError(e, "Couldn't change that account."));
    } finally {
      setBusy(null);
    }
  }

  /// One decision, one code. Named in the confirm because granting the wrong row
  /// should take effort, and because the step-up prompt that follows does not
  /// say which account it is for.
  async function decide(merchantId: string, name: string, enabled: boolean) {
    let reason: string | undefined;

    if (enabled) {
      if (
        !confirm(
          `Grant the payment rail to ${name}?\n\nThey will be able to create mandates and collect USDC from ` +
            `payers who authorize them. They'll be emailed.`
        )
      ) {
        return;
      }
    } else {
      // Asked for, not optional: the merchant is sent this verbatim, and a
      // capability taken away without a stated reason cannot be appealed.
      const answer = prompt(
        `Withdraw the payment rail from ${name}?\n\n` +
          `They will be emailed this reason and can reply to appeal. Their customers' existing ` +
          `authorizations are NOT cancelled — this only blocks new charges.\n\n` +
          `Reason:`
      );
      if (answer === null) return;
      if (answer.trim().length < 3) {
        setError("A reason is required to withdraw access — the merchant is sent it.");
        return;
      }
      reason = answer.trim();
    }

    setBusy(merchantId);
    setError("");
    try {
      const res = await apiFetch(`/portal/admin/rail/${merchantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled ? { enabled } : { enabled, reason }),
      });
      if (!res.ok) {
        if (await wasCancelled(res)) return;
        await throwApiError(res, "Couldn't update the entitlement.");
      }
      await load();
    } catch (e) {
      setError(friendlyError(e, "Couldn't update the entitlement."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader kicker="Operator" title="Account access" />

      {error && <ErrorNote>{error}</ErrorNote>}

      {/*
        LIVE FIRST, deliberately.

        These are two grants and they are not interchangeable: live mode lets an
        account take real money at all, the rail lets it additionally ask payers
        for a standing claim on their wallet. But a rail grant is REFUSED for an
        account that is not live, because every rail endpoint needs a live API
        key and one cannot be issued to an inactive account. So the order is not
        a preference, and putting live above the rail is what makes it obvious.
      */}
      <Section bordered={false}>
        <h3 className="m-0 mb-2" style={{ fontSize: 15, fontWeight: 600 }}>
          Waiting to go live{liveWaiting ? ` (${liveWaiting.length})` : ""}
        </h3>
        <p className="m-0 mb-3" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
          Activating an account lets it issue a live API key and take real USDC. Reviewed by hand,
          and confirmed with your authenticator each time.
        </p>
        {liveWaiting === null ? (
          <TableSkeleton cols={4} />
        ) : liveWaiting.length === 0 ? (
          <EmptyNote title="Nothing waiting." hint="Requests appear here when a creator asks to go live from Settings." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Requested</th>
                  <th>Payout wallet</th>
                  <th>Authenticator</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {liveWaiting.map((m) => (
                  <tr key={m.merchant_id}>
                    <td>
                      <span style={{ fontWeight: 600 }}>{m.name}</span>
                      <br />
                      <span style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>
                        {m.email} · {m.plans} plan{m.plans === 1 ? "" : "s"} · {m.subscriptions} sub
                        {m.subscriptions === 1 ? "" : "s"}
                      </span>
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {m.requested_at ? new Date(m.requested_at).toLocaleDateString() : "—"}
                    </td>
                    <td>
                      {m.payout_wallet ? (
                        <Mono size={12}>{shortAddress(m.payout_wallet)}</Mono>
                      ) : (
                        <span className="tag tag-outline">Not linked</span>
                      )}
                    </td>
                    <td>
                      {/* Said in the row because activating an account that
                          cannot prove itself activates one that then cannot
                          issue the key it came for — every credential action is
                          totp-only. */}
                      <span className={`tag ${m.totp_enrolled ? "tag-accent" : "tag-outline"}`}>
                        {m.totp_enrolled ? "Enrolled" : "Not enrolled"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ fontSize: 12, padding: "6px 12px" }}
                        onClick={() => void decideLive(m.merchant_id, m.name, true)}
                        disabled={busy === m.merchant_id}
                      >
                        {busy === m.merchant_id ? "Working…" : "Activate"}
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

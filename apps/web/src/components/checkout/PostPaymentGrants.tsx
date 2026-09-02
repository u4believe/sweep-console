import { useCallback, useEffect, useState } from "react";
import { useConnectorClient } from "wagmi";
import { getSupportedDelegationChainIds } from "@/lib/delegation/capabilities";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import { fetchSubscriptionGrantPlan, saveSubscriptionDelegation } from "@/lib/gateway";
import type { GrantProof, GrantTarget } from "@/lib/gateway";

/**
 * Confirmation-page authorization.
 *
 * The payment is done; these grants are for FUTURE renewals, so they bind to
 * the subscription that was just created rather than the spent checkout
 * session. A subscriber who paid from one chain can come back here and cover
 * the rest, either one at a time or all at once — the same two routes offered
 * during checkout, so the choice reads the same in both places.
 *
 * Identity here is whichever proof the subscriber actually has. Most did an OTP
 * and hold an email token; one recognised by their wallet never did, and used to
 * see nothing at all on this screen. Both are accepted — see the note on
 * sessionProofSchema in the API's routes/customer-portal.ts.
 */
export function PostPaymentGrants({
  subscriptionId,
  sessionId,
  sessionToken,
  walletAddress,
  email,
  emailToken,
  alreadyGranted,
}: {
  subscriptionId: string;
  sessionId: string;
  sessionToken: string;
  walletAddress: string;
  email?: string;
  emailToken?: string | null;
  /** chain_keys authorized during checkout. */
  alreadyGranted: string[];
}) {
  const { data: connectorClient } = useConnectorClient();
  const [targets, setTargets] = useState<GrantTarget[]>([]);
  const [supported, setSupported] = useState<number[] | null>(null);
  const [granted, setGranted] = useState<string[]>(alreadyGranted);
  const [busy, setBusy] = useState<string | "all" | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  // Prefer the email token when there is one — it is the identity anchor, and
  // keeps the subscriber's own /manage session and this screen on one proof.
  // Otherwise the checkout session that just paid speaks for this subscription.
  const proof: GrantProof =
    emailToken && email ? { email, email_token: emailToken } : { session_id: sessionId, session_token: sessionToken };

  const load = useCallback(async () => {
    try {
      const [plan, ids] = await Promise.all([
        fetchSubscriptionGrantPlan(subscriptionId, proof),
        connectorClient ? getSupportedDelegationChainIds(connectorClient) : Promise.resolve(null),
      ]);
      setTargets(plan.targets);
      setSupported(ids);
    } catch {
      /* leave the section hidden rather than showing a broken panel */
    } finally {
      setReady(true);
    }
    // `proof` is derived from these, so listing them keeps the dep array honest.
  }, [subscriptionId, email, emailToken, sessionId, sessionToken, connectorClient]);

  useEffect(() => { void load(); }, [load]);

  async function authorize(list: GrantTarget[], scope: string | "all") {
    if (!connectorClient || list.length === 0) return;
    setBusy(scope);
    setError("");
    try {
      const failures = await grantRenewalMandates(
        walletAddress,
        list,
        (input) =>
          saveSubscriptionDelegation(subscriptionId, { ...input, ...proof })
      );
      const failed = new Set(failures.map((f) => f.target.chain_key));
      setGranted((prev) => [
        ...prev,
        ...list.filter((t) => !failed.has(t.chain_key)).map((t) => t.chain_key),
      ]);
      if (failures.length > 0) {
        setError(`Couldn't authorize ${failures.map((f) => f.target.name).join(", ")}.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /rejected|denied|cancell?ed/i.test(msg) ? "Request cancelled." : msg || "Couldn't authorize."
      );
    } finally {
      setBusy(null);
    }
  }

  // Inconclusive probe ⇒ show every chain; a grant attempt is the real test.
  const usable = supported ? targets.filter((t) => supported.includes(t.chain_id)) : targets;
  const remaining = usable.filter((t) => !granted.includes(t.chain_key));
  if (!ready || usable.length === 0) return null;

  return (
    <div style={{ marginTop: 36 }}>
      <p
        className="m-0 uppercase"
        style={{ fontSize: 11, letterSpacing: "0.14em", marginBottom: 12 }}
      >
        Renewal permissions
      </p>

      <div style={{ background: "var(--color-surface)", border: "2px solid var(--color-divider)", padding: 16 }}>
        <p className="m-0" style={{ fontSize: 12.5, color: "var(--color-neutral-800)", lineHeight: 1.6 }}>
          {remaining.length === 0
            ? "Every supported chain is authorized. Renewals will charge from whichever one holds enough USDC."
            : "Authorize more chains so a renewal can still go through when your Arc balance runs low. We submit each one and pay the gas. Revoke anytime from your wallet."}
        </p>

        <div style={{ borderTop: "1px solid var(--color-divider)", marginTop: 14 }}>
          <div
            className="flex items-center gap-3"
            style={{ padding: "11px 0", borderBottom: "1px solid var(--color-divider)" }}
          >
            <span style={{ fontSize: 13.5 }}>Arc</span>
            <span className="tag tag-outline">Authorized</span>
          </div>

          {usable.map((t) => {
            const on = granted.includes(t.chain_key);
            return (
              <div
                key={t.chain_id}
                className="flex items-center gap-3"
                style={{ padding: "11px 0", borderBottom: "1px solid var(--color-divider)" }}
              >
                <span style={{ fontSize: 13.5 }}>{t.name}</span>
                {on && <span className="tag tag-outline">Authorized</span>}
                {!on && (
                  <button
                    type="button"
                    className="btn btn-secondary ml-auto"
                    style={{ padding: "6px 12px", fontSize: 12 }}
                    onClick={() => void authorize([t], t.chain_key)}
                    disabled={busy !== null}
                  >
                    {busy === t.chain_key ? "Authorizing…" : "Authorize"}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {error && (
          <p className="m-0" style={{ fontSize: 12, color: "var(--color-accent-700)", marginTop: 10 }}>
            {error}
          </p>
        )}

        {remaining.length > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: "10px 16px", marginTop: 14 }}
            onClick={() => void authorize(remaining, "all")}
            disabled={busy !== null}
          >
            {busy === "all" ? "Authorizing…" : "Authorize grant permission for all chains"}
          </button>
        )}
      </div>
    </div>
  );
}

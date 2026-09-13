import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { PageHeader } from "@/components/portal/PageHeader";
import {
  EmptyNote,
  ErrorNote,
  FilterTabs,
  KpiBand,
  Mono,
  Section,
  StatusTag,
  TableSkeleton,
  shortAddress,
} from "@/components/portal/primitives";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface Mandate {
  id: string;
  externalRef: string;
  email: string | null;
  walletAddress: string | null;
  maxAmount: number;
  interval: string;
  status: string;
  isTestMode: boolean;
  chargeCount: number;
  expiresAt: string;
  authorizedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface Charge {
  id: string;
  mandateId: string;
  externalRef: string;
  amount: number;
  currency: string;
  status: string;
  description: string | null;
  sourceChain: string | null;
  txHash: string | null;
  failureReason: string | null;
  isTestMode: boolean;
  createdAt: string;
  settledAt: string | null;
}

interface RailData {
  enabled: boolean;
  requestedAt: string | null;
  payoutWallet: string | null;
  totals: { collected: number; pendingCount: number; failedCount: number; activeMandates: number };
  mandates: Mandate[];
  charges: Charge[];
}

/// "daily" is the word the API takes; a sentence needs the noun. Same mapping the
/// authorization page shows the payer, so the ceiling reads the way they agreed it.
const INTERVAL_NOUN: Record<string, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

const CHAIN_NAMES: Record<string, string> = {
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  arc: "Arc",
};

const usdc = (v: number) => formatUnits(BigInt(v), 6);

type Tab = "charges" | "mandates";

export function RailPage() {
  const [data, setData] = useState<RailData | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("charges");
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState("");

  const requestAccess = async () => {
    setRequesting(true);
    setRequestError("");
    try {
      const res = await fetch(`${API_URL}/portal/rail/request`, {
        method: "POST",
        credentials: "include",
      });
      const json: { data?: { enabled: boolean; requestedAt: string | null }; error?: { message?: string } } =
        await res.json();
      if (json.data) setData((d) => (d ? { ...d, ...json.data! } : d));
      else setRequestError(json.error?.message ?? "Could not send the request");
    } catch {
      setRequestError("Could not reach the API server");
    } finally {
      setRequesting(false);
    }
  };

  useEffect(() => {
    fetch(`${API_URL}/portal/rail`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: RailData; error?: { message?: string } }) => {
        if (json.data) setData(json.data);
        else setError(json.error?.message ?? "Failed to load rail activity");
      })
      .catch(() => setError("Could not reach the API server"));
  }, []);

  const kpis = useMemo(
    () => [
      { label: "Collected", value: data ? usdc(data.totals.collected) : "—", unit: "USDC" },
      { label: "Active mandates", value: String(data?.totals.activeMandates ?? 0) },
      { label: "In flight", value: String(data?.totals.pendingCount ?? 0) },
      {
        label: "Failed",
        value: String(data?.totals.failedCount ?? 0),
        accent: (data?.totals.failedCount ?? 0) > 0,
      },
    ],
    [data]
  );

  if (error) {
    return (
      <>
        <PageHeader kicker="Developers" title="Payment rail" />
        <ErrorNote>{error}</ErrorNote>
      </>
    );
  }

  // Not having the rail is a normal state, not an empty one. Say how to get it
  // rather than showing four zeroes and two empty tables.
  if (data && !data.enabled) {
    return (
      <>
        <PageHeader kicker="Developers" title="Payment rail" />
        <Section bordered={false}>
          <EmptyNote
            title={
              data.requestedAt
                ? "Your request for the payment rail has been received."
                : "The payment rail is not enabled on this account."
            }
            hint={
              data.requestedAt
                ? `Requested ${new Date(data.requestedAt).toLocaleDateString()}. We review these by hand — the rail ` +
                  "is the one place an API key alone moves money, so it is granted per account rather than switched " +
                  "on. We'll email you when it is live. Meanwhile the Payment rail section of the docs covers " +
                  "everything you would build."
                : "The rail lets your own app charge a wallet directly — you create a mandate, the payer signs it " +
                  "once, and your code calls POST /v1/charges on your own schedule. See the Payment rail section of " +
                  "the docs for what that involves."
            }
          />
          {!data.requestedAt && (
            <div style={{ padding: "0 32px 26px" }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={requestAccess}
                disabled={requesting}
              >
                {requesting ? "Sending…" : "Request access"}
              </button>
              {/* Said before they click, not after: a charge dies on
                  no_payout_wallet, and finding that out post-approval wastes a
                  round trip through a human. */}
              {!data.payoutWallet && (
                <p className="m-0 mt-2" style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>
                  You have no payout wallet linked yet. The rail cannot pay you without one — link it in Settings
                  before your first charge.
                </p>
              )}
              {requestError && (
                <p className="m-0 mt-2" style={{ fontSize: 12, color: "var(--color-accent)" }}>
                  {requestError}
                </p>
              )}
            </div>
          )}
        </Section>
      </>
    );
  }

  const charges = data?.charges ?? null;
  const mandates = data?.mandates ?? null;

  return (
    <>
      <PageHeader kicker="Developers" title="Payment rail" />

      <KpiBand items={kpis} loading={!data} />

      <FilterTabs
        tabs={[
          { id: "charges" as Tab, label: "Charges", count: charges?.length ?? 0 },
          { id: "mandates" as Tab, label: "Mandates", count: mandates?.length ?? 0 },
        ]}
        active={tab}
        onSelect={setTab}
      />

      {tab === "charges" ? (
        <Section bordered={false}>
          {charges === null ? (
            <TableSkeleton cols={6} />
          ) : charges.length === 0 ? (
            <EmptyNote
              title="No charges yet."
              hint="Charges appear here once your app calls POST /v1/charges against an authorized mandate."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>For</th>
                    <th>Paid from</th>
                    <th>Settlement</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {charges.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <p className="m-0">
                          {usdc(c.amount)} {c.currency}
                        </p>
                        <Mono size={11}>
                          <span style={{ color: "var(--color-neutral-600)" }}>{c.id}</span>
                        </Mono>
                      </td>
                      <td>
                        <StatusTag status={c.status} />
                        {c.failureReason ? (
                          <p className="m-0 mt-1" style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>
                            {c.failureReason}
                          </p>
                        ) : null}
                      </td>
                      <td>
                        <p className="m-0">{c.description ?? "—"}</p>
                        <Mono size={11}>
                          <span style={{ color: "var(--color-neutral-600)" }}>{c.externalRef}</span>
                        </Mono>
                      </td>
                      <td style={{ color: "var(--color-neutral-700)" }}>
                        {c.sourceChain ? CHAIN_NAMES[c.sourceChain] ?? c.sourceChain : "—"}
                      </td>
                      <td style={{ color: "var(--color-neutral-700)" }}>
                        {/* Always an ARC hash even though the money came from the
                            chain in the previous column — the pair confuses people
                            who go looking for it on Base. */}
                        {c.txHash ? (
                          <Mono>{shortAddress(c.txHash)}</Mono>
                        ) : c.status === "succeeded" ? (
                          <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>
                            settled, no reference
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={{ color: "var(--color-neutral-700)" }}>
                        {new Date(c.settledAt ?? c.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : (
        <Section bordered={false}>
          {mandates === null ? (
            <TableSkeleton cols={6} />
          ) : mandates.length === 0 ? (
            <EmptyNote
              title="No mandates yet."
              hint="Create one with POST /v1/mandates, then send the payer the authorization_url it returns."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Payer</th>
                    <th>Status</th>
                    <th>Ceiling</th>
                    <th>Charges</th>
                    <th>Wallet</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {mandates.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <p className="m-0">{m.email ?? "—"}</p>
                        <Mono size={11}>
                          <span style={{ color: "var(--color-neutral-600)" }}>{m.externalRef}</span>
                        </Mono>
                      </td>
                      <td>
                        <StatusTag status={m.status} />
                        {m.status === "pending" ? (
                          <p className="m-0 mt-1" style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>
                            awaiting the payer's signature
                          </p>
                        ) : null}
                      </td>
                      <td style={{ color: "var(--color-neutral-700)" }}>
                        {usdc(m.maxAmount)} USDC / {INTERVAL_NOUN[m.interval] ?? m.interval}
                      </td>
                      <td style={{ color: "var(--color-neutral-700)" }}>{m.chargeCount}</td>
                      <td style={{ color: "var(--color-neutral-700)" }}>
                        {m.walletAddress ? <Mono>{shortAddress(m.walletAddress)}</Mono> : "—"}
                      </td>
                      <td style={{ color: "var(--color-neutral-700)" }}>
                        {new Date(m.expiresAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      <Section bordered={false}>
        <p className="m-0" style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>
          Collected is what payers were charged. Your share is that less the platform fee, which is taken on the
          source chain before the bridge — settlement lands on Arc
          {data?.payoutWallet ? (
            <>
              {" "}
              in <Mono size={11}>{shortAddress(data.payoutWallet)}</Mono>
            </>
          ) : null}
          . Rail activity is counted separately from subscriptions throughout the portal: the dashboard reports it in
          its own band, and the subscription payments ledger does not include it.
        </p>
      </Section>
    </>
  );
}

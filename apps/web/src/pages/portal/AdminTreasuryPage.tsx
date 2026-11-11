import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal/PageHeader";
import { EmptyNote, ErrorNote, Mono, Section, TableSkeleton } from "@/components/portal/primitives";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface TreasuryRow {
  role: string;
  /// "7702" | "entrypoint" on delegate rows; absent elsewhere.
  spends?: string;
  address: string;
  chain: string;
  balance: string;
  symbol: string;
  required: boolean;
  warning?: string;
}

/// What each account is for, in one line, because the addresses look alike and
/// the funding rules are not uniform between them.
const ROLE_NOTE: Record<string, string> = {
  renewal: "Redeems hosted grants — the account that pays gas",
  external: "Redeems external-rail grants",
};

/**
 * What a delegate's ETH pays for, which the two designs answer differently.
 *
 * Taken from the row rather than hardcoded: the API knows which design is
 * live, and a note that says "self-bundles" under 7702 would send an operator
 * looking for an EntryPoint deposit that does not exist.
 */
function spendNote(rs: Array<{ spends?: string }>): string {
  const spends = rs.find((r) => r.spends)?.spends;
  if (spends === "7702") return " — this address IS the delegate and pays for the redeem directly";
  if (spends === "entrypoint") return " — funds an EntryPoint deposit the smart account spends from";
  return "";
}

/**
 * Two roles, not four.
 *
 * "settlement" received pulls and bridged them, and "renewal-arc" minted the
 * other end on Arc. Both belong to a path that no longer exists, and an
 * operator screen listing accounts nobody funds reads as four wallets to keep
 * topped up when there are two.
 */
const ROLE_ORDER = ["renewal", "external"];

export function AdminTreasuryPage() {
  const [rows, setRows] = useState<TreasuryRow[] | null>(null);
  const [mode, setMode] = useState<string>("");
  const [gasFloor, setGasFloor] = useState<string>("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`${API_URL}/portal/admin/treasury`, { credentials: "include" });
      const json = await res.json();
      if (!res.ok) {
        // 404 is what a non-admin gets, by design — the route does not
        // announce itself. Say something truthful rather than "not found".
        setError(
          res.status === 404
            ? "This screen is for platform operators."
            : json?.error?.message ?? "Failed to load"
        );
        setRows([]);
        return;
      }
      setRows(json.data?.rows ?? []);
      setMode(json.data?.mode ?? "");
      setGasFloor(json.data?.gasFloorUsdc ?? "");
    } catch {
      setError("Could not reach the API server");
      setRows([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const byRole = ROLE_ORDER.map((r) => [r, (rows ?? []).filter((x) => x.role === r)] as const)
    .filter(([, rs]) => rs.length > 0);

  const shortfalls = (rows ?? []).filter((r) => r.warning).length;

  return (
    <>
      <PageHeader kicker="Operator" title="Platform balances" />

      {error && <ErrorNote>{error}</ErrorNote>}

      <Section bordered={false}>
        <p className="m-0 mb-4" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
          The platform's own accounts{mode ? ` on ${mode === "live" ? "mainnet" : "testnet"}` : ""}, not any
            merchant's. A delegate without native gas stops redeeming and does not announce it — the
            first sign is a renewal that silently did not run.
        </p>

        {rows === null ? (
          <TableSkeleton />
        ) : rows.length === 0 && !error ? (
          <EmptyNote title="No platform accounts are configured on this deployment." />
        ) : (
          byRole.map(([role, rs]) => (
            <div key={role} className="mb-5">
              <h3 className="m-0 mb-1" style={{ fontSize: 15, fontWeight: 600 }}>
                {role[0]!.toUpperCase() + role.slice(1)}
              </h3>
              <p className="m-0 mb-2" style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>
                {(ROLE_NOTE[role] ?? "") + spendNote(rs)}
              </p>
              {/* The whole address, selectable. These are copied into Railway
                  variables and into a wallet's send field, and a shortened one
                  serves neither — the point of the screen is to act on them. */}
              {rs[0] && (
                <p
                  className="m-0 mb-2"
                  style={{ fontSize: 12, userSelect: "all", wordBreak: "break-all" }}
                >
                  <Mono>{rs[0].address}</Mono>
                </p>
              )}

              <div className="flex flex-wrap" style={{ gap: 10 }}>
                {rs.map((r) => (
                  <div
                    key={`${r.role}-${r.chain}`}
                    style={{
                      border: "1px solid var(--color-divider)",
                      padding: "8px 12px",
                      minWidth: 132,
                      // A balance that does not matter on this chain should not
                      // read as a shortfall: settlement needs ETH on Optimism
                      // only, because the other two are paid in USDC.
                      opacity: r.required ? 1 : 0.55,
                    }}
                  >
                    <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-neutral-600)" }}>
                      {r.chain}
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.3 }}>
                      {r.balance} <span style={{ fontSize: 11, fontWeight: 500 }}>{r.symbol}</span>
                    </div>
                    {r.warning ? (
                      <div style={{ fontSize: 11, color: "var(--color-accent-700)" }}>{r.warning}</div>
                    ) : !r.required ? (
                      <div style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>not needed here</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}

        {rows !== null && rows.length > 0 && (
          <p className="m-0 mt-3" style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>
            {shortfalls === 0
              ? "Every account has what it needs."
              : `${shortfalls} account${shortfalls === 1 ? "" : "s"} below what they need.`}
            {gasFloor && (
              <>
                {" "}Settlement holds no USDC float — each payment tops it toward {gasFloor} USDC out of the
                platform's own fee, never the merchant's share.
              </>
            )}
          </p>
        )}

        <button type="button" className="btn btn-secondary mt-3" onClick={() => { setRows(null); void load(); }}>
          Refresh
        </button>
      </Section>
    </>
  );
}

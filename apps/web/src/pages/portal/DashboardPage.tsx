import { useEffect, useMemo, useState } from "react";
import { useScope } from "@/context/scope";
import { useNavigate } from "react-router-dom";
import { WalletSetupBanner } from "@/components/portal/WalletSetupBanner";
import { PageHeader } from "@/components/portal/PageHeader";
import {
  ErrorNote,
  Kicker,
  KpiBand,
  Mono,
  Section,
  StatusTag,
  type Kpi,
} from "@/components/portal/primitives";
import { WithdrawSection } from "./WithdrawSection";
import { PayoutRoutesSection } from "./PayoutRoutesSection";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/** The slice of /portal/rail this screen reads. */
interface RailSummary {
  totals: { collected: number; pendingCount: number; failedCount: number; activeMandates: number };
  charges: Array<{ amount: number; status: string; createdAt: string }>;
}

interface DashboardData {
  activeSubs: number;
  totalRevenue: number;
  plans: number;
  failedPayments: number;
  walletAddress: string | null;
  walletType: string;
}

interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  type: string;
  planName: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  createdAt: string;
}

/**
 * A payout out of a Circle payout wallet.
 *
 * `explorerUrl` is built by the API, not here: the deployment knows its own
 * network (portalAuth sets isTestMode = !isMainnet(), one mode per site) and
 * the server already derives the Arc explorer from the same ARC_NETWORK that
 * picks the chain set. Deriving it in the browser would be a second opinion
 * about a fact the server holds.
 */
interface Withdrawal {
  id: string;
  amount: number;
  currency: string;
  state: string;
  txHash: string | null;
  explorerUrl: string | null;
  createdAt: string;
}

/**
 * A cross-chain payout, as the activity list needs it.
 *
 * Carried separately from Withdrawal because the two fail differently. A
 * Circle withdrawal is done when the chain confirms it; a cross-chain payout
 * can confirm on the origin chain and still never arrive — which is exactly
 * the case this row exists to make visible.
 */
interface CrossChainPayout {
  id: string;
  status: string;
  toLabel: string;
  asset: string;
  amount: string | null;
  depositTxHash: string | null;
  depositExplorerUrl: string | null;
  createdAt: string;
}

/** One row of the activity table, from any source. */
type ActivityRow = {
  key: string;
  amount: number;
  kind: string;
  status: string;
  plan: string | null;
  createdAt: string;
  txHash: string | null;
  explorerUrl: string | null;
  outgoing: boolean;
};

interface Subscription {
  id: string;
  status: string;
  currentPeriodEnd: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type RangeKey = "day" | "week" | "14d" | "month";

interface ChartRange {
  key: RangeKey;
  /** Control label — kept to 2–3 characters so the row stays compact. */
  label: string;
  /** Reads after "Settled USDC · ". */
  heading: string;
  buckets: number;
  /**
   * A day of daily buckets would be a single bar, so the 24-hour range buckets
   * by hour instead. Everything wider buckets by day.
   */
  unit: "hour" | "day";
}

const RANGES: ChartRange[] = [
  { key: "day", label: "24h", heading: "last 24 hours", buckets: 24, unit: "hour" },
  { key: "week", label: "7d", heading: "last 7 days", buckets: 7, unit: "day" },
  { key: "14d", label: "14d", heading: "last 14 days", buckets: 14, unit: "day" },
  { key: "month", label: "30d", heading: "last 30 days", buckets: 30, unit: "day" },
];

/** The widest range decides what the chart has to fetch. */
const MAX_RANGE_DAYS = 30;

/** One bucket of settled value, in USDC micro-units. */
interface Bar {
  start: Date;
  total: number;
}

/**
 * Takes the two fields it actually reads rather than a whole Payment, so the
 * rail's Charges can feed the same chart without being cast into a shape
 * they are not.
 */
function buildChart(
  payments: Array<{ amount: number; createdAt: string; status: string }>,
  range: ChartRange
): Bar[] {
  const step = range.unit === "hour" ? HOUR_MS : DAY_MS;

  // Align to the start of the current hour/day, so buckets land on clean
  // boundaries and the last one is the period in progress.
  const anchor = new Date();
  if (range.unit === "hour") anchor.setMinutes(0, 0, 0);
  else anchor.setHours(0, 0, 0, 0);

  const firstStart = anchor.getTime() - (range.buckets - 1) * step;

  const bars: Bar[] = Array.from({ length: range.buckets }, (_, i) => ({
    start: new Date(firstStart + i * step),
    total: 0,
  }));

  for (const p of payments) {
    if (p.status !== "succeeded") continue;
    const d = new Date(p.createdAt);
    if (Number.isNaN(d.getTime())) continue;

    // Truncate the payment to the same boundary before differencing, so a DST
    // shift moves both ends together instead of dropping a bucket.
    if (range.unit === "hour") d.setMinutes(0, 0, 0);
    else d.setHours(0, 0, 0, 0);

    const idx = Math.round((d.getTime() - firstStart) / step);
    if (idx >= 0 && idx < range.buckets) bars[idx]!.total += p.amount;
  }
  return bars;
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const SHORT_HOUR = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const FULL_HOUR = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric" });

const axisLabel = (b: Bar, unit: ChartRange["unit"]) =>
  unit === "hour" ? SHORT_HOUR.format(b.start) : SHORT_DATE.format(b.start);

/**
 * Settled value per day as a bar column chart. Bars sit on a 2px baseline;
 * a day with no settlement keeps a 2px stub so the rhythm of the grid reads
 * continuously rather than leaving holes.
 */
function SettledChart({ bars, unit }: { bars: Bar[]; unit: ChartRange["unit"] }) {
  const max = Math.max(...bars.map((b) => b.total), 1);
  // 30 columns cannot carry the 5px gutter the 7-day view is drawn with.
  const gap = bars.length > 20 ? 3 : bars.length > 10 ? 4 : 6;
  const mid = bars[Math.floor((bars.length - 1) / 2)]!;
  return (
    <>
      <div
        className="flex items-end"
        style={{ height: 150, gap, borderBottom: "1px solid var(--color-divider)", paddingTop: 14 }}
      >
        {bars.map((b, i) => {
          /*
           * The last bar is the period in progress, and it is the only one
           * drawn in the accent. The rest are a light wash.
           *
           * Every bar at full accent made the series one block of colour with
           * no reading in it; the design puts the weight on today, so the
           * shape of the fortnight is legible behind it. Both colours come
           * from the accent ramp, so this follows the console's scope — ink
           * on the rail, indigo on hosted — without knowing which it is in.
           */
          const current = i === bars.length - 1;
          return (
            <div
              key={b.start.toISOString()}
              title={`${unit === "hour" ? FULL_HOUR.format(b.start) : SHORT_DATE.format(b.start)} · ${(b.total / 1_000_000).toFixed(2)} USDC`}
              style={{
                flex: 1,
                height: b.total > 0 ? `${Math.max((b.total / max) * 100, 4)}%` : 2,
                borderRadius: "3px 3px 0 0",
                background:
                  b.total > 0
                    ? current
                      ? "var(--color-accent)"
                      : "var(--color-accent-300)"
                    : "var(--color-neutral-300)",
              }}
            />
          );
        })}
      </div>
      <div
        className="mt-[7px] flex justify-between"
        style={{ fontSize: 11, color: "var(--color-neutral-600)", fontFamily: "ui-monospace, Menlo, monospace" }}
      >
        <span>{axisLabel(bars[0]!, unit)}</span>
        <span>{axisLabel(mid, unit)}</span>
        <span>{axisLabel(bars[bars.length - 1]!, unit)}</span>
      </div>
    </>
  );
}

/** Range picker for the settled chart. */
function RangeTabs({ value, onChange }: { value: RangeKey; onChange: (k: RangeKey) => void }) {
  return (
    <div className="flex" role="tablist" aria-label="Chart range" style={{ border: "1px solid var(--color-divider)" }}>
      {RANGES.map((r) => {
        const on = r.key === value;
        return (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(r.key)}
            style={{
              border: 0,
              background: on ? "var(--color-text)" : "transparent",
              color: on ? "var(--color-bg)" : "var(--color-neutral-700)",
              fontFamily: "ui-monospace, Menlo, monospace",
              fontSize: 10.5,
              letterSpacing: "0.04em",
              padding: "4px 9px",
              cursor: "pointer",
            }}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost"
      style={{ fontSize: 12 }}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * The next day on which any active subscription renews, with how many renew
 * that day. Derived from subscription period ends rather than a schedule
 * endpoint, so it reflects exactly what the billing engine will pick up.
 */
function nextRenewalBatch(subs: Subscription[]): { day: Date; count: number } | null {
  const upcoming = subs
    .filter((s) => s.status === "active" || s.status === "trialing")
    .map((s) => new Date(s.currentPeriodEnd))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  const first = upcoming[0];
  if (!first) return null;

  const dayKey = first.toDateString();
  return { day: first, count: upcoming.filter((d) => d.toDateString() === dayKey).length };
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  // Chart rows and the activity list are fetched separately on purpose. The
  // chart needs every payment in the widest window (a flat cap silently
  // truncates the series and under-reports settled value); the activity list
  // needs the newest five REGARDLESS of age, which a windowed query cannot give
  // it — a merchant quiet for a month would otherwise see "No payments yet".
  const [chartPayments, setChartPayments] = useState<Payment[]>([]);
  const [recent, setRecent] = useState<Payment[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [payouts, setPayouts] = useState<CrossChainPayout[]>([]);
  /**
   * Payments and payouts in one list, newest first, trimmed to five.
   *
   * Merged in the browser rather than by the API because the two are different
   * resources with different shapes and lifetimes, and /portal/payments is a
   * public-ish contract several screens read. A union type here costs one sort;
   * a union endpoint would cost every caller of payments.
   *
   * Payments now link their hash too. They carry a hash on whichever chain they
   * settled on,
   * so an unlinked payment hash beside a linked withdrawal one would look
   * broken rather than deliberate — and the explorer is the same.
   */
  const activity: ActivityRow[] = [
    ...recent.map((p) => ({
      key: `p_${p.id}`,
      amount: p.amount,
      kind: p.type,
      status: p.status,
      plan: p.planName,
      createdAt: p.createdAt,
      txHash: p.txHash,
      explorerUrl: p.txHash ? p.explorerUrl : null,
      outgoing: false,
    })),
    ...withdrawals.map((w) => ({
      key: `w_${w.id}`,
      amount: w.amount,
      kind: "withdrawal",
      status: w.state.toLowerCase(),
      plan: null,
      createdAt: w.createdAt,
      txHash: w.txHash,
      explorerUrl: w.explorerUrl,
      outgoing: true,
    })),
    /**
     * Cross-chain payouts, which Circle's webhook cannot describe.
     *
     * The deposit leg confirms on the origin chain like any other
     * withdrawal — so without this row, a payout that left the wallet and
     * never arrived would appear in this very table as a SUCCESSFUL
     * withdrawal. The destination is put in the Plan column because that is
     * the question a creator asks of a payout: not which plan, but where did
     * it go.
     */
    ...payouts.map((p) => ({
      key: `x_${p.id}`,
      amount: Math.round(Number(p.amount ?? 0) * 1_000_000),
      kind: "payout",
      status: p.status,
      plan: `→ ${p.toLabel} ${p.asset}`,
      createdAt: p.createdAt,
      txHash: p.depositTxHash,
      explorerUrl: p.depositExplorerUrl,
      outgoing: true,
    })),
  ]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 5);

  const [rangeKey, setRangeKey] = useState<RangeKey>("14d");
  const [subs, setSubs] = useState<Subscription[]>([]);
  const scope = useScope();
  /**
   * Only fetched in rail scope — a hosted merchant should not pay for a
   * query whose numbers never reach the screen, and /portal/rail answers
   * 409-shaped data for an account without access.
   */
  const [rail, setRail] = useState<RailSummary | null>(null);
  useEffect(() => {
    if (scope !== "rail") return;
    let alive = true;
    fetch(`${API_URL}/portal/rail`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: RailSummary }) => { if (alive && json.data) setRail(json.data); })
      .catch(() => { /* the band shows its loading state */ });
    return () => { alive = false; };
  }, [scope]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/portal/dashboard`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: DashboardData; error?: { message?: string } }) => {
        if (json.data) setData(json.data);
        else setError(json.error?.message ?? "Failed to load dashboard");
      })
      .catch(() => setError("Could not reach the API server"));

    fetch(`${API_URL}/portal/payments?days=${MAX_RANGE_DAYS}&limit=2000`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Payment[] }) => { if (json.data) setChartPayments(json.data); })
      .catch(() => { /* the chart degrades to empty */ });

    // Only a Circle-held payout wallet produces these; an external wallet
    // moves its own USDC and we never see it, so the list is simply empty and
    // the activity table is payments alone.
    fetch(`${API_URL}/portal/withdrawals?limit=5`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Array<Record<string, unknown>> }) => {
        if (!json.data) return;
        setWithdrawals(
          json.data.map((w) => ({
            id: String(w.id),
            amount: Number(w.amount),
            currency: String(w.currency ?? "USDC"),
            state: String(w.state ?? ""),
            txHash: (w.tx_hash as string | null) ?? null,
            explorerUrl: (w.explorer_url as string | null) ?? null,
            createdAt: String(w.created_at),
          }))
        );
      })
      .catch(() => { /* the activity list degrades to payments only */ });

    // Cross-chain payouts. Empty until the path is enabled, so this costs a
    // 200 with no rows rather than being conditional on a flag the browser
    // would have to learn first.
    fetch(`${API_URL}/portal/payouts?limit=5`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Array<Record<string, unknown>> }) => {
        if (!json.data) return;
        setPayouts(
          json.data.map((p) => ({
            id: String(p.id),
            status: String(p.status ?? ""),
            toLabel: String(p.to_label ?? ""),
            asset: String(p.asset ?? "USDC"),
            amount: (p.amount as string | null) ?? null,
            depositTxHash: (p.deposit_tx_hash as string | null) ?? null,
            depositExplorerUrl: (p.deposit_explorer_url as string | null) ?? null,
            createdAt: String(p.created_at),
          }))
        );
      })
      .catch(() => { /* the activity list degrades to payments and withdrawals */ });

    fetch(`${API_URL}/portal/payments?limit=5`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Payment[] }) => { if (json.data) setRecent(json.data); })
      .catch(() => { /* the activity table degrades to empty */ });

    fetch(`${API_URL}/portal/subscriptions`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: Subscription[] }) => { if (json.data) setSubs(json.data); })
      .catch(() => { /* the renewal panel degrades to empty */ });
  }, []);

  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[2]!;
  // Every range is derived from the one 30-day fetch, so switching is instant
  // and never shows a loading state — and each is real data for its own window,
  // not a rescale of the 14-day series.
  /**
   * The series is this scope's money: settled Payments on hosted, settled
   * rail Charges on the rail. Same shape — amount plus a timestamp — so one
   * chart serves both rather than two that drift apart.
   */
  const series = useMemo(
    () =>
      scope === "rail"
        ? (rail?.charges ?? [])
        : chartPayments,
    [scope, rail, chartPayments]
  );
  const bars = useMemo(() => buildChart(series, range), [series, range]);
  const settled = useMemo(() => bars.reduce((n, b) => n + b.total, 0), [bars]);
  const batch = useMemo(() => nextRenewalBatch(subs), [subs]);

  // "Subscription revenue" rather than "Total revenue": this is a Payment
  // aggregate and a rail charge writes a Charge, so the word total stopped being
  // true when the rail shipped. Rail figures live on their own screen — they were
  // briefly a second band here and made the dashboard busy.
  /**
   * The dashboard answers for ONE half of the product.
   *
   * Hosted counts Plans, Subscriptions and Payments; the rail counts
   * Mandates and Charges, which are different tables entirely. Showing the
   * hosted figures to someone in rail scope was not merely irrelevant — a
   * rail developer reading "Active subscriptions: 0" would reasonably
   * conclude their integration was not working.
   */
  const kpis: Kpi[] = scope === "rail"
    ? rail
      ? [
          { label: "Collected", value: (rail.totals.collected / 1_000_000).toFixed(2), unit: "USDC" },
          { label: "Active mandates", value: String(rail.totals.activeMandates) },
          { label: "Charges", value: String(rail.charges.length) },
          { label: "Failed charges", value: String(rail.totals.failedCount), accent: rail.totals.failedCount > 0 },
        ]
      : []
    : data
      ? [
          { label: "Active subscriptions", value: String(data.activeSubs) },
          { label: "Subscription revenue", value: (data.totalRevenue / 1_000_000).toFixed(2), unit: "USDC" },
          { label: "Active plans", value: String(data.plans) },
          { label: "Failed payments", value: String(data.failedPayments), accent: data.failedPayments > 0 },
        ]
      : [];

  if (error) {
    return (
      <>
        <PageHeader kicker="Overview" title="Dashboard" />
        <ErrorNote>{error}</ErrorNote>
      </>
    );
  }

  return (
    <>
      <PageHeader kicker="Overview" title="Dashboard" />

      {data && !data.walletAddress && (
        <div style={{ padding: "20px 32px", borderBottom: "1px solid var(--color-divider)" }}>
          <WalletSetupBanner hasCircleWallet={data.walletType === "circle"} />
        </div>
      )}

      <KpiBand items={kpis} loading={scope === "rail" ? rail === null : data === null} />

      {/* Settled chart beside the payout wallet and the next renewal batch. */}
      <div className="grid lg:grid-cols-[1.5fr_1fr]" style={{ borderBottom: "1px solid var(--color-divider)" }}>
        <section style={{ padding: "26px 32px", borderRight: "1px solid var(--color-divider)" }}>
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <h3 className="m-0" style={{ fontSize: 20, letterSpacing: "-0.02em" }}>
              {scope === "rail" ? "Rail charges" : "Settled USDC"} · {range.heading}
            </h3>
            <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>
              {(settled / 1_000_000).toFixed(2)} total
            </span>
            <span className="ml-auto">
              <RangeTabs value={rangeKey} onChange={setRangeKey} />
            </span>
          </div>
          <SettledChart bars={bars} unit={range.unit} />
        </section>

        <section style={{ padding: "26px 32px" }}>
          <h3 className="m-0 mb-3.5" style={{ fontSize: 20, letterSpacing: "-0.02em" }}>Payout wallet</h3>
          <div style={{ borderTop: "1px solid var(--color-divider)", paddingTop: 12 }}>
            {data?.walletAddress ? (
              <>
                <p
                  className="m-0 mb-1 break-all"
                  style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5 }}
                >
                  {data.walletAddress}
                </p>
                <div className="mt-2.5 flex items-center gap-2.5">
                  <span className="tag tag-neutral">
                    {data.walletType === "circle" ? "Circle wallet" : "External wallet"}
                  </span>
                  <span className="tag tag-outline">Verified</span>
                  <span className="ml-auto"><CopyButton text={data.walletAddress} /></span>
                </div>
              </>
            ) : (
              <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
                No payout wallet linked yet.
              </p>
            )}
          </div>

          <div style={{ borderTop: "1px solid var(--color-divider)", marginTop: 18, paddingTop: 14 }}>
            {/*
              Each half's own forward look. Hosted asks "when does the next
              batch run"; the rail asks "how much can I still draw today",
              which is the number a developer sizing a charge needs. A
              renewal batch means nothing on the rail — nothing renews there,
              the developer's backend decides when money moves.
            */}
            {scope === "rail" ? (
              <>
                <Kicker>Pending charges</Kicker>
                {rail ? (
                  <>
                    <p
                      className="m-0"
                      style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 26, letterSpacing: "-0.02em" }}
                    >
                      {rail.totals.pendingCount}
                    </p>
                    <p className="m-0 mt-1.5" style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>
                      {rail.totals.pendingCount === 1 ? "charge is" : "charges are"} still settling · gas covered by Sweep
                    </p>
                  </>
                ) : (
                  <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
                    Loading…
                  </p>
                )}
              </>
            ) : (
              <>
                <Kicker>Next renewal batch</Kicker>
                {batch ? (
                  <>
                    <p
                      className="m-0"
                      style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 26, letterSpacing: "-0.02em" }}
                    >
                      {batch.day.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </p>
                    <p className="m-0 mt-1.5" style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>
                      {batch.count} subscription{batch.count === 1 ? "" : "s"} · gas covered by Sweep
                    </p>
                  </>
                ) : (
                  <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
                    No renewals scheduled.
                  </p>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      {data?.walletAddress && data.walletType === "circle" && (
        <WithdrawSection walletId={data.walletAddress} />
      )}

      {/* Beneath the withdrawal it extends, and gated the same way: the
          quote prices a transfer OUT of the Circle wallet, so a creator on an
          external wallet has nothing here to act on — they move their own
          funds and would use the route directly. */}
      {data?.walletAddress && data.walletType === "circle" && <PayoutRoutesSection />}

      <Section
        title="Recent activity"
        bordered={false}
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12.5 }}
            onClick={() => navigate("/payments")}
          >
            All payments →
          </button>
        }
      >
        {activity.length === 0 ? (
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
            No payments yet — activity appears here once subscribers complete checkout.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Amount</th><th>Type</th><th>Status</th><th>Plan</th><th>Date</th><th>Tx</th></tr>
              </thead>
              <tbody>
                {activity.map((r) => (
                  <tr key={r.key}>
                    {/* A withdrawal is money LEAVING, so it is signed. Without
                        the minus a payout sits in a column of receipts looking
                        like one. */}
                    <td style={{ fontFamily: "var(--font-heading)", fontWeight: 700 }}>
                      {r.outgoing ? "−" : ""}
                      {(r.amount / 1_000_000).toFixed(2)}
                    </td>
                    <td>{r.kind}</td>
                    <td><StatusTag status={r.status} /></td>
                    <td>{r.plan ?? "—"}</td>
                    <td style={{ color: "var(--color-neutral-700)" }}>
                      {new Date(r.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ color: "var(--color-neutral-700)" }}>
                      {r.txHash && r.explorerUrl ? (
                        <a
                          href={r.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "var(--color-accent)" }}
                        >
                          <Mono>{r.txHash.slice(0, 8)}…</Mono>
                        </a>
                      ) : (
                        <Mono>{r.txHash ? `${r.txHash.slice(0, 8)}…` : "—"}</Mono>
                      )}
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

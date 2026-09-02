import { useEffect, useMemo, useState } from "react";
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

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

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
  createdAt: string;
}

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

function buildChart(payments: Payment[], range: ChartRange): Bar[] {
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
    if (p.status !== "succeeded" || p.type === "refund") continue;
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
        style={{ height: 150, gap, borderBottom: "2px solid var(--color-divider)", paddingTop: 14 }}
      >
        {bars.map((b) => (
          <div
            key={b.start.toISOString()}
            title={`${unit === "hour" ? FULL_HOUR.format(b.start) : SHORT_DATE.format(b.start)} · ${(b.total / 1_000_000).toFixed(2)} USDC`}
            style={{
              flex: 1,
              height: b.total > 0 ? `${Math.max((b.total / max) * 100, 4)}%` : 2,
              background: b.total > 0 ? "var(--color-accent)" : "var(--color-neutral-300)",
            }}
          />
        ))}
      </div>
      <div
        className="mt-[7px] flex justify-between"
        style={{ fontSize: 10, color: "var(--color-neutral-600)", fontFamily: "ui-monospace, Menlo, monospace" }}
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
  const [rangeKey, setRangeKey] = useState<RangeKey>("14d");
  const [subs, setSubs] = useState<Subscription[]>([]);
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
  const bars = useMemo(() => buildChart(chartPayments, range), [chartPayments, range]);
  const settled = useMemo(() => bars.reduce((n, b) => n + b.total, 0), [bars]);
  const batch = useMemo(() => nextRenewalBatch(subs), [subs]);

  const kpis: Kpi[] = data
    ? [
        { label: "Active subscriptions", value: String(data.activeSubs) },
        { label: "Total revenue", value: (data.totalRevenue / 1_000_000).toFixed(2), unit: "USDC" },
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
        <div style={{ padding: "20px 32px", borderBottom: "2px solid var(--color-divider)" }}>
          <WalletSetupBanner hasCircleWallet={data.walletType === "circle"} />
        </div>
      )}

      <KpiBand items={kpis} loading={data === null} />

      {/* Settled chart beside the payout wallet and the next renewal batch. */}
      <div className="grid lg:grid-cols-[1.5fr_1fr]" style={{ borderBottom: "2px solid var(--color-divider)" }}>
        <section style={{ padding: "26px 32px", borderRight: "1px solid var(--color-divider)" }}>
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <h3 className="m-0" style={{ fontSize: 20, letterSpacing: "-0.02em" }}>
              Settled USDC · {range.heading}
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
            <Kicker>Next renewal batch</Kicker>
            {batch ? (
              <>
                <p
                  className="m-0"
                  style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 26, letterSpacing: "-0.02em" }}
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
          </div>
        </section>
      </div>

      {data?.walletAddress && data.walletType === "circle" && (
        <WithdrawSection walletId={data.walletAddress} />
      )}

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
        {recent.length === 0 ? (
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
                {recent.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontFamily: "var(--font-heading)", fontWeight: 800 }}>
                      {(p.amount / 1_000_000).toFixed(2)}
                    </td>
                    <td>{p.type}</td>
                    <td><StatusTag status={p.status} /></td>
                    <td>{p.planName ?? "—"}</td>
                    <td style={{ color: "var(--color-neutral-700)" }}>
                      {new Date(p.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ color: "var(--color-neutral-700)" }}>
                      <Mono>{p.txHash ? `${p.txHash.slice(0, 8)}…` : "—"}</Mono>
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

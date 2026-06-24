import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Pricing } from "@/components/landing/Pricing";
import { Logo } from "@/components/ui/Logo";
import { UMAMI_SHARE_URL } from "@/lib/analytics";
import { fetchPlatformStats, type PlatformStats } from "@/lib/gateway";

function LogoMark() {
  return <Logo height={30} />;
}

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-gray-100 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-lg font-bold tracking-tight text-gray-900">Sweep Console</span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-medium text-gray-600 md:flex">
          <a href="#features" className="transition hover:text-gray-900">Features</a>
          <a href="#how" className="transition hover:text-gray-900">How it works</a>
          <a href="#pricing" className="transition hover:text-gray-900">Pricing</a>
          <Link to="/docs" className="transition hover:text-gray-900">Documentation</Link>
          {UMAMI_SHARE_URL && <Link to="/analytics" className="transition hover:text-gray-900">Analytics</Link>}
        </nav>
        <div className="flex items-center gap-3">
          <Link to="/login" className="text-sm font-medium text-gray-600 transition hover:text-gray-900">Login</Link>
          <Link
            to="/signup"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-black"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}

const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const compactUsd = (n: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
    .format(n)
    .replace("K", "k"); // match the "$192k" style

type StatsState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; stats: PlatformStats };

function useLiveStats(): StatsState {
  const [state, setState] = useState<StatsState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    fetchPlatformStats()
      .then((r) => {
        if (!alive) return;
        const s = r.data;
        // Nothing real to show yet — flag empty so we hide the panel instead of
        // displaying $0 / 0 on the marketing hero.
        const empty = s.mrr === 0 && s.activeSubscribers === 0 && s.settledThisMonth === 0;
        setState(empty ? { status: "empty" } : { status: "ready", stats: s });
      })
      // On error, hide too — never leave a stuck skeleton or show fake numbers.
      .catch(() => alive && setState({ status: "empty" }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

function StatTiles({ stats }: { stats: PlatformStats }) {
  const tiles = [
    { label: "MRR", value: usd0(stats.mrr), trend: "Updated live" },
    {
      label: "Active subscribers",
      value: stats.activeSubscribers.toLocaleString("en-US"),
      trend:
        stats.newSubscribersThisMonth > 0
          ? `+${stats.newSubscribersThisMonth} this month`
          : "Updated live",
    },
    {
      label: "Settled this month",
      value: `${compactUsd(stats.settledThisMonth)} USDC`,
      trend: "Arc",
    },
  ];
  return (
    <div className="grid gap-4 p-6 sm:grid-cols-3">
      {tiles.map((s) => (
        <div key={s.label} className="rounded-xl border border-gray-100 bg-white p-4 text-left shadow-sm">
          <p className="text-xs font-medium text-gray-400">{s.label}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{s.value}</p>
          <p className="mt-1 text-xs font-medium text-brand-600">{s.trend}</p>
        </div>
      ))}
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="grid gap-4 p-6 sm:grid-cols-3">
      {["MRR", "Active subscribers", "Settled this month"].map((label) => (
        <div key={label} className="rounded-xl border border-gray-100 bg-white p-4 text-left shadow-sm">
          <p className="text-xs font-medium text-gray-400">{label}</p>
          <div className="mt-2 h-7 w-24 animate-pulse rounded bg-gray-100" />
          <div className="mt-2 h-3 w-16 animate-pulse rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}

// The product-preview card. Renders nothing when the platform has no live
// activity yet (or stats fail to load), so the hero never shows $0 / 0 numbers;
// it reappears automatically once there are real subscriptions.
function HeroPreview() {
  const state = useLiveStats();
  if (state.status === "empty") return null;
  return (
    <div className="relative mx-auto mt-16 max-w-3xl">
      <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-brand-400/30 via-sky-300/20 to-blue-300/30 blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
        <div className="flex items-center gap-1.5 border-b border-gray-100 bg-gray-50 px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-red-300" />
          <span className="h-3 w-3 rounded-full bg-yellow-300" />
          <span className="h-3 w-3 rounded-full bg-gray-300" />
          <span className="ml-3 text-xs text-gray-400">app.sweepconsole.com</span>
        </div>
        {state.status === "ready" ? <StatTiles stats={state.stats} /> : <StatSkeleton />}
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-brand-50 via-white to-white">
      {/* Ambient lighting */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/4 h-96 w-96 rounded-full bg-brand-300/40 blur-3xl" />
        <div className="absolute -top-20 right-1/4 h-80 w-80 rounded-full bg-sky-300/30 blur-3xl" />
        <div className="absolute top-40 left-1/2 h-72 w-[40rem] -translate-x-1/2 rounded-full bg-blue-200/30 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-7xl px-6 pb-24 pt-20 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white/70 px-4 py-1.5 text-sm font-medium text-brand-700 shadow-sm">
          <span className="h-2 w-2 rounded-full bg-brand-500" />
          Stablecoin subscriptions on Arc
        </span>

        <h1 className="mx-auto mt-6 max-w-4xl text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl">
          Recurring payments,{" "}
          <span className="bg-gradient-to-r from-brand-600 to-brand-500 bg-clip-text text-transparent">
            settled in stablecoins
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-gray-500">
          Sweep Console is the payment infrastructure for developers — accept USDC subscriptions,
          bill across chains, and settle on Arc with sub-second finality. No banks, no chargebacks,
          no gas for your customers.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/signup"
            className="w-full rounded-xl bg-gray-900 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-gray-900/10 transition hover:bg-black sm:w-auto"
          >
            Start for free
          </Link>
          <a
            href="#pricing"
            className="w-full rounded-xl border border-gray-200 bg-white px-6 py-3.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 sm:w-auto"
          >
            View pricing
          </a>
        </div>
        <p className="mt-4 text-xs text-gray-400">No credit card required · Test mode included</p>

        {/* Product preview with glow — live data, hidden until there's activity */}
        <HeroPreview />
      </div>
    </section>
  );
}

const features = [
  {
    title: "Pay from any chain",
    body: "Customers pay with USDC on Base, Arbitrum or Optimism — Circle's CCTP bridges it to Arc automatically. You always settle in one place.",
    icon: (
      <path d="M4 7h11l-3-3m3 3l-3 3M20 17H9l3-3m-3 3l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    title: "Gasless renewals",
    body: "One signature authorizes a year of renewals. We submit every charge and cover the gas — your subscribers never sign again.",
    icon: (
      <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    title: "Non-custodial by design",
    body: "Funds move from the customer straight to your wallet on-chain. We never hold balances — escrow only during the refund window.",
    icon: (
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    title: "Tiered plans & trials",
    body: "Ship Starter, Pro and Scale tiers with free trials and coupons. One hosted, shareable checkout link handles the rest.",
    icon: (
      <path d="M4 19V9m6 10V5m6 14v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    title: "Webhooks & API",
    body: "Signed webhooks, API keys and a full test mode. Drop subscriptions into your product the same day you sign up.",
    icon: (
      <path d="M8 9l-4 3 4 3m8-6l4 3-4 3M14 5l-4 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    title: "Settled on Arc",
    body: "USDC-native L1 with sub-second finality. Revenue lands in your wallet in seconds, not days — with on-chain proof for every charge.",
    icon: (
      <path d="M12 2v20m0-20l5 5m-5-5L7 7m5 13l5-5m-5 5l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
];

function Features() {
  return (
    <section id="features" className="mx-auto max-w-7xl px-6 py-24">
      <div className="max-w-2xl">
        <h2 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
          Everything you need to bill in crypto
        </h2>
        <p className="mt-3 text-lg text-gray-500">
          A complete subscription stack — checkout, settlement, renewals and developer tooling — built for stablecoins.
        </p>
      </div>

      <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <div
            key={f.title}
            className="group rounded-2xl border border-gray-200 bg-white p-7 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-lg"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-600 transition group-hover:bg-brand-100">
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none">{f.icon}</svg>
            </div>
            <h3 className="mt-5 text-lg font-semibold text-gray-900">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-500">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const steps = [
  { n: "01", title: "Create a plan", body: "Set your price, interval, trial and tiers. Get a hosted checkout link in seconds." },
  { n: "02", title: "Share your link", body: "Customers connect a wallet and pay with USDC — on Arc or from Base, Arbitrum and Optimism." },
  { n: "03", title: "Get paid on Arc", body: "Funds settle to your wallet instantly. We auto-renew every cycle, gas-free." },
];

function HowItWorks() {
  return (
    <section id="how" className="relative overflow-hidden border-y border-gray-100 bg-gray-50 py-24">
      <div className="pointer-events-none absolute right-0 top-0 h-72 w-72 rounded-full bg-brand-200/40 blur-3xl" />
      <div className="relative mx-auto max-w-7xl px-6">
        <h2 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">Live in three steps</h2>
        <p className="mt-3 text-lg text-gray-500">From sign-up to your first on-chain renewal — no integration required to start.</p>
        <div className="mt-14 grid grid-cols-1 gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n} className="relative">
              <span className="text-5xl font-bold text-brand-500/30">{s.n}</span>
              <h3 className="mt-3 text-xl font-semibold text-gray-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-500">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-24">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 to-brand-700 px-8 py-16 text-center shadow-2xl shadow-brand-500/30">
        <div className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-white/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -right-10 h-80 w-80 rounded-full bg-blue-300/30 blur-3xl" />
        <div className="relative">
          <h2 className="mx-auto max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Start accepting stablecoin subscriptions today
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-brand-50/90">
            Free to start, with test mode built in. Be charging in USDC before your coffee gets cold.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/signup" className="w-full rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 sm:w-auto">
              Create your account
            </Link>
            <Link to="/login" className="w-full rounded-xl border border-white/40 px-6 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10 sm:w-auto">
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-gray-100 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <Link to="/" className="flex items-center gap-2.5">
            <LogoMark />
            <span className="text-base font-bold tracking-tight text-gray-900">Sweep Console</span>
          </Link>
          <nav className="flex flex-wrap gap-x-8 gap-y-3 text-sm font-medium text-gray-500">
            <a href="#features" className="transition hover:text-gray-900">Features</a>
            <a href="#how" className="transition hover:text-gray-900">How it works</a>
            <a href="#pricing" className="transition hover:text-gray-900">Pricing</a>
            <Link to="/docs" className="transition hover:text-gray-900">Documentation</Link>
            {UMAMI_SHARE_URL && <Link to="/analytics" className="transition hover:text-gray-900">Analytics</Link>}
            <Link to="/login" className="transition hover:text-gray-900">Login</Link>
            <Link to="/signup" className="transition hover:text-gray-900">Get started</Link>
          </nav>
        </div>
        <div className="mt-8 border-t border-gray-100 pt-6 text-xs text-gray-400">
          A payment infrastructure for developers · Powered by stablecoins · © {new Date().getFullYear()} Sweep Console
        </div>
      </div>
    </footer>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <Nav />
      <Hero />
      <Features />
      <HowItWorks />
      <Pricing />
      <CtaBand />
      <Footer />
    </div>
  );
}

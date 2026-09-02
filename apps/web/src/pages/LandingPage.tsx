import { Link } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { Logo } from "@/components/ui/Logo";
import { ArcMark, ArbitrumMark, BaseMark, OptimismMark } from "@/components/landing/ChainMarks";

/**
 * The landing page, in the Modernist system: ruled editorial hero, features as
 * ruled rows, a surface-filled three-step band, pricing as equal columns, and an
 * accent poster close. Nothing is rounded and nothing floats.
 */

const FEATURES = [
  {
    n: "01",
    title: "Pay from any chain",
    body: "Subscribers pay USDC on Base, Arbitrum or Optimism — Sweep Console settles to Arc automatically. You always settle in one place.",
  },
  {
    n: "02",
    title: "Gasless renewals",
    body: "One signature from an external wallet authorizes a year of renewals. We submit every charge and cover the gas — your subscribers never sign again.",
  },
  {
    n: "03",
    title: "Non-custodial by design",
    body: "Funds move from the customer straight to your wallet on-chain. We never hold balances — escrow only during the refund window.",
  },
  {
    n: "04",
    title: "Tiered plans & trials",
    body: "Ship Starter, Pro and Scale tiers with free trials. One hosted, shareable checkout link handles the rest.",
  },
  {
    n: "05",
    title: "Webhooks & API",
    body: "Signed webhooks, scoped API keys and a full test mode. Drop subscriptions into your product the same day you sign up.",
  },
  {
    n: "06",
    title: "Settled on Arc",
    body: "USDC-native L1 with sub-second finality. Revenue lands in your wallet in seconds, with on-chain proof for every charge.",
  },
];

const STEPS = [
  { n: "01", title: "Create a plan", body: "Set price, interval, trial and tiers. You get a hosted checkout link in seconds." },
  { n: "02", title: "Share your link", body: "Customers connect an external wallet and pay in USDC from Arc, Base, Arbitrum or Optimism." },
  { n: "03", title: "Get paid on Arc", body: "Funds settle to your wallet instantly. We auto-renew every cycle, gas-free." },
];

/**
 * Pricing reflects the fee the contract actually enforces: PLATFORM_FEE_BPS is
 * 200, i.e. a flat 2% of every settled charge, with a hard 10% ceiling in
 * SubscriptionManager. Do not quote a rate here that the contract does not
 * charge — this page is a commitment to customers.
 */
const PRICING = [
  {
    name: "Test",
    price: "Free",
    unit: "",
    blurb: "Full API and dashboard in test mode. No wallet required.",
    filled: false,
    badge: false,
    cta: "Start in test mode",
    to: "/signup",
    feats: ["Unlimited test plans", "All webhook events", "Hosted checkout preview"],
  },
  {
    name: "Standard",
    price: "2%",
    unit: " per renewal",
    blurb: "Pay only when a charge settles. Gas is on us.",
    filled: true,
    badge: true,
    cta: "Choose Standard",
    to: "/signup",
    feats: [
      "Unlimited plans & tiers",
      "Gas covered on every renewal",
      "Signed webhooks & API keys",
      "Email receipts",
    ],
  },
  {
    name: "Scale",
    price: "Custom",
    unit: "",
    blurb: "For high settled volume. Talk to us about your numbers.",
    filled: false,
    badge: false,
    cta: "Talk to us",
    to: "/signup",
    feats: ["Volume pricing", "Dedicated settlement lane", "Custom refund windows", "Account manager"],
  },
];

const RULE = "2px solid var(--color-divider)";
const HAIRLINE = "1px solid var(--color-divider)";

function Kicker({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <p
      className="m-0 uppercase"
      style={{
        fontSize: 10,
        letterSpacing: "0.14em",
        color: accent ? "var(--color-accent)" : "var(--color-neutral-600)",
      }}
    >
      {children}
    </p>
  );
}

function Header() {
  // The landing page is public but is also where a signed-in merchant often
  // lands (a bookmark, the logo link out of the console). Offering "Log in" to
  // someone who is already logged in is noise, and "Get started" sends them to a
  // signup they can't use — /signup bounces authenticated users straight back to
  // the dashboard.
  const { user, loading } = useAuth();
  return (
    <header
      className="sticky top-0 flex flex-wrap items-center gap-9"
      style={{ padding: "18px 40px", borderBottom: RULE, background: "var(--color-bg)", zIndex: 40 }}
    >
      <Link to="/" className="mr-auto flex items-center gap-2.5" style={{ color: "var(--color-text)" }}>
        <Logo height={24} />
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 17, letterSpacing: "-0.02em" }}>
          Sweep Console
        </span>
      </Link>

      <nav className="flex gap-6" style={{ fontSize: 13, letterSpacing: "0.01em" }}>
        <a href="#features" style={{ color: "var(--color-text)" }}>Features</a>
        <a href="#how" style={{ color: "var(--color-text)" }}>How it works</a>
        <a href="#pricing" style={{ color: "var(--color-text)" }}>Pricing</a>
        <Link to="/docs" style={{ color: "var(--color-text)" }}>Documentation</Link>
      </nav>

      <div className="flex items-center gap-3.5">
        {/* Nothing until the session resolves: /auth/me settles quickly, and a
            flash of "Log in" to someone already signed in is the exact thing
            this is here to stop. */}
        {loading ? null : user ? (
          <Link to="/dashboard" className="btn btn-primary" style={{ fontSize: 13 }}>
            Enter Console
          </Link>
        ) : (
          <>
            <Link to="/login" className="btn btn-ghost" style={{ color: "var(--color-text)", fontSize: 13 }}>
              Log in
            </Link>
            <Link to="/signup" className="btn btn-primary" style={{ fontSize: 13 }}>
              Get started
            </Link>
          </>
        )}
      </div>
    </header>
  );
}

/** Hero A — the ruled editorial treatment. */
function Hero() {
  const { user, loading } = useAuth();
  const authSteps = [
    {
      n: "01 · Authorize",
      title: "One signature, a year of renewals",
      body: "Your customer signs once from their own wallet. No re-approval at each cycle, no seed phrase, no custodial account to open.",
    },
    {
      n: "02 · Charge",
      title: "We submit it and pay the gas",
      body: "Every renewal is submitted on schedule and retried on failure. Gas is on us, so a charge never fails for an empty gas balance.",
    },
    {
      n: "03 · Settle",
      title: "Straight to your wallet",
      body: "USDC lands at your address the moment a charge clears. Sweep Console never holds your balance, so there is nothing to withdraw.",
    },
  ];

  return (
    <section style={{ padding: "0 40px" }}>
      <div className="flex items-baseline gap-3" style={{ padding: "22px 0", borderBottom: HAIRLINE }}>
        <span style={{ width: 8, height: 8, background: "var(--color-accent)", display: "block" }} />
        <span
          className="uppercase"
          style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--color-neutral-700)" }}
        >
          Stablecoin subscriptions · settled on Arc
        </span>
      </div>

      <div className="grid lg:grid-cols-[1.35fr_1fr]" style={{ borderBottom: RULE }}>
        <div className="lg:border-r" style={{ padding: "56px 48px 56px 0", borderColor: "var(--color-divider)" }}>
          <h1
            className="m-0"
            style={{ fontSize: "clamp(46px, 6.5vw, 88px)", lineHeight: 0.94, letterSpacing: "-0.035em", marginBottom: 28 }}
          >
            Recurring<br />payments,<br />
            <span style={{ color: "var(--color-accent)" }}>settled in<br />stablecoins.</span>
          </h1>
          <p
            className="m-0"
            style={{
              fontSize: 17, lineHeight: 1.5, maxWidth: "47ch",
              color: "var(--color-neutral-800)", marginBottom: 28, textWrap: "pretty",
            }}
          >
            Sweep Console is payment infrastructure for recurring on-chain billing. One signature from
            your customer&apos;s external wallet authorizes a year of renewals — we submit every charge
            and cover the gas.
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            {/* An existing merchant has already started; send them to the work
                instead of to a signup that would bounce them back. Rendered as
                soon as the session resolves — see Header. */}
            {!loading && (
              <Link
                to={user ? "/dashboard" : "/signup"}
                className="btn btn-primary"
                style={{ padding: "12px 20px", fontSize: 14 }}
              >
                {user ? "Enter Console" : "Start for free"}
              </Link>
            )}
            <Link to="/docs" className="btn btn-secondary" style={{ padding: "12px 20px", fontSize: 14 }}>
              See the docs
            </Link>
            <span style={{ fontSize: 11, color: "var(--color-neutral-600)", marginLeft: 8 }}>
              No card · test mode included
            </span>
          </div>
        </div>

        <div>
          <div style={{ padding: "0 0 14px 32px" }}>
            <Kicker accent>What one authorization covers</Kicker>
          </div>
          {authSteps.map((s, i) => (
            <div
              key={s.n}
              style={{
                padding: "20px 0 20px 32px",
                borderBottom: i < authSteps.length - 1 ? HAIRLINE : undefined,
              }}
            >
              <Kicker>{s.n}</Kicker>
              <p
                className="m-0"
                style={{
                  fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 26,
                  lineHeight: 1.08, letterSpacing: "-0.02em", margin: "8px 0 6px",
                }}
              >
                {s.title}
              </p>
              <p
                className="m-0"
                style={{ fontSize: 13, lineHeight: 1.55, color: "var(--color-neutral-800)", maxWidth: "34ch" }}
              >
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The chain rail — where you can pay from, and where it settles. */
function ChainRail() {
  const sources = [
    { label: "Arc", Mark: ArcMark },
    { label: "Base", Mark: BaseMark },
    { label: "Arbitrum", Mark: ArbitrumMark },
    { label: "Optimism", Mark: OptimismMark },
  ];
  return (
    <section
      className="flex flex-wrap items-center gap-7"
      style={{ padding: "18px 40px", borderBottom: RULE }}
    >
      <Kicker>Pay from</Kicker>
      {sources.map(({ label, Mark }) => (
        <span key={label} className="flex items-center gap-2.5" style={{ fontSize: 13.5 }}>
          <Mark height={19} />
          {label}
        </span>
      ))}
      <span className="ml-auto"><Kicker>Settle on</Kicker></span>
      <span
        className="flex items-center gap-2.5"
        style={{ fontSize: 13.5, fontFamily: "var(--font-heading)", fontWeight: 800 }}
      >
        <ArcMark height={20} accent />
        Arc · USDC
      </span>
    </section>
  );
}

function Features() {
  return (
    <section id="features" style={{ padding: "64px 40px 0", scrollMarginTop: 80 }}>
      <div className="grid gap-0 lg:grid-cols-[1fr_2fr]" style={{ paddingBottom: 36 }}>
        <h2 className="m-0" style={{ fontSize: "clamp(30px, 4vw, 44px)", lineHeight: 1, letterSpacing: "-0.03em" }}>
          Everything you need to bill on-chain
        </h2>
        <p
          className="m-0 lg:pl-8"
          style={{ fontSize: 16, color: "var(--color-neutral-800)", maxWidth: "52ch" }}
        >
          Checkout, settlement, renewals and developer tooling. Non-custodial end to end — funds move
          from your customer&apos;s wallet to yours.
        </p>
      </div>

      {FEATURES.map((f) => (
        <div
          key={f.n}
          className="grid items-start gap-0 lg:grid-cols-[56px_1fr_2fr]"
          style={{ borderTop: HAIRLINE, padding: "26px 0" }}
        >
          <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, color: "var(--color-accent)" }}>
            {f.n}
          </span>
          <h3 className="m-0" style={{ fontSize: 24, letterSpacing: "-0.02em", paddingRight: 24 }}>
            {f.title}
          </h3>
          <p
            className="m-0"
            style={{ fontSize: 14, lineHeight: 1.6, color: "var(--color-neutral-800)", maxWidth: "64ch" }}
          >
            {f.body}
          </p>
        </div>
      ))}
    </section>
  );
}

function HowItWorks() {
  return (
    <section
      id="how"
      style={{
        marginTop: 64, borderTop: RULE, borderBottom: RULE,
        background: "var(--color-surface)", scrollMarginTop: 80,
      }}
    >
      <div style={{ padding: "44px 40px 0" }}>
        <h2 className="m-0" style={{ fontSize: "clamp(30px, 4vw, 44px)", letterSpacing: "-0.03em", marginBottom: 6 }}>
          Live in three steps
        </h2>
        <p className="m-0" style={{ fontSize: 15, color: "var(--color-neutral-800)", marginBottom: 36 }}>
          From sign-up to your first on-chain renewal.
        </p>
      </div>
      <div className="grid md:grid-cols-3" style={{ borderTop: HAIRLINE }}>
        {STEPS.map((s) => (
          <div key={s.n} style={{ padding: "32px 32px 44px", borderLeft: HAIRLINE }}>
            <span
              className="block"
              style={{
                fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 56,
                lineHeight: 1, color: "var(--color-accent)", marginBottom: 16,
              }}
            >
              {s.n}
            </span>
            <h3 className="m-0" style={{ fontSize: 22, letterSpacing: "-0.02em", marginBottom: 8 }}>{s.title}</h3>
            <p className="m-0" style={{ fontSize: 14, lineHeight: 1.6, color: "var(--color-neutral-800)" }}>
              {s.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function PricingSection() {
  return (
    <section id="pricing" style={{ padding: "64px 40px 0", scrollMarginTop: 80 }}>
      <h2 className="m-0" style={{ fontSize: "clamp(30px, 4vw, 44px)", letterSpacing: "-0.03em", marginBottom: 6 }}>
        Pricing
      </h2>
      <p className="m-0" style={{ fontSize: 15, color: "var(--color-neutral-800)", marginBottom: 32 }}>
        No monthly platform fee. You pay per settled renewal.
      </p>
      <div className="grid md:grid-cols-3" style={{ borderTop: RULE, borderBottom: RULE }}>
        {PRICING.map((p) => (
          <div
            key={p.name}
            className="flex flex-col gap-3.5"
            style={{
              padding: 32,
              borderLeft: HAIRLINE,
              background: p.filled ? "var(--color-surface)" : "transparent",
            }}
          >
            <div className="flex items-center gap-2.5" style={{ minHeight: 22 }}>
              <span className="uppercase" style={{ fontSize: 11, letterSpacing: "0.14em" }}>{p.name}</span>
              {p.badge && <span className="tag tag-outline">Recommended</span>}
            </div>
            <p
              className="m-0"
              style={{
                fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 52,
                lineHeight: 1, letterSpacing: "-0.035em",
              }}
            >
              {p.price}
              {p.unit && (
                <span style={{ fontSize: 15, fontWeight: 400, color: "var(--color-neutral-700)" }}>{p.unit}</span>
              )}
            </p>
            <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-800)", minHeight: 38 }}>
              {p.blurb}
            </p>
            <div
              className="flex flex-col gap-[7px]"
              style={{ borderTop: HAIRLINE, paddingTop: 16, marginTop: 4 }}
            >
              {p.feats.map((ft) => (
                <span key={ft} className="flex gap-2.5" style={{ fontSize: 13, lineHeight: 1.4 }}>
                  <span style={{ color: "var(--color-accent)", fontFamily: "var(--font-heading)", fontWeight: 800 }}>
                    —
                  </span>
                  {ft}
                </span>
              ))}
            </div>
            <Link
              to={p.to}
              className="btn btn-primary btn-block"
              style={{ marginTop: "auto", padding: "11px 14px" }}
            >
              {p.cta}
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}

function DocsTeaser() {
  return (
    <section id="docs" style={{ padding: "64px 40px 0", scrollMarginTop: 80 }}>
      <div className="grid gap-0 lg:grid-cols-[1fr_1.15fr]" style={{ borderTop: RULE }}>
        <div style={{ padding: "36px 40px 40px 0" }}>
          <h2 className="m-0" style={{ fontSize: "clamp(28px, 3.4vw, 38px)", letterSpacing: "-0.03em", marginBottom: 12 }}>
            Two calls to production
          </h2>
          <p
            className="m-0"
            style={{ fontSize: 15, lineHeight: 1.6, color: "var(--color-neutral-800)", marginBottom: 20, maxWidth: "44ch" }}
          >
            Create a plan, open a checkout session, listen for{" "}
            <code
              style={{
                fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13,
                background: "var(--color-surface)", padding: "1px 5px",
              }}
            >
              subscription.created
            </code>
            . Signed webhooks and a full test mode are on from day one.
          </p>
          <Link to="/docs" className="btn btn-secondary" style={{ padding: "11px 18px" }}>
            Read the docs
          </Link>
        </div>
        <pre
          className="m-0 overflow-x-auto"
          style={{
            background: "var(--color-neutral-900)", color: "#e8e4e4",
            padding: "28px 32px", fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12.5, lineHeight: 1.85,
          }}
        >
<span style={{ color: "var(--color-neutral-500)" }}>{"// 1 — open a checkout session"}</span>{"\n"}
<span style={{ color: "var(--color-accent-400)" }}>POST</span>{" /v1/checkout/sessions\n"}
{"  plan_id: "}<span style={{ color: "#9fd8a0" }}>{'"plan_7QK2x"'}</span>{"\n"}
{"  success_url: "}<span style={{ color: "#9fd8a0" }}>{'"https://acme.dev/ok"'}</span>{"\n\n"}
<span style={{ color: "var(--color-neutral-500)" }}>{"// 2 — verify the webhook"}</span>{"\n"}
<span style={{ color: "var(--color-accent-400)" }}>const</span>{" sig = req.headers["}<span style={{ color: "#9fd8a0" }}>{"'x-sweep-signature'"}</span>{"]\n"}
<span style={{ color: "var(--color-accent-400)" }}>if</span>{" (verify(sig, body, secret)) upgrade(user)"}
        </pre>
      </div>
    </section>
  );
}

function PosterClose() {
  const { user, loading } = useAuth();
  return (
    <section style={{ marginTop: 64, background: "var(--color-accent)", color: "var(--color-bg)", padding: "64px 40px" }}>
      <h2
        className="m-0"
        style={{
          fontSize: "clamp(38px, 6vw, 74px)", lineHeight: 0.94,
          letterSpacing: "-0.04em", marginBottom: 24, maxWidth: "24ch",
        }}
      >
        Start charging in USDC today.
      </h2>
      {/* Both slots are kept so the poster keeps its two-button rhythm; signed in,
          the second one has nowhere left to go (it pointed at /login, which is
          just the console behind a redirect), so it becomes the docs. */}
      <div className="flex flex-wrap items-center gap-3">
        {!loading && (
          <>
            <Link
              to={user ? "/dashboard" : "/signup"}
              className="btn"
              style={{ background: "var(--color-bg)", color: "var(--color-accent)", padding: "14px 22px", fontSize: 14 }}
            >
              {user ? "Enter Console" : "Create your account"}
            </Link>
            <Link
              to={user ? "/docs" : "/login"}
              className="btn"
              style={{ border: "1px solid rgba(243,242,242,.5)", color: "var(--color-bg)", padding: "14px 22px", fontSize: 14 }}
            >
              {user ? "See the docs" : "Open the console"}
            </Link>
          </>
        )}
      </div>
    </section>
  );
}

export function LandingPage() {
  return (
    <div style={{ background: "var(--color-bg)", color: "var(--color-text)", minHeight: "100vh" }}>
      <Header />
      <Hero />
      <ChainRail />
      <Features />
      <HowItWorks />
      <PricingSection />
      <DocsTeaser />
      <PosterClose />

      <footer
        className="flex flex-wrap items-center gap-6"
        style={{ padding: "28px 40px", fontSize: 12, color: "var(--color-neutral-700)" }}
      >
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, color: "var(--color-text)" }}>
          Sweep Console
        </span>
        <Link to="/docs" style={{ color: "var(--color-neutral-700)" }}>Documentation</Link>
        <Link to="/manage" style={{ color: "var(--color-neutral-700)" }}>Manage subscription</Link>
        <span className="ml-auto">
          Payment infrastructure for on-chain recurring revenue · © {new Date().getFullYear()}
        </span>
      </footer>
    </div>
  );
}

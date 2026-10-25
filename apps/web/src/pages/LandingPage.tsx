/**
 * The landing page, rebuilt to the v2 design.
 *
 * The previous page was the Modernist one: flush-left blocks separated by 2px
 * rules, nothing rounded, nothing floating. Retinting it moved the colours and
 * left that skeleton, which is not what the design is — v2 organises with
 * surfaces, cards and alternating grounds, and its sections are a different
 * set: hero, how, a chain demo, features, a console preview, developers, and
 * a closing call on a field of accent.
 *
 * PRICING IS KEPT, though the design's section list omits it. Dropping a
 * pricing section because a mockup did not draw one would be following the
 * picture over the business, and the header already links to it.
 *
 * THE WEBHOOK NAMES ARE THE REAL ONES. The design shows
 * `checkout.session.completed` and `grant.revoked`; neither is sent. The
 * events below are the names apps/api actually emits — a landing page
 * advertising an event a developer then cannot subscribe to costs more trust
 * than it buys.
 */

import type { FC, ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { Logo } from "@/components/ui/Logo";
import { DOCS_URL } from "@/lib/docs";
import { feePercent } from "@/lib/fee";
import {
  ArcMark,
  BaseMark,
  ArbitrumMark,
  OptimismMark,
  type MarkProps,
} from "@/components/landing/ChainMarks";

const STEPS = [
  {
    n: "01",
    title: "Choose a plan",
    body: "Tiers, trials and a recommended pick, on a hosted checkout or a shareable payment link.",
  },
  {
    n: "02",
    title: "Pay from any chain",
    body: "Subscribers verify their email, connect a wallet and pick Base, Arbitrum or Optimism. One signature, no gas.",
  },
  {
    n: "03",
    title: "Settled on Arc",
    body: "USDC is swept over CCTP straight to your payout wallet. Renewals repeat it automatically.",
  },
];

const FEATURES = [
  {
    n: "01",
    title: "Gasless by default",
    body: "We submit every transaction and cover network and bridge costs. Subscribers pay the exact plan amount.",
  },
  {
    n: "02",
    title: "Renewals with a fallback",
    body: "Authorize every chain once. If Base runs dry, the renewal charges whichever chain holds a full period.",
  },
  {
    n: "03",
    title: "Email-anchored customers",
    body: "A 6-digit code verifies each subscriber. Returning customers are recognised with the wallet they paid with.",
  },
  {
    n: "04",
    title: "Plans, tiers and trials",
    body: "Daily to yearly intervals, free trials, feature lists and a recommended tier — previewed as subscribers see it.",
  },
  {
    n: "05",
    title: "A portal subscribers can use",
    body: "Customers sign in with email to see what they pay for, which wallet backs it, and revoke grants themselves.",
  },
  {
    n: "06",
    title: "Webhooks, keys, test mode",
    body: "Signed webhooks, scoped API keys and a full test environment where no real USDC moves.",
  },
];

const CHAINS: Array<{ key: string; name: string; Mark: FC<MarkProps>; note: string }> = [
  { key: "base", name: "Base", Mark: BaseMark, note: "Lowest fees" },
  { key: "arbitrum", name: "Arbitrum", Mark: ArbitrumMark, note: "Deep USDC liquidity" },
  { key: "optimism", name: "Optimism", Mark: OptimismMark, note: "Fast finality" },
];

/** The names apps/api actually sends. Checked, not copied from the mockup. */
const EVENTS = [
  { name: "subscription.created", desc: "First payment settled" },
  { name: "subscription.renewed", desc: "Renewal charged" },
  { name: "subscription.past_due", desc: "No chain had funds" },
  { name: "mandate.revoked", desc: "Subscriber revoked access" },
];

const CODE = `const session = await sweep.checkout.sessions.create({
  plan: "plan_pro",
  externalRef: user.id,
  successUrl: "https://app.example.com/welcome",
});

res.redirect(session.url);`;

const PRICING = [
  {
    name: "Test",
    price: "Free",
    unit: "",
    blurb: "Full API and dashboard in test mode. No wallet required.",
    featured: false,
    cta: "Start in test mode",
    feats: ["Unlimited test plans", "All webhook events", "Hosted checkout preview"],
  },
  {
    name: "Standard",
    price: feePercent(),
    unit: " per renewal",
    blurb: "Pay only when a charge settles. Gas is on us.",
    featured: true,
    cta: "Choose Standard",
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
    featured: false,
    cta: "Talk to us",
    feats: ["Volume pricing", "Dedicated settlement lane", "Account manager"],
  },
];

/* ── small parts ──────────────────────────────────────────────────────── */

function Kicker({ children }: { children: ReactNode }) {
  return (
    <p
      className="m-0"
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--color-accent)",
      }}
    >
      {children}
    </p>
  );
}

/**
 * A band of the page.
 *
 * `ground` alternates the surface. That alternation is how v2 separates
 * sections — the previous design did it with 2px rules, and keeping those
 * under rounded cards is what made the retint look like neither system.
 */
function Section({ id, ground, children }: { id?: string; ground?: boolean; children: ReactNode }) {
  return (
    <section
      id={id}
      style={{
        background: ground ? "var(--color-neutral-200)" : "var(--color-bg)",
        padding: "88px 0",
      }}
    >
      <div className="mx-auto w-full max-w-6xl px-5">{children}</div>
    </section>
  );
}

function H2({ children }: { children: ReactNode }) {
  return (
    <h2 style={{ fontSize: "clamp(28px,4vw,38px)", letterSpacing: "-0.025em", margin: "12px 0 0" }}>
      {children}
    </h2>
  );
}

function Card({ children, ground }: { children: ReactNode; ground?: boolean }) {
  return (
    <article
      style={{
        background: ground ? "var(--color-neutral-100)" : "var(--color-bg)",
        border: "1px solid var(--color-divider)",
        borderRadius: "var(--radius-lg)",
        padding: 24,
      }}
    >
      {children}
    </article>
  );
}

/* ── header ───────────────────────────────────────────────────────────── */

function Header() {
  const { user, loading } = useAuth();
  return (
    <header
      className="sticky top-0"
      style={{
        zIndex: 40,
        background: "var(--color-header-bg)",
        backdropFilter: "saturate(180%) blur(12px)",
        WebkitBackdropFilter: "saturate(180%) blur(12px)",
        borderBottom: "1px solid var(--color-divider)",
      }}
    >
      <div className="mx-auto flex w-full max-w-6xl items-center px-5" style={{ gap: 14, height: 62 }}>
        <Link to="/" className="mr-auto flex items-center gap-2.5" style={{ color: "var(--color-text)" }}>
          <Logo height={22} />
          <span
            style={{
              fontFamily: "var(--font-heading)",
              fontWeight: 800,
              fontSize: 15,
              letterSpacing: "-0.02em",
            }}
          >
            Sweep Console
          </span>
        </Link>

        <nav className="hidden items-center md:flex" style={{ gap: 22, fontSize: 13.5 }}>
          <a href="#how" style={{ color: "var(--color-neutral-800)" }}>How it works</a>
          <a href="#features" style={{ color: "var(--color-neutral-800)" }}>Features</a>
          {/* Before Documentation on purpose: the hosted-or-rail choice comes
              first, and someone reading the docs without having made it is
              reading the wrong half. */}
          <Link to="/integration" style={{ color: "var(--color-neutral-800)" }}>Integration</Link>
          <a href="#pricing" style={{ color: "var(--color-neutral-800)" }}>Pricing</a>
          <a href={DOCS_URL} style={{ color: "var(--color-neutral-800)" }}>Docs</a>
        </nav>

        {/* Nothing until the session resolves: /auth/me settles quickly, and a
            flash of "Log in" to someone already signed in is the exact thing
            this is here to stop. */}
        <div className="flex items-center" style={{ gap: 10, marginLeft: 22 }}>
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
      </div>
    </header>
  );
}

/* ── hero ─────────────────────────────────────────────────────────────── */

function Hero() {
  const { user, loading } = useAuth();
  return (
    <section id="top" style={{ background: "var(--color-bg)", padding: "92px 0 78px" }}>
      <div
        className="mx-auto grid w-full max-w-6xl items-center px-5"
        style={{ gap: 56, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,380px),1fr))" }}
      >
        <div>
          <h1 style={{ fontSize: "clamp(38px,5.4vw,56px)", lineHeight: 1.05, letterSpacing: "-0.035em", margin: 0 }}>
            Recurring revenue in{" "}
            {/* The mark turns over beside the word rather than sitting as a
                static logo — the design's one piece of ornament, and the only
                place usdc-flip is used. */}
            <span className="inline-flex items-center" style={{ gap: 10, whiteSpace: "nowrap" }}>
              <span className="usdc-flip inline-flex" aria-hidden="true">
                <ArcMark height={42} />
              </span>
              USDC.
            </span>
          </h1>
          <p className="mt-5" style={{ fontSize: 17, lineHeight: 1.6, color: "var(--color-neutral-800)", maxWidth: 520 }}>
            Subscribers pay from Base, Arbitrum or Optimism with one signature. Every charge
            settles to you on Arc — and renewals run themselves.
          </p>
          <div className="mt-7 flex flex-wrap" style={{ gap: 12 }}>
            {loading ? null : (
              <Link to={user ? "/plans/new" : "/signup"} className="btn btn-primary" style={{ padding: "13px 22px", fontSize: 14.5 }}>
                Create your first plan
              </Link>
            )}
            <Link to="/integration" className="btn btn-secondary" style={{ padding: "13px 22px", fontSize: 14.5 }}>
              Try the checkout
            </Link>
          </div>
        </div>

        <RailViz />
      </div>
    </section>
  );
}

/**
 * The payment, drawn: three source chains converging on Arc.
 *
 * It is the one picture on the page and it carries the product's least
 * obvious idea — that the chain the subscriber pays from and the chain the
 * creator is paid on are not the same one.
 */
function RailViz() {
  return (
    <div
      style={{
        background: "var(--color-neutral-100)",
        border: "1px solid var(--color-divider)",
        borderRadius: "var(--radius-lg)",
        padding: 26,
        boxShadow: "var(--shadow-md)",
      }}
    >
      <p
        className="m-0"
        style={{
          fontSize: 11.5, fontWeight: 600, letterSpacing: "0.1em",
          textTransform: "uppercase", color: "var(--color-neutral-700)",
        }}
      >
        One signature
      </p>
      <div className="mt-4" style={{ display: "grid", gap: 10 }}>
        {CHAINS.map(({ key, name, Mark, note }) => (
          <div
            key={key}
            className="flex items-center"
            style={{
              gap: 12, padding: "12px 14px", background: "var(--color-bg)",
              border: "1px solid var(--color-divider)", borderRadius: "var(--radius-md)",
            }}
          >
            <Mark height={20} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>{name}</span>
            <span className="ml-auto" style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>{note}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 mb-0 text-center" style={{ fontSize: 20, color: "var(--color-neutral-600)", lineHeight: 1 }} aria-hidden="true">
        ↓
      </p>
      <div
        className="mt-3 flex items-center"
        style={{
          gap: 12, padding: "14px 16px", background: "var(--color-accent-200)",
          border: "1px solid var(--color-accent-300)", borderRadius: "var(--radius-md)",
        }}
      >
        <ArcMark height={22} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>Settled on Arc</span>
        <span className="ml-auto" style={{ fontSize: 12, color: "var(--color-accent)" }}>Your payout wallet</span>
      </div>
    </div>
  );
}

/* ── sections ─────────────────────────────────────────────────────────── */

function HowItWorks() {
  return (
    <Section id="how" ground>
      <Kicker>How it works</Kicker>
      <H2>Three steps. Zero gas for your subscribers.</H2>
      <div className="mt-10 grid" style={{ gap: 18, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))" }}>
        {STEPS.map((s) => (
          <Card key={s.n}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-accent)" }}>{s.n}</span>
            <h3 style={{ fontSize: 18, margin: "10px 0 0", letterSpacing: "-0.015em" }}>{s.title}</h3>
            <p className="mt-2 mb-0" style={{ fontSize: 14, lineHeight: 1.6, color: "var(--color-neutral-800)" }}>{s.body}</p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function Demo() {
  const [picked, setPicked] = useState("base");
  return (
    <Section id="demo">
      <Kicker>Hosted checkout</Kicker>
      <H2>Pick a chain. That&rsquo;s the payment.</H2>
      <div
        className="mt-10 grid"
        style={{ gap: 40, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))", alignItems: "center" }}
      >
        <div
          style={{
            background: "var(--color-bg)", border: "1px solid var(--color-divider)",
            borderRadius: "var(--radius-lg)", padding: 24,
            boxShadow: "var(--shadow-md)", maxWidth: 420,
          }}
        >
          <p className="m-0" style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>Pro plan</p>
          <p className="m-0 mt-1" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em" }}>
            25.00{" "}
            <span style={{ fontSize: 14, fontWeight: 500, color: "var(--color-neutral-700)" }}>USDC / month</span>
          </p>
          <p
            className="mt-5 mb-2"
            style={{
              fontSize: 11.5, fontWeight: 600, letterSpacing: "0.08em",
              textTransform: "uppercase", color: "var(--color-neutral-800)",
            }}
          >
            Pay from
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            {CHAINS.map(({ key, name, Mark }) => {
              const on = picked === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPicked(key)}
                  aria-pressed={on}
                  className="flex cursor-pointer items-center"
                  style={{
                    gap: 11, padding: "12px 14px", font: "inherit", textAlign: "left",
                    borderRadius: "var(--radius-md)",
                    border: `1px solid ${on ? "var(--color-accent)" : "var(--color-divider)"}`,
                    background: on ? "var(--color-accent-200)" : "var(--color-bg)",
                    transition: "background var(--dur) ease, border-color var(--dur) ease",
                  }}
                >
                  <Mark height={19} />
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{name}</span>
                  {on && <span className="ml-auto" style={{ fontSize: 12, color: "var(--color-accent)" }}>Selected</span>}
                </button>
              );
            })}
          </div>
          <div
            className="mt-5"
            style={{
              padding: "13px 16px", textAlign: "center", borderRadius: "var(--radius-sm)",
              background: "var(--color-accent)", color: "#fff", fontWeight: 600, fontSize: 14.5,
            }}
          >
            Subscribe — 25.00 USDC
          </div>
        </div>

        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 14 }}>
          {[
            "Network and bridge fees covered by Sweep Console",
            "Each charge goes straight to the creator",
            "Cancel anytime by revoking from the wallet",
          ].map((t) => (
            <li key={t} className="flex" style={{ gap: 11, fontSize: 15, color: "var(--color-neutral-900)" }}>
              <span style={{ color: "var(--color-accent)", fontWeight: 700 }} aria-hidden="true">✓</span>
              {t}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function Features() {
  return (
    <Section id="features" ground>
      <Kicker>Features</Kicker>
      <H2>Everything a subscription business needs, on-chain.</H2>
      <div className="mt-10 grid" style={{ gap: 18, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,290px),1fr))" }}>
        {FEATURES.map((f) => (
          <Card key={f.n}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-accent)" }}>{f.n}</span>
            <h3 style={{ fontSize: 17, margin: "10px 0 0", letterSpacing: "-0.015em" }}>{f.title}</h3>
            <p className="mt-2 mb-0" style={{ fontSize: 14, lineHeight: 1.6, color: "var(--color-neutral-800)" }}>{f.body}</p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function ConsolePreview() {
  return (
    <Section id="console">
      <Kicker>The console</Kicker>
      <H2>Run it all from one place.</H2>
      <p className="mt-4" style={{ fontSize: 16, color: "var(--color-neutral-800)", maxWidth: 620 }}>
        Plans and tiers, subscribers, payments, withdrawals, webhooks and API keys — test mode
        included.
      </p>
      <div
        className="mt-9"
        style={{
          border: "1px solid var(--color-divider)", borderRadius: "var(--radius-lg)",
          overflow: "hidden", boxShadow: "var(--shadow-lg)", background: "var(--color-bg)",
        }}
      >
        <div
          className="flex items-center"
          style={{
            gap: 9, padding: "10px 14px", borderBottom: "1px solid var(--color-divider)",
            background: "var(--color-neutral-100)",
          }}
        >
          <span style={{ display: "flex", gap: 6 }} aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--color-neutral-400)" }} />
            ))}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--color-neutral-700)" }}>
            console.sweep / dashboard
          </span>
        </div>
        {/* The shell's own shape, drawn rather than screenshotted: a rail and
            a content area. A screenshot is stale the first time the console
            changes, and this is the page people see first. */}
        <div style={{ display: "flex", minHeight: 260 }}>
          <div
            className="hidden sm:block"
            style={{
              width: 150, flex: "none", background: "var(--color-neutral-100)",
              borderRight: "1px solid var(--color-divider)", padding: 14,
            }}
          >
            {["Dashboard", "Plans", "Subscriptions", "Payments", "Webhooks"].map((l, i) => (
              <div
                key={l}
                style={{
                  fontSize: 12.5, padding: "7px 9px", borderRadius: 7, marginBottom: 2,
                  background: i === 0 ? "var(--color-accent-200)" : "transparent",
                  color: i === 0 ? "var(--color-accent)" : "var(--color-neutral-800)",
                  fontWeight: i === 0 ? 600 : 500,
                }}
              >
                {l}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, padding: 22, display: "grid", gap: 12, alignContent: "start" }}>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,130px),1fr))" }}>
              {[
                ["Collected", "12,480.00"],
                ["Active", "318"],
                ["Renewing", "47"],
              ].map(([k, v]) => (
                <div key={k} style={{ border: "1px solid var(--color-divider)", borderRadius: "var(--radius-md)", padding: 14 }}>
                  <p className="m-0" style={{ fontSize: 11, color: "var(--color-neutral-700)" }}>{k}</p>
                  <p className="m-0 mt-1" style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em" }}>{v}</p>
                </div>
              ))}
            </div>
            {/* Rows loading, not fake data: inventing subscriber names and
                amounts on a marketing page is a claim, and these are not
                anyone's numbers. */}
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{ position: "relative", overflow: "hidden", height: 13, borderRadius: 6, background: "var(--color-neutral-200)" }}
                aria-hidden="true"
              >
                <span
                  className="swp-sweep"
                  style={{
                    position: "absolute", inset: 0,
                    background: "linear-gradient(90deg,transparent,var(--color-neutral-100),transparent)",
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

function Developers() {
  return (
    <Section id="developers" ground>
      <Kicker>For developers</Kicker>
      <H2>A checkout in one request.</H2>
      <p className="mt-4" style={{ fontSize: 16, color: "var(--color-neutral-800)", maxWidth: 640 }}>
        Create a session, redirect, and listen for webhooks. Or skip code entirely with a shareable
        payment link.
      </p>
      <div className="mt-9 grid" style={{ gap: 18, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))" }}>
        <pre
          style={{
            margin: 0, padding: "20px 22px", overflowX: "auto",
            background: "var(--color-bg)", border: "1px solid var(--color-divider)",
            borderRadius: "var(--radius-lg)", fontFamily: "var(--font-mono)",
            fontSize: 12.5, lineHeight: 1.75, color: "var(--color-neutral-900)",
          }}
        >
          <code>{CODE}</code>
        </pre>
        <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
          {EVENTS.map((e) => (
            <div
              key={e.name}
              className="flex items-baseline"
              style={{
                gap: 12, padding: "13px 15px", background: "var(--color-bg)",
                border: "1px solid var(--color-divider)", borderRadius: "var(--radius-md)",
              }}
            >
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--color-accent)" }}>{e.name}</code>
              <span className="ml-auto" style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>{e.desc}</span>
            </div>
          ))}
          <Link to="/integration" style={{ fontSize: 14, fontWeight: 600, color: "var(--color-accent)", marginTop: 4 }}>
            Hosted or rail? Compare them →
          </Link>
        </div>
      </div>
    </Section>
  );
}

function Pricing() {
  return (
    <Section id="pricing">
      <Kicker>Pricing</Kicker>
      <H2>Pay when you get paid.</H2>
      <div
        className="mt-10 grid"
        style={{ gap: 18, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,270px),1fr))", alignItems: "start" }}
      >
        {PRICING.map((p) => (
          <article
            key={p.name}
            style={{
              background: p.featured ? "var(--color-text)" : "var(--color-bg)",
              color: p.featured ? "#fff" : "inherit",
              border: `1px solid ${p.featured ? "var(--color-text)" : "var(--color-divider)"}`,
              borderRadius: "var(--radius-lg)",
              padding: 26,
              boxShadow: p.featured ? "var(--shadow-lg)" : "none",
            }}
          >
            <div className="flex items-center" style={{ gap: 8 }}>
              <h3 style={{ fontSize: 16, margin: 0 }}>{p.name}</h3>
              {p.featured && (
                <span
                  style={{
                    fontSize: 10.5, fontWeight: 600, padding: "3px 8px", borderRadius: 999,
                    background: "var(--color-accent)", color: "#fff",
                  }}
                >
                  Recommended
                </span>
              )}
            </div>
            <p className="m-0 mt-4" style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.03em" }}>
              {p.price}
              <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.7 }}>{p.unit}</span>
            </p>
            <p
              className="mt-2"
              style={{
                fontSize: 13.5, lineHeight: 1.6,
                color: p.featured ? "rgba(255,255,255,0.82)" : "var(--color-neutral-800)",
              }}
            >
              {p.blurb}
            </p>
            <ul style={{ listStyle: "none", margin: "18px 0 0", padding: 0, display: "grid", gap: 8 }}>
              {p.feats.map((f) => (
                <li
                  key={f}
                  className="flex"
                  style={{ gap: 9, fontSize: 13.5, color: p.featured ? "rgba(255,255,255,0.9)" : "inherit" }}
                >
                  <span style={{ color: p.featured ? "var(--color-accent-400)" : "var(--color-accent)" }} aria-hidden="true">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <Link
              to="/signup"
              className="mt-6 block"
              style={{
                textAlign: "center", padding: "11px 18px", borderRadius: "var(--radius-sm)",
                fontWeight: 600, fontSize: 14, textDecoration: "none",
                background: p.featured ? "#fff" : "var(--color-accent)",
                color: p.featured ? "var(--color-text)" : "#fff",
              }}
            >
              {p.cta}
            </Link>
          </article>
        ))}
      </div>
    </Section>
  );
}

/**
 * The closing call, on a field of accent.
 *
 * The one place the colour runs as a ground rather than an highlight — the
 * design's single poster moment, and the reason the accent is used sparingly
 * everywhere above it.
 */
function StartCta() {
  return (
    <section id="start" style={{ background: "var(--color-accent)", padding: "84px 0", color: "#fff" }}>
      <div className="mx-auto w-full max-w-6xl px-5 text-center">
        <h2 style={{ fontSize: "clamp(28px,4.4vw,42px)", letterSpacing: "-0.03em", margin: 0, color: "#fff" }}>
          Start getting paid in USDC today.
        </h2>
        <p style={{ fontSize: 16.5, color: "rgba(255,255,255,0.88)", margin: "16px auto 0", maxWidth: 560 }}>
          Set up a plan in minutes. Try everything in test mode — no real USDC is charged.
        </p>
        <div className="mt-8 flex flex-wrap justify-center" style={{ gap: 12 }}>
          <Link
            to="/signup"
            style={{
              padding: "13px 24px", borderRadius: "var(--radius-sm)", fontWeight: 600,
              fontSize: 14.5, background: "#fff", color: "var(--color-accent)", textDecoration: "none",
            }}
          >
            Create an account
          </Link>
          <a
            href={DOCS_URL}
            style={{
              padding: "13px 24px", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: 14.5,
              background: "transparent", color: "#fff",
              border: "1px solid rgba(255,255,255,0.5)", textDecoration: "none",
            }}
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{ background: "var(--color-bg)", borderTop: "1px solid var(--color-divider)", padding: "32px 0" }}>
      <div
        className="mx-auto flex w-full max-w-6xl flex-wrap items-center px-5"
        style={{ gap: 16, fontSize: 13, color: "var(--color-neutral-700)" }}
      >
        <span className="flex items-center" style={{ gap: 8, color: "var(--color-text)", fontWeight: 600 }}>
          <Logo height={17} />
          Sweep Console
        </span>
        <span className="flex flex-wrap" style={{ gap: 18, marginLeft: "auto" }}>
          <Link to="/integration" style={{ color: "var(--color-neutral-700)" }}>Integration</Link>
          <a href={DOCS_URL} style={{ color: "var(--color-neutral-700)" }}>Documentation</a>
          <Link to="/manage" style={{ color: "var(--color-neutral-700)" }}>Manage subscription</Link>
        </span>
        <span style={{ width: "100%", fontSize: 12 }}>
          Payment infrastructure for on-chain recurring revenue · © {new Date().getFullYear()}
        </span>
      </div>
    </footer>
  );
}

export function LandingPage() {
  return (
    <div style={{ background: "var(--color-bg)", color: "var(--color-text)" }}>
      <Header />
      <main className="swp-in">
        <Hero />
        <HowItWorks />
        <Demo />
        <Features />
        <ConsolePreview />
        <Developers />
        <Pricing />
        <StartCta />
      </main>
      <Footer />
    </div>
  );
}

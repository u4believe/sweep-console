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
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { DOCS_URL } from "@/lib/docs";
import { feePercent } from "@/lib/fee";
import { ChainMark, SweepMark, UsdcMark, METAMASK_LOGO, CIRCLE_LOGO, type ChainKey } from "@/components/ui/marks";

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

const CHAINS: Array<{ key: ChainKey; name: string; note: string }> = [
  { key: "base", name: "Base", note: "Lowest fees" },
  { key: "arbitrum", name: "Arbitrum", note: "Deep USDC liquidity" },
  { key: "optimism", name: "Optimism", note: "Fast finality" },
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

function Kicker({ children, align = "center" }: { children: ReactNode; align?: "center" | "left" }) {
  return (
    <p
      className="m-0"
      style={{
        textAlign: align,
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
 * The page is WHITE. Only `demo` and `developers` sit on the surface tint —
 * the two sections built around a card, where the tint is what lifts the
 * card off the page. I had this inverted: `how` and `features` tinted and
 * those two white, which greyed most of the page and flattened the two
 * places that needed depth.
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

/**
 * Section headings are CENTRED, which the previous version of this file got
 * wrong by inheriting Modernist's "keep everything flush left" rule. The
 * design centres how-it-works, features and the closing call, and keeps the
 * demo and developer sections left-aligned beside their card.
 */
function H2({ children, align = "center" }: { children: ReactNode; align?: "center" | "left" }) {
  return (
    <h2
      style={{
        // The design's own size. Mine was clamp(28,4.2vw,40) — small enough
        // that a section heading read as a card title.
        fontSize: "clamp(32px,4vw,50px)",
        letterSpacing: "-0.035em",
        lineHeight: 1.06,
        margin: "12px 0 0",
        textAlign: align,
      }}
    >
      {children}
    </h2>
  );
}

function Card({ children, ground, reveal }: { children: ReactNode; ground?: boolean; reveal?: boolean }) {
  return (
    <article
      data-reveal={reveal ? "" : undefined}
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
        // 14px with no saturate — the design's value. The saturate was mine.
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--color-divider)",
      }}
    >
      <div className="mx-auto flex w-full max-w-6xl items-center px-5" style={{ gap: 14, height: 62 }}>
        <Link to="/" className="mr-auto flex items-center gap-2.5" style={{ color: "var(--color-text)" }}>
          <SweepMark size={22} />
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
    <section id="top" style={{ background: "var(--color-bg)", padding: "clamp(28px,5vw,56px) 0 clamp(36px,6vw,72px)" }}>
      <div
        className="mx-auto grid w-full max-w-6xl items-center px-5"
        style={{
          gap: "clamp(36px,5vw,72px)",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,440px),1fr))",
        }}
      >
        <div>
          {/*
            The design's h1, to the value. Six things here were guesses before:
            weight 700 not 800, line-height 1.08 not 0.98, tracking -0.035em
            not -0.045em, and the coin sized in `em` so it scales with the
            heading rather than sitting at a fixed 54px that is right at one
            breakpoint only.

            The full stop is OUTSIDE the nowrap span and inherits the ink. It
            belongs to the sentence, so it must not join the accent — and it
            must not be pulled back with a negative margin either, which left
            a gap at some sizes and overlapped at others.
          */}
          <h1
            style={{
              margin: 0,
              fontWeight: 700,
              fontSize: "clamp(46px,6.6vw,86px)",
              lineHeight: 1.08,
              letterSpacing: "-0.035em",
            }}
          >
            Recurring revenue in{" "}
            <span style={{ whiteSpace: "nowrap" }}>
              <span
                className="usdc-flip"
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: "0.73em",
                  height: "0.73em",
                  marginRight: "0.14em",
                  perspective: 600,
                  verticalAlign: "baseline",
                }}
              >
                <UsdcMark />
              </span>
              <span style={{ color: "var(--color-accent)" }}>USDC</span>
            </span>
            .
          </h1>
          <p style={{ margin: "26px 0 0", fontSize: "clamp(16px,1.4vw,18px)", lineHeight: 1.6, color: "var(--color-neutral-800)", maxWidth: 540 }}>
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
 * The rail, animated — a carriage running a beaded track, stations lighting
 * as it passes.
 *
 * This is the design's hero and it is in motion, which two earlier versions
 * of this file missed: the first drew three chain rows with an arrow, the
 * second a static ring. Neither says the thing the movement says — that the
 * loop runs on its own, which is the whole product.
 *
 * Built from the design's own buildRail(): viewBox 560x420, centre 280/210,
 * r 150, one lap every 8s. The track is a thick dashed stroke rather than
 * drawn beads, the comet is three arcs of decreasing length and increasing
 * opacity, and each station's pulse `begin` is its angle as a fraction of
 * the lap — so a station lights exactly as the carriage reaches it rather
 * than on a timer that drifts out of step with it.
 *
 * SMIL rather than CSS keyframes because the pulses must be offset per
 * station and stay locked to one clock; `begin` does that in one attribute,
 * where CSS would need four animations with negative delays kept in sync by
 * hand. Supported everywhere this app runs.
 */
const LAP = 8; // seconds, the design's D
const RAIL_CX = 280;
const RAIL_CY = 210;
const RAIL_R = 150;
const RAIL_C = 2 * Math.PI * RAIL_R;

const STATIONS = [
  { a: 0, n: "01", t: "Charge", s: "on schedule", lx: RAIL_CX + RAIL_R + 26, ly: RAIL_CY, anchor: "start" },
  { a: 90, n: "02", t: "Settle", s: "in seconds", lx: RAIL_CX, ly: RAIL_CY + RAIL_R + 34, anchor: "middle" },
  { a: 180, n: "03", t: "Receipt", s: "sent automatically", lx: RAIL_CX - RAIL_R - 26, ly: RAIL_CY, anchor: "end" },
  { a: 270, n: "04", t: "Next period", s: "no new signature", lx: RAIL_CX, ly: RAIL_CY - RAIL_R - 40, anchor: "middle" },
] as const;

const at = (a: number): [number, number] => [
  RAIL_CX + RAIL_R * Math.cos((a * Math.PI) / 180),
  RAIL_CY + RAIL_R * Math.sin((a * Math.PI) / 180),
];

/**
 * Whether the viewer asked for less movement.
 *
 * CSS cannot switch SMIL off — `prefers-reduced-motion` reaches a keyframes
 * animation and not an <animate> element — so this is read in JS and the
 * animation elements are simply not rendered. The rail still draws, with the
 * carriage parked at 01 and the stations in their resting state, which is a
 * legible diagram rather than an empty box.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(q.matches);
    const on = () => setReduced(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduced;
}

/**
 * The scroll reveal: content arrives from 14px below as it enters view.
 *
 * Twenty elements in the design carry `data-reveal`, and the observer has one
 * detail worth copying exactly — anything ALREADY above the fold is skipped
 * rather than hidden and revealed. Without that, a visitor's first paint is a
 * blank hero that fades in, and on a slow connection it can read as a page
 * that failed.
 *
 * Driven by attribute rather than by wrapping each element in a component: a
 * wrapper around a grid child becomes the grid child, which would change
 * every layout it touched. The styles are set imperatively because the
 * observer owns them and unobserves once done.
 */
function useScrollReveal(disabled: boolean) {
  useEffect(() => {
    if (disabled) return;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (nodes.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.style.opacity = "1";
          el.style.transform = "none";
          io.unobserve(el);
        }
      },
      { threshold: 0.12 }
    );

    nodes.forEach((el, i) => {
      // Already visible: leave it alone.
      if (el.getBoundingClientRect().top < window.innerHeight) return;
      el.style.opacity = "0";
      el.style.transform = "translateY(14px)";
      el.style.transition =
        "opacity 600ms cubic-bezier(.23,1,.32,1), transform 600ms cubic-bezier(.23,1,.32,1)";
      // Three per row in most of these grids, so the stagger reads across a
      // row and resets rather than cascading down the whole page.
      el.style.transitionDelay = `${(i % 3) * 60}ms`;
      io.observe(el);
    });

    return () => io.disconnect();
  }, [disabled]);
}

/**
 * One full turn about the ring's centre, used by the carriage and the dust.
 *
 * `onRepeat` is how the cycle counter stays in step with the carriage. SMIL
 * fires `repeatEvent` at the end of each repetition — which for the carriage
 * is the moment it comes back round to where it started, 01 Charge.
 */
function Spin({ dur, onRepeat }: { dur: string; onRepeat?: () => void }) {
  const ref = useRef<SVGAnimateTransformElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onRepeat) return;
    el.addEventListener("repeatEvent", onRepeat);
    return () => el.removeEventListener("repeatEvent", onRepeat);
  }, [onRepeat]);
  return (
    <animateTransform
      ref={ref}
      attributeName="transform"
      type="rotate"
      from={`0 ${RAIL_CX} ${RAIL_CY}`}
      to={`360 ${RAIL_CX} ${RAIL_CY}`}
      dur={dur}
      repeatCount="indefinite"
    />
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function RailViz() {
  const still = usePrefersReducedMotion();

  /**
   * The cycle advances once per lap, ON THE ANIMATION'S OWN CLOCK.
   *
   * The design uses setInterval(8000), matching the lap duration, and so did
   * this. That is not the same clock: SMIL starts timing when the SVG is
   * parsed, the interval when React's effect runs, and the gap between them
   * is however long hydration took. It is invisible on a fast load and
   * obvious on a slow one — the count ticking somewhere past 01 Charge
   * rather than on it, by a different amount on each deployment.
   *
   * `repeatEvent` fires when the carriage's rotation completes a turn, which
   * is exactly when it returns to where it began. No drift, because there is
   * only one clock.
   *
   * Frozen under reduced motion: a number changing beside a parked carriage
   * is stranger than one that does not.
   */
  const [tick, setTick] = useState(0);
  const onLap = useCallback(() => setTick((t) => t + 1), []);

  // Starts at 10 and at October 2026, as the design does, so the first thing
  // a visitor sees is a subscription already well into its life.
  const cycle = String(10 + tick).padStart(2, "0");
  const month = MONTHS[(9 + tick) % 12];
  const year = 2026 + Math.floor((9 + tick) / 12);
  const pulse = (a: number) => ({
    dur: `${LAP}s`,
    begin: `${((a / 360) * LAP).toFixed(2)}s`,
    repeatCount: "indefinite" as const,
    keyTimes: "0;0.04;0.3;1",
  });

  return (
    <div
      style={{
        position: "relative",
        height: "clamp(440px,46vw,540px)",
        borderRadius: 20,
        background: "var(--color-neutral-200)",
        overflow: "hidden",
      }}
    >
      {/* The dotted field behind it, masked to an ellipse so it fades out
          rather than ending at an edge. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(var(--color-neutral-500) 1.2px, transparent 1.4px)",
          backgroundSize: "10px 10px",
          maskImage: "radial-gradient(ellipse 75% 70% at 55% 50%, #000 25%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse 75% 70% at 55% 50%, #000 25%, transparent 80%)",
        }}
      />

      <div style={{ position: "absolute", inset: 12 }}>
        <svg
          viewBox="0 0 560 420"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          style={{ display: "block", overflow: "visible" }}
          aria-hidden="true"
        >
          <defs>
            <filter id="sc-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation={5} />
            </filter>
          </defs>

          {/* The track: beads, then a rail either side of them. */}
          <circle cx={RAIL_CX} cy={RAIL_CY} r={RAIL_R} fill="none" stroke="#E4E4EF" strokeWidth={18} strokeDasharray="2.5 9" />
          <circle cx={RAIL_CX} cy={RAIL_CY} r={RAIL_R + 9} fill="none" stroke="#D6D7EC" strokeWidth={2} />
          <circle cx={RAIL_CX} cy={RAIL_CY} r={RAIL_R - 9} fill="none" stroke="#D6D7EC" strokeWidth={2} />
          {/* Dust inside, turning far slower — it gives the whole thing a
              sense of depth without competing with the carriage. */}
          <circle cx={RAIL_CX} cy={RAIL_CY} r={RAIL_R - 46} fill="none" stroke="#E4E4EF" strokeWidth={1.5} strokeDasharray="1 7">
            {!still && <Spin dur="60s" />}
          </circle>

          {/* The carriage and its tail, one group turning once a lap. */}
          <g>
            {!still && <Spin dur={`${LAP}s`} onRepeat={onLap} />}
            <circle cx={RAIL_CX} cy={RAIL_CY} r={RAIL_R} fill="none" stroke="var(--color-accent)" strokeWidth={10}
                    strokeLinecap="round" strokeDasharray={`170 ${RAIL_C - 170}`} strokeDashoffset={170} opacity={0.1} />
            <circle cx={RAIL_CX} cy={RAIL_CY} r={RAIL_R} fill="none" stroke="var(--color-accent)" strokeWidth={6}
                    strokeLinecap="round" strokeDasharray={`90 ${RAIL_C - 90}`} strokeDashoffset={90} opacity={0.28} />
            <circle cx={RAIL_CX} cy={RAIL_CY} r={RAIL_R} fill="none" stroke="var(--color-accent)" strokeWidth={4}
                    strokeLinecap="round" strokeDasharray={`36 ${RAIL_C - 36}`} strokeDashoffset={36} opacity={0.6} />
            <rect x={RAIL_CX + RAIL_R - 9} y={RAIL_CY - 22} width={18} height={30} rx={9}
                  fill="var(--color-accent)" filter="url(#sc-glow)" opacity={0.6} />
            <rect x={RAIL_CX + RAIL_R - 8} y={RAIL_CY - 20} width={16} height={28} rx={8} fill="var(--color-accent)" />
            <rect x={RAIL_CX + RAIL_R - 3} y={RAIL_CY - 2} width={6} height={6} rx={3} fill="#fff" />
          </g>

          {STATIONS.map((st) => {
            const [x, y] = at(st.a);
            const p = pulse(st.a);
            return (
              <g key={st.n}>
                {!still && (
                  <circle cx={x} cy={y} r={13} fill="var(--color-accent)" opacity={0}>
                    <animate attributeName="r" values="13;13;30;30" {...p} />
                    <animate attributeName="opacity" values="0;0.35;0;0" {...p} />
                  </circle>
                )}
                <circle cx={x} cy={y} r={12} fill="#fff" stroke="#C9CAF6" strokeWidth={2}>
                  {!still && <animate attributeName="fill" values="#fff;#4447D6;#fff;#fff" {...p} />}
                  {!still && <animate attributeName="stroke" values="#C9CAF6;#4447D6;#C9CAF6;#C9CAF6" {...p} />}
                </circle>
                <text x={st.lx} y={st.ly - 4} textAnchor={st.anchor}
                      fontFamily="Plus Jakarta Sans, sans-serif" fontSize={14} fontWeight={700} fill="#23233B">
                  <tspan fill="#4447D6" fontFamily="JetBrains Mono, monospace" fontSize={11} fontWeight={500}>
                    {st.n}{" "}
                  </tspan>
                  {st.t}
                  {!still && <animate attributeName="fill" values="#23233B;#4447D6;#23233B;#23233B" {...p} />}
                </text>
                <text x={st.lx} y={st.ly + 13} textAnchor={st.anchor}
                      fontFamily="Plus Jakarta Sans, sans-serif" fontSize={12} fill="#8A8BA0">
                  {st.s}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* The centre, in page type rather than SVG text. */}
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center", textAlign: "center", pointerEvents: "none" }}>
        <p className="m-0" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.14em",
                                    textTransform: "uppercase", color: "var(--color-neutral-700)", marginBottom: 6 }}>
          Signed once
        </p>
        <p className="m-0" style={{ fontSize: "clamp(30px,3.4vw,42px)", fontWeight: 800,
                                    letterSpacing: "-0.035em", fontVariantNumeric: "tabular-nums" }}>
          Cycle {cycle}
        </p>
        <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-800)", marginTop: 6 }}>
          Renewed {month} 1, {year}
        </p>
      </div>
    </div>
  );
}

/* ── sections ─────────────────────────────────────────────────────────── */

/**
 * The two strips under the hero, both in the design and both missing until
 * now: which chains a subscriber can pay from, and what the rail is built on.
 *
 * They use the package's own artwork rather than drawn approximations — on a
 * row whose whole job is recognition, a near-miss of Base's mark is worse
 * than no mark.
 */
function Marks() {
  return (
    <section
      className="mx-auto flex w-full flex-col"
      style={{ maxWidth: 1100, gap: 22, padding: "clamp(16px,3vw,32px) clamp(18px,4vw,40px) clamp(28px,5vw,56px)" }}
    >
      <div
        className="flex flex-wrap items-center justify-center"
        style={{ gap: "16px clamp(24px,4vw,48px)", fontWeight: 700, fontSize: "clamp(15px,1.5vw,18px)", letterSpacing: "-0.01em" }}
      >
        <span
          style={{
            fontSize: 12, fontWeight: 700, letterSpacing: "0.12em",
            textTransform: "uppercase", color: "var(--color-neutral-700)",
          }}
        >
          Pay from
        </span>
        {CHAINS.map(({ key, name }) => (
          <span key={key} className="flex items-center" style={{ gap: 9 }}>
            <ChainMark chain={key} size={24} />
            {name}
          </span>
        ))}
        <span className="flex items-center" style={{ gap: 9 }}>
          <ChainMark chain="arc" size={24} />
          Arc
        </span>
        <span className="flex items-center" style={{ gap: 9 }}>
          <UsdcMark size={24} />
          USDC
        </span>
      </div>

      <div
        className="flex flex-wrap items-center justify-center"
        style={{ gap: "14px clamp(22px,4vw,40px)" }}
      >
        <span
          style={{
            fontSize: 12, fontWeight: 700, letterSpacing: "0.12em",
            textTransform: "uppercase", color: "var(--color-neutral-700)",
          }}
        >
          Built with
        </span>
        <img src={METAMASK_LOGO} alt="MetaMask" style={{ height: 26, width: "auto" }} />
        <img src={CIRCLE_LOGO} alt="Circle" style={{ height: 28, width: "auto" }} />
      </div>
    </section>
  );
}

/**
 * The statement: what this is, in one sentence, with the load-bearing
 * phrases in accent.
 *
 * It sits on a dotted grid that fades at the edges — the design's only
 * texture, and the reason the rest of the page can be plain. Decorative, so
 * it is a background on an aria-hidden layer rather than content.
 */
function Statement() {
  return (
    <section style={{ background: "var(--color-bg)", padding: "clamp(40px,7vw,86px) 0", position: "relative" }}>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(var(--color-neutral-500) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
          // Fades to nothing at the edges so the grid reads as texture under
          // the words rather than a panel with a hard border.
          maskImage: "radial-gradient(ellipse 60% 70% at 50% 50%, #000 35%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse 60% 70% at 50% 50%, #000 35%, transparent 75%)",
          opacity: 0.55,
        }}
      />
      <p
        className="mx-auto"
        style={{
          position: "relative",
          maxWidth: 860,
          margin: "0 auto",
          padding: "0 clamp(18px,4vw,40px)",
          textAlign: "center",
          fontSize: "clamp(24px,3vw,38px)",
          fontWeight: 500,
          lineHeight: 1.34,
          letterSpacing: "-0.02em",
        }}
      >
        Sweep Console brings <span style={{ color: "var(--color-accent)" }}>stablecoin payments</span> to
        every subscription business, collecting from{" "}
        <span style={{ color: "var(--color-accent)" }}>three major chains</span> and settling in one place.
      </p>
    </section>
  );
}

function HowItWorks() {
  return (
    <Section id="how">
      <Kicker>How it works</Kicker>
      <H2>Three steps. Zero gas for your subscribers.</H2>
      <div className="mt-10 grid" style={{ gap: 18, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))" }}>
        {STEPS.map((s) => (
          <Card key={s.n} reveal>
            <span
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--color-accent)",
                background: "var(--color-accent-200)", borderRadius: 6, padding: "4px 7px",
              }}
            >
              {s.n}
            </span>
            <h3 style={{ fontSize: 18, margin: "10px 0 0", letterSpacing: "-0.015em" }}>{s.title}</h3>
            <p className="mt-2 mb-0" style={{ fontSize: 14.5, lineHeight: 1.62, color: "var(--color-neutral-900)" }}>{s.body}</p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function Demo() {
  const [picked, setPicked] = useState("base");
  return (
    <Section id="demo" ground>
      <Kicker align="left">Hosted checkout</Kicker>
      <H2 align="left">Pick a chain. That&rsquo;s the payment.</H2>
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
            {CHAINS.map(({ key, name }) => {
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
                  <ChainMark chain={key} size={22} />
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
    <Section id="features">
      {/* Left, not centred. The design centres `how`, `console`, the
          statement and the close; features sits left above a grid of six,
          where a centred heading over left-aligned cards reads as a mistake.
          I had this and `console` the wrong way round. */}
      <Kicker align="left">Features</Kicker>
      <H2 align="left">Everything a subscription business needs, on-chain.</H2>
      <div className="mt-10 grid" style={{ gap: 18, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,290px),1fr))" }}>
        {FEATURES.map((f) => (
          <Card key={f.n} reveal>
            <span
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--color-accent)",
                background: "var(--color-accent-200)", borderRadius: 6, padding: "4px 7px",
              }}
            >
              {f.n}
            </span>
            <h3 style={{ fontSize: 17, margin: "10px 0 0", letterSpacing: "-0.015em" }}>{f.title}</h3>
            <p className="mt-2 mb-0" style={{ fontSize: 14.5, lineHeight: 1.62, color: "var(--color-neutral-900)" }}>{f.body}</p>
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
      {/* Centred with its heading — the wrapper is centred in the design, so
          a left-aligned lede under a centred h2 would be the odd one out. */}
      <p
        className="mt-4"
        style={{
          fontSize: "clamp(15px,1.3vw,16.5px)", lineHeight: 1.6,
          color: "var(--color-neutral-900)", maxWidth: 620,
          margin: "16px auto 0", textAlign: "center",
        }}
      >
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
      <Kicker align="left">For developers</Kicker>
      <H2 align="left">A checkout in one request.</H2>
      <p className="mt-4" style={{ fontSize: "clamp(15px,1.3vw,16.5px)", lineHeight: 1.6, color: "var(--color-neutral-900)", maxWidth: 640 }}>
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
 * The closing call: white, centred, under the mark.
 *
 * I had this as a solid field of accent, reasoning that a design using its
 * colour sparingly earns one poster moment. That is true of the system this
 * replaced and not of this one — the design ends on white, and the accent
 * appears only in the word USDC and the button. A full-bleed indigo band
 * here would be the loudest thing on a page that deliberately never raises
 * its voice.
 */
function StartCta() {
  return (
    <section id="start" style={{ background: "var(--color-bg)", padding: "clamp(56px,8vw,96px) 0" }}>
      <div className="mx-auto w-full max-w-6xl px-5" style={{ textAlign: "center" }}>
        <span className="inline-flex" style={{ marginBottom: 22 }}>
          <SweepMark size={46} />
        </span>
        <h2 style={{ fontSize: "clamp(38px,5.6vw,72px)", letterSpacing: "-0.04em", lineHeight: 1.02, margin: 0, fontWeight: 800 }}>
          Start getting paid in <span style={{ color: "var(--color-accent)" }}>USDC</span> today.
        </h2>
        <p
          style={{
            fontSize: "clamp(15px,1.3vw,16.5px)",
            color: "var(--color-neutral-900)",
            margin: "14px auto 0",
            maxWidth: 520,
            lineHeight: 1.6,
          }}
        >
          Set up a plan in minutes. Try everything in test mode — no real USDC is charged.
        </p>
        <div className="mt-8 flex flex-wrap justify-center" style={{ gap: 12 }}>
          <Link to="/signup" className="btn btn-primary" style={{ padding: "13px 22px", fontSize: 14.5 }}>
            Create an account
          </Link>
          <a href={DOCS_URL} className="btn btn-secondary" style={{ padding: "13px 22px", fontSize: 14.5 }}>
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{ background: "var(--color-bg)", borderTop: "1px solid var(--color-divider)", padding: "26px 0" }}>
      <div
        className="mx-auto flex w-full max-w-6xl flex-wrap items-center px-5"
        style={{ gap: "10px 26px", fontSize: 13.5, color: "var(--color-neutral-800)" }}
      >
        <span className="flex items-center" style={{ gap: 9, color: "var(--color-text)", fontWeight: 700 }}>
          <SweepMark size={20} />
          Sweep Console
        </span>
        <a href={DOCS_URL} style={{ color: "var(--color-neutral-800)" }}>Docs</a>
        <Link to="/integration" style={{ color: "var(--color-neutral-800)" }}>Rail checkout</Link>
        <Link to="/login" style={{ color: "var(--color-neutral-800)" }}>Log in</Link>
        <span style={{ marginLeft: "auto", color: "var(--color-neutral-700)" }}>
          © {new Date().getFullYear()} Sweep Console
        </span>
      </div>
    </footer>
  );
}

export function LandingPage() {
  useScrollReveal(usePrefersReducedMotion());
  return (
    <div style={{ background: "var(--color-bg)", color: "var(--color-text)" }}>
      <Header />
      <main className="swp-in">
        <Hero />
        <Marks />
        <Statement />
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

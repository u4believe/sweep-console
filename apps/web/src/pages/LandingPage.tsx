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

import type { CSSProperties, FC, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { DOCS_URL } from "@/lib/docs";
import { feeOn, feePercent, keepsOf } from "@/lib/fee";
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
function Section({
  id,
  ground,
  background,
  dark,
  children,
}: {
  id?: string;
  ground?: boolean;
  /** An explicit ground, for a band the two-tone default cannot express. */
  background?: string;
  /**
   * A dark band. Applies .on-dark, which redefines the colour tokens so the
   * section's existing markup inverts instead of being rewritten — see the
   * block in sweep.css for what cannot survive the flip.
   */
  dark?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={dark ? "on-dark" : undefined}
      style={{
        background: background ?? (ground ? "var(--color-neutral-200)" : "var(--color-bg)"),
        padding: "88px 0",
      }}
    >
      {/* PAGE_W — see its definition. */}
      <div className="mx-auto w-full" style={{ maxWidth: PAGE_W, paddingInline: "clamp(18px,4vw,40px)" }}>{children}</div>
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
  /**
   * Transparent over the hero, navy once you leave it.
   *
   * The page ground is #121A5C now, so the old light bar with a divider
   * underneath sat on the navy hero as a white slab. v4 floats the nav instead
   * and only gives it a ground once there is content behind it to separate
   * from — rgba(18,26,92,0.85) over the blur, with a white hairline rather
   * than a dark one, because a #ECECF3 line on navy is a bright line.
   */
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <header
      className="on-dark sticky top-0"
      style={{
        zIndex: 40,
        background: scrolled ? "rgba(18,26,92,0.85)" : "transparent",
        // 14px with no saturate — the design's value. The saturate was mine.
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        boxShadow: scrolled ? "0 1px 0 rgba(255,255,255,0.08)" : "none",
        transition: "background 260ms ease, box-shadow 260ms ease",
      }}
    >
      <div className="mx-auto flex w-full items-center" style={{ maxWidth: PAGE_W, paddingInline: "clamp(18px,4vw,40px)", gap: 14, height: 62 }}>
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
          <a href="#pricing" style={{ color: "var(--color-neutral-800)" }}>Pricing</a>
          {/* Spelled out. "Docs" is what a nav says when it is short of room,
              and this one is not — and the page it opens calls itself
              Documentation. */}
          <a href={DOCS_URL} style={{ color: "var(--color-neutral-800)" }}>Documentation</a>
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
  // The design puts the hero's padding on the grid itself, and gives it NO
  // bottom padding — the strip below brings its own top space.
  return (
    <section id="top" className="on-dark" style={{ background: "#121A5C" }}>
      <div
        className="mx-auto grid w-full items-center"
        style={{
          maxWidth: PAGE_W,
          padding: "clamp(28px,5vw,56px) clamp(18px,4vw,40px) 0",
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
            {/* The demo below, which IS the checkout — the comparison page
                this used to open said what the demo shows. */}
            <a href="#demo" className="btn btn-secondary" style={{ padding: "13px 22px", fontSize: 14.5 }}>
              Try the checkout
            </a>
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
/**
 * How wide the page's bands run.
 *
 * The design fixes this at 1200px at all ten of its container sites, and on
 * a 1280 or 1366 laptop that is right — it is the width the hero's two
 * columns, the rail and the type were all proportioned against.
 *
 * It is a fixed pixel value though, so every pixel a display has beyond
 * 1200 becomes margin: 192px a side at 1585, 360px at 1920. The page stops
 * looking centred and starts looking stranded, which is what was reported.
 *
 * So: the design's 1200 up to ~1428px wide, then growth with the viewport,
 * stopping at 1320. The ceiling matters as much as the floor — past it the
 * hero's columns get wide enough that the h1 stops holding its three lines
 * and the rail outgrows the text beside it.
 *
 * A DELIBERATE divergence from the package, not a drift from it. Anything
 * proportioned against the band (the rail's 560x420 viewBox, the coin's
 * 0.73em) scales with it rather than being re-measured.
 */
const PAGE_W = "clamp(1200px,84vw,1320px)";

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
        /**
         * The design's own height, restored.
         *
         * This was cut to clamp(330px,33vw,430px) to keep the "Pay from" and
         * "Built with" strips above the fold on a laptop. That reasoning was
         * sound and the result was still wrong: the panel is the first thing
         * on the page and shrinking it by a fifth made the whole hero read as
         * compressed, which is what a reader notices before they notice a
         * logo strip they have to scroll for.
         *
         * If the strips do fall below the fold on a short window, the space
         * to take back is the section's vertical padding, not this.
         */
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
      /* on-dark: this strip continues the hero's navy run, and its logos and
         caption read against #121A5C, not white. */
      className="on-dark mx-auto flex w-full flex-col"
      style={{
        maxWidth: PAGE_W,
        gap: 16,
        padding: "clamp(10px,2vw,22px) clamp(18px,4vw,40px) clamp(24px,4vw,44px)",
      }}
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
    <section className="on-dark" style={{ background: "#121A5C", padding: "clamp(40px,7vw,86px) 0", position: "relative" }}>
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
    <Section id="how" dark background="#121A5C">
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
    <Section id="demo" background="#E9EEFF">
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
    <Section id="features" dark background="#121A5C">
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

/**
 * CHAIN FALLBACK — "Renewals don't fail. They find another chain."
 *
 * New in v4, and the one section that shows the thing this product actually
 * does that a card cannot. The numbers are the design's and they are
 * deliberately specific: Base holds 4.12 against 29.00 needed, so it is short
 * by 24.88 and NOTHING IS CHARGED THERE — the balance is checked before a
 * charge, not after a failure. Arbitrum has 38.00, pays, and drops to 9.00.
 * Optimism is never touched.
 *
 * That ordering is the real behaviour: delegated-renewal picks a funded chain
 * and the grant covers all three with one signature, which is why the copy can
 * say "same signature" without an asterisk.
 *
 * Under prefers-reduced-motion the sequence does not run and the resolved
 * state is rendered instead. A story told by animation alone is not told to
 * everyone.
 */
const FB_NEED = 29;
const FB_SCALE = 40; // the bar's full width in USDC, so 29 sits at 72.5%

type FbState = "idle" | "check" | "short" | "paid" | "skip";

const FB_TONE: Record<FbState, { tag: string; tagBg: string; tagInk: string; bg: string; ring: string; fill: string }> = {
  idle:  { tag: "Ready",          tagBg: "rgba(255,255,255,0.06)",  tagInk: "#9490C2", bg: "transparent", ring: "#2A2A3C", fill: "#6E6F86" },
  check: { tag: "Checking…",      tagBg: "rgba(124,127,255,0.18)",  tagInk: "#C9CAF6", bg: "#1C1C2E",     ring: "#7C7FFF", fill: "#7C7FFF" },
  short: { tag: "Not enough",     tagBg: "rgba(229,72,77,0.18)",    tagInk: "#FF9BA0", bg: "#24161A",     ring: "#E5484D", fill: "#E5484D" },
  paid:  { tag: "Charged $29.00", tagBg: "#4447D6",                 tagInk: "#fff",    bg: "#1C1C2E",     ring: "#7C7FFF", fill: "#7C7FFF" },
  skip:  { tag: "Not needed",     tagBg: "rgba(255,255,255,0.06)",  tagInk: "#8F90A6", bg: "transparent", ring: "#2A2A3C", fill: "#4A4A5E" },
};

const FB_LINES: Array<[string, string, string]> = [
  ["Renewal due — trying the subscriber's first chain", "#8F90A6", "rgba(110,111,134,0.25)"],
  ["Checking Base balance…", "#7C7FFF", "rgba(124,127,255,0.25)"],
  ["Base is short by $24.88 — no charge made", "#E5484D", "rgba(229,72,77,0.25)"],
  ["Falling back to Arbitrum, same signature", "#7C7FFF", "rgba(124,127,255,0.25)"],
  ["Charged $29.00 from Arbitrum — settled on Arc", "#7C7FFF", "rgba(124,127,255,0.25)"],
  ["Renewal complete. Nothing for anyone to do.", "#2BA06B", "rgba(31,138,91,0.3)"],
];

/** Balances against FB_NEED. ChainMark is the page's own glyph, not a reach
 *  into the checkout's components. */
const FB_CHAINS: Array<{ key: ChainKey; name: string; balance: number }> = [
  { key: "base", name: "Base", balance: 4.12 },
  { key: "arbitrum", name: "Arbitrum", balance: 38 },
  { key: "optimism", name: "Optimism", balance: 12.5 },
];

function fbStateFor(i: number, st: number): FbState {
  if (i === 0) return st === 1 ? "check" : st >= 2 ? "short" : "idle";
  if (i === 1) return st === 3 ? "check" : st >= 4 ? "paid" : "idle";
  return st >= 4 ? "skip" : "idle";
}

function Fallback() {
  const reduced = usePrefersReducedMotion();
  // 4 is the resolved frame: Arbitrum paid, Optimism untouched. Stage 5 is
  // only the closing line, so a still of 4 tells the whole story.
  const [st, setSt] = useState(reduced ? 4 : 0);

  useEffect(() => {
    if (reduced) {
      setSt(4);
      return;
    }
    const id = window.setInterval(() => setSt((n) => (n + 1) % (FB_LINES.length + 1)), 1600);
    return () => window.clearInterval(id);
  }, [reduced]);

  const stage = Math.min(st, FB_LINES.length - 1);
  const [line, dot, halo] = FB_LINES[stage]!;

  return (
    <section
      id="fallback"
      className="on-dark"
      style={{ background: "#0D1446", position: "relative", overflow: "hidden" }}
    >
      {/* A faint grid, faded out at the edges so it reads as depth rather than
          as a table. Decorative, hence aria-hidden. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.04) 1px,transparent 1px)",
          backgroundSize: "56px 56px",
          WebkitMaskImage: "radial-gradient(ellipse 70% 70% at 70% 50%,#000 15%,transparent 80%)",
          maskImage: "radial-gradient(ellipse 70% 70% at 70% 50%,#000 15%,transparent 80%)",
          pointerEvents: "none",
        }}
      />
      <div
        className="mx-auto"
        style={{
          position: "relative",
          maxWidth: PAGE_W,
          padding: "clamp(72px,9vw,120px) clamp(18px,4vw,40px)",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))",
          gap: "clamp(40px,6vw,80px)",
          alignItems: "center",
        }}
      >
        <div data-reveal="">
          <p
            className="m-0"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 14,
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "#FF9BA0",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-danger)" }} />
            When a wallet runs dry
          </p>
          <h2
            style={{
              margin: "0 0 20px",
              fontWeight: 800,
              fontSize: "clamp(34px,4.4vw,56px)",
              lineHeight: 1.04,
              letterSpacing: "-0.04em",
              textWrap: "balance",
            }}
          >
            Renewals don&rsquo;t fail. They find another chain.
          </h2>
          <p
            style={{
              margin: "0 0 28px",
              fontSize: 16.5,
              lineHeight: 1.65,
              color: "rgba(255,255,255,0.78)",
              maxWidth: "44ch",
            }}
          >
            A card renewal dies when the card does. With one signature covering Base, Arbitrum and Optimism, a short
            balance on one chain just means the charge comes from the next.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 15, color: "rgba(255,255,255,0.88)" }}>
            {[
              ["var(--color-danger)", "Short balance detected before anything is charged"],
              ["#CD94E6", "Charged from the next funded chain, same signature"],
              ["#8F90A6", "Settled on Arc like any other renewal"],
            ].map(([c, t]) => (
              <span key={t} style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ width: 18, height: 4, borderRadius: 2, background: c, flex: "none" }} />
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* The renewal itself, mid-decision. */}
        <div
          data-reveal=""
          style={{
            background: "#172066",
            borderRadius: 18,
            padding: "clamp(18px,2.5vw,26px)",
            boxShadow: "inset 0 0 0 1px #26307E, 0 40px 80px -40px rgba(0,0,0,0.8)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              flexWrap: "wrap",
              paddingBottom: 16,
              borderBottom: "1px solid #26307E",
            }}
          >
            <div>
              <p
                className="m-0"
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "#9490C2",
                }}
              >
                Renewal &middot; Nov 1
              </p>
              <p style={{ margin: "4px 0 0", fontWeight: 700, fontSize: 17 }}>jo@northwind.co &middot; Pro</p>
            </div>
            <p style={{ margin: "0 0 0 auto", fontWeight: 800, fontSize: 28, letterSpacing: "-0.03em" }}>
              $29.00{" "}
              <span style={{ fontSize: 13, fontWeight: 500, color: "#9490C2", letterSpacing: 0 }}>USDC</span>
            </p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 0" }}>
            {FB_CHAINS.map((c, i) => {
              const state = fbStateFor(i, st);
              const tone = FB_TONE[state];
              const bal = state === "paid" ? c.balance - FB_NEED : c.balance;
              return (
                <div
                  key={c.key}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "32px minmax(0,1fr) auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "12px 14px",
                    borderRadius: 12,
                    background: tone.bg,
                    boxShadow: `inset 0 0 0 1px ${tone.ring}`,
                    transition: "background 300ms ease, box-shadow 300ms ease",
                  }}
                >
                  <span
                    style={{
                      display: "grid",
                      placeItems: "center",
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      background: "#fff",
                    }}
                  >
                    <ChainMark chain={c.key} size={22} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13.5 }}>
                      <span style={{ fontWeight: 700 }}>{c.name}</span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 12.5,
                          color: state === "short" ? "#FF9BA0" : "#C3C4DE",
                        }}
                      >
                        ${bal.toFixed(2)} USDC
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        height: 6,
                        borderRadius: 3,
                        background: "#26307E",
                        position: "relative",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 0,
                          bottom: 0,
                          borderRadius: 3,
                          width: `${Math.min(100, (bal / FB_SCALE) * 100)}%`,
                          background: tone.fill,
                          transition: "width 600ms cubic-bezier(.23,1,.32,1), background 300ms ease",
                        }}
                      />
                      {/* What 29.00 looks like on this scale — the whole point
                          of the bars is that Base's fill stops short of it. */}
                      <div
                        style={{
                          position: "absolute",
                          top: -2,
                          bottom: -2,
                          left: `${(FB_NEED / FB_SCALE) * 100}%`,
                          width: 2,
                          background: "#9490C2",
                        }}
                      />
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 700,
                      padding: "5px 10px",
                      borderRadius: 999,
                      whiteSpace: "nowrap",
                      background: tone.tagBg,
                      color: tone.tagInk,
                      transition: "background 300ms ease",
                    }}
                  >
                    {tone.tag}
                  </span>
                </div>
              );
            })}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              paddingTop: 14,
              borderTop: "1px solid #26307E",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                flex: "none",
                background: dot,
                boxShadow: `0 0 0 4px ${halo}`,
                transition: "background 300ms ease",
              }}
            />
            {/* The running commentary is the status of a live renewal, so it is
                announced rather than silently repainted. */}
            <span role="status" style={{ flex: 1, minWidth: 180, fontSize: 13.5, fontWeight: 600 }}>
              {line}
            </span>
            <span style={{ fontSize: 11.5, color: "#9490C2" }}>Line on each bar = $29.00 needed</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * FEES & PAYOUTS — "Same $29.00 plan. Two very different paths."
 *
 * New in v4, and the only section on this page that quotes a competitor's
 * numbers, so both sides are sourced and the footnote says so: 2.9% + $0.30 is
 * a common online card rate, not a claim about any particular processor.
 *
 * OUR side is computed, never typed. feeOn/keepsOf read the same
 * VITE_PLATFORM_FEE_BPS as feePercent(), so this card cannot drift from the
 * Pricing section below it the way five hardcoded literals once did. At 250
 * bps that is "2.5% · −0.72" and "28.27".
 *
 * The second half answers the question the first half raises — a lower fee is
 * not the point if the money sits pending for days.
 */
function Compare() {
  const ROW: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    padding: "12px 0",
    borderTop: "1px solid var(--color-divider)",
    fontSize: 14.5,
  };
  const LABEL: CSSProperties = { color: "var(--color-neutral-600)" };
  const TOTAL: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    padding: "16px 0 0",
    marginTop: "auto",
    borderTop: "2px solid var(--color-neutral-400)",
  };
  const BIG: CSSProperties = { fontWeight: 800, fontSize: 34, letterSpacing: "-0.035em" };

  return (
    <Section id="compare" dark background="#121A5C">
      <div data-reveal="" style={{ textAlign: "center", marginBottom: 44 }}>
        <Kicker>Keep more of every renewal</Kicker>
        <h2
          style={{
            margin: "0 auto",
            fontWeight: 800,
            fontSize: "clamp(32px,4.2vw,54px)",
            lineHeight: 1.06,
            letterSpacing: "-0.04em",
            maxWidth: "18ch",
            textWrap: "balance",
          }}
        >
          Same $29.00 plan. Two very different paths.
        </h2>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,380px),1fr))",
          gap: 16,
        }}
      >
        {/* The card processor, with its own arithmetic shown. */}
        <article
          data-reveal=""
          style={{
            borderRadius: 18,
            background: "#1A2470",
            padding: "clamp(22px,3vw,32px)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <p
            style={{
              margin: "0 0 4px",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--color-neutral-600)",
            }}
          >
            Card processor
          </p>
          <p style={{ margin: "0 0 20px", fontWeight: 700, fontSize: 20 }}>Typical online card rate</p>
          <div style={ROW}>
            <span style={LABEL}>Plan price</span>
            <span style={{ fontWeight: 600 }}>$29.00</span>
          </div>
          <div style={ROW}>
            <span style={LABEL}>Processing &middot; 2.9% + $0.30</span>
            <span style={{ fontWeight: 600, color: "#FF9BA0" }}>&minus;$1.14</span>
          </div>
          <div style={ROW}>
            <span style={LABEL}>Expired card at renewal</span>
            <span style={{ fontWeight: 600, color: "#FF9BA0" }}>Renewal lost</span>
          </div>
          <div style={TOTAL}>
            <span style={{ fontWeight: 700 }}>You keep</span>
            <span style={BIG}>$27.86</span>
          </div>
        </article>

        {/* Ours. Every figure here is derived from the configured fee. */}
        <article
          data-reveal=""
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 18,
            background: "#4447D6",
            color: "#fff",
            padding: "clamp(22px,3vw,32px)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            aria-hidden
            style={{
              position: "absolute",
              right: -50,
              top: -50,
              width: 150,
              height: 150,
              borderRadius: "50%",
              background: "var(--color-danger)",
            }}
          />
          <p
            style={{
              position: "relative",
              margin: "0 0 4px",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.78)",
            }}
          >
            Sweep Console
          </p>
          <p style={{ position: "relative", margin: "0 0 20px", fontWeight: 700, fontSize: 20 }}>
            USDC, one signature
          </p>
          {[
            ["Plan price", "$29.00"],
            ["Platform fee", `${feePercent()} · −$${feeOn(29)}`],
            ["Network & bridge gas", "Covered"],
          ].map(([k, v]) => (
            <div key={k} style={{ ...ROW, position: "relative", borderTopColor: "rgba(255,255,255,0.2)" }}>
              <span style={{ color: "rgba(255,255,255,0.8)" }}>{k}</span>
              <span style={{ fontWeight: 600 }}>{v}</span>
            </div>
          ))}
          <div style={{ ...TOTAL, position: "relative", borderTopColor: "rgba(255,255,255,0.42)" }}>
            <span style={{ fontWeight: 700 }}>You keep</span>
            <span style={{ ...BIG, textAlign: "right" }}>
              ${keepsOf(29)}{" "}
              <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: 0, color: "rgba(255,255,255,0.8)" }}>
                USDC
              </span>
            </span>
          </div>
        </article>
      </div>

      {/* A lower fee is not the point if the money is not yours yet. */}
      <div
        data-reveal=""
        style={{
          marginTop: 16,
          borderRadius: 18,
          border: "1px solid var(--color-divider)",
          padding: "clamp(22px,3vw,32px)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "8px 20px",
            marginBottom: 24,
          }}
        >
          <p style={{ margin: 0, fontWeight: 800, fontSize: "clamp(22px,2.4vw,28px)", letterSpacing: "-0.025em" }}>
            When the money is actually yours
          </p>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--color-neutral-600)" }}>
            From charge to spendable balance
          </p>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(110px,160px) minmax(0,1fr)",
            gap: "22px 20px",
            alignItems: "center",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 14.5, color: "var(--color-neutral-700)" }}>Card payout</span>
          <div>
            <div style={{ position: "relative", height: 12, borderRadius: 6, background: "rgba(255,255,255,0.08)" }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: 6,
                  background: "repeating-linear-gradient(90deg,#6E6AA6 0 10px,rgba(255,255,255,0.16) 10px 20px)",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  right: -2,
                  top: "50%",
                  width: 16,
                  height: 16,
                  marginTop: -8,
                  borderRadius: "50%",
                  background: "#fff",
                  boxShadow: "inset 0 0 0 3px var(--color-neutral-600)",
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 8,
                fontSize: 12,
                color: "var(--color-neutral-600)",
              }}
            >
              <span>Charged</span>
              <span>Pending</span>
              <span style={{ fontWeight: 700, color: "var(--color-neutral-700)" }}>
                Payout &middot; typically 2+ business days
              </span>
            </div>
          </div>

          <span style={{ fontWeight: 700, fontSize: 14.5, color: "var(--color-accent)" }}>Sweep Console</span>
          <div>
            <div
              style={{ position: "relative", height: 12, borderRadius: 6, background: "rgba(205,148,230,0.16)" }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: "6%",
                  minWidth: 28,
                  borderRadius: 6,
                  background: "#4447D6",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  left: "max(6%,28px)",
                  top: "50%",
                  width: 16,
                  height: 16,
                  margin: "-8px 0 0 -8px",
                  borderRadius: "50%",
                  background: "#4447D6",
                  boxShadow: "0 0 0 4px rgba(205,148,230,0.3)",
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 8,
                fontSize: 12,
                color: "var(--color-neutral-600)",
              }}
            >
              <span style={{ fontWeight: 700, color: "var(--color-accent)" }}>Settled on Arc &middot; seconds</span>
              <span>Already in your wallet</span>
            </div>
          </div>
        </div>
      </div>

      {/* Sourced, because the left-hand card is someone else's number. */}
      <p style={{ margin: "14px 0 0", fontSize: 12, color: "var(--color-neutral-600)" }}>
        Card figures use a common 2.9% + $0.30 online rate and standard payout timing; your processor may differ.
      </p>
    </Section>
  );
}

/**
 * TRUST & SAFETY — "Nobody holds your money. Not even us."
 *
 * New in v4. The four claims are the ones a developer actually checks before
 * wiring a standing permission into their product, and each is load-bearing
 * elsewhere in this repo: non-custodial is why there is no balance to withdraw,
 * revocable is why ManageSubscriptionsPage exists, the period ceiling is the
 * ERC20PeriodTransferEnforcer caveat, and the HMAC is X-Sweep-Signature.
 *
 * Its own ground (#E9EEFF), not Section's two-tone default: this lands between
 * two white bands and would otherwise be invisible as a section at all.
 */
function Custody() {
  const CARD: CSSProperties = {
    borderRadius: 16,
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    minHeight: 280,
  };
  const TITLE: CSSProperties = { margin: "auto 0 0", fontWeight: 800, fontSize: 20, letterSpacing: "-0.02em" };
  const BODY: CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.6 };

  return (
    <Section id="trust" background="#E9EEFF">
      {/* Split header: heading left, the one-line promise right. v4 uses this
          shape only here, and only because the claim and its qualifier are the
          same sentence read twice. */}
      <div
        data-reveal=""
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 20,
          marginBottom: 44,
        }}
      >
        <div>
          <Kicker align="left">Trust &amp; safety</Kicker>
          <h2
            style={{
              margin: 0,
              fontWeight: 800,
              fontSize: "clamp(32px,4.2vw,54px)",
              lineHeight: 1.06,
              letterSpacing: "-0.04em",
              maxWidth: "16ch",
              textWrap: "balance",
            }}
          >
            Nobody holds your money. <span style={{ color: "var(--color-danger)" }}>Not even us.</span>
          </h2>
        </div>
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: "var(--color-neutral-700)", maxWidth: "40ch" }}>
          Subscribers stay in control of their wallet, and you stay in control of your payouts.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,240px),1fr))",
          gap: 14,
        }}
      >
        {/* Non-custodial — the wallet-to-wallet hop, drawn. */}
        <article data-reveal="" style={{ ...CARD, background: "#0D1446", color: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 64 }}>
            <span style={CUSTODY_NODE}>Sub</span>
            <span
              style={{
                flex: 1,
                height: 2,
                background: "repeating-linear-gradient(90deg,#CD94E6 0 6px,transparent 6px 12px)",
              }}
            />
            <span style={{ ...CUSTODY_NODE, background: "var(--color-accent)", boxShadow: "none", color: "#fff" }}>
              You
            </span>
          </div>
          <h3 style={TITLE}>Non-custodial</h3>
          <p style={{ ...BODY, color: "rgba(255,255,255,0.78)" }}>
            USDC moves wallet to wallet. We never hold a balance you&rsquo;d have to withdraw.
          </p>
        </article>

        {/* Revocable — a switch already thrown. */}
        <article data-reveal="" style={{ ...CARD, background: "#F7F7FB" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, height: 64 }}>
            <span
              style={{
                width: 52,
                height: 30,
                borderRadius: 999,
                background: "var(--color-danger)",
                position: "relative",
                flex: "none",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 4,
                  top: 4,
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: "#fff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
                }}
              />
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--color-danger-text)" }}>Access revoked</span>
          </div>
          <h3 style={TITLE}>Revocable anytime</h3>
          <p style={{ ...BODY, color: "var(--color-neutral-700)" }}>
            Subscribers cancel from their wallet or the subscriber portal. No support ticket, no card to cancel.
          </p>
        </article>

        {/* The period ceiling, at its limit and unable to pass it. */}
        <article data-reveal="" style={{ ...CARD, background: "var(--color-accent)", color: "#fff" }}>
          <div style={{ height: 64, display: "flex", flexDirection: "column", justifyContent: "center", gap: 8 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
                fontWeight: 600,
                color: "rgba(255,255,255,0.86)",
              }}
            >
              <span>Used this month</span>
              <span>29.00 / 29.00</span>
            </div>
            <div style={{ position: "relative", height: 10, borderRadius: 5, background: "rgba(255,255,255,0.24)" }}>
              <div style={{ position: "absolute", inset: "0 0 0 0", borderRadius: 5, background: "#fff" }} />
              <span
                style={{
                  position: "absolute",
                  right: -1,
                  top: -5,
                  bottom: -5,
                  width: 3,
                  borderRadius: 2,
                  background: "var(--color-danger)",
                }}
              />
            </div>
          </div>
          <h3 style={TITLE}>Hard spending limits</h3>
          <p style={{ ...BODY, color: "rgba(255,255,255,0.88)" }}>
            The signature sets a ceiling per period. Nothing can ever be charged above it.
          </p>
        </article>

        {/* The signature header, as a backend actually sees it. */}
        <article data-reveal="" style={{ ...CARD, border: "1px solid var(--color-divider)" }}>
          <div style={{ height: 64, display: "flex", alignItems: "center" }}>
            <code
              style={{
                display: "block",
                width: "100%",
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                lineHeight: 1.6,
                background: "#172066",
                color: "#C8C9E4",
                borderRadius: 9,
                padding: "10px 12px",
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              <span style={{ color: "#9FA2F5" }}>x-sweep-signature</span>: sha256=9f2c&hellip;
            </code>
          </div>
          <h3 style={TITLE}>Signed webhooks</h3>
          <p style={{ ...BODY, color: "var(--color-neutral-700)" }}>
            Every event carries an HMAC signature, so your backend only trusts what really came from us.
          </p>
        </article>
      </div>
    </Section>
  );
}

const CUSTODY_NODE: CSSProperties = {
  flex: "none",
  width: 40,
  height: 40,
  borderRadius: 10,
  background: "#172066",
  boxShadow: "inset 0 0 0 1px #26307E",
  display: "grid",
  placeItems: "center",
  fontSize: 11,
  fontWeight: 700,
  color: "#A9ABC6",
};

function Developers() {
  return (
    <Section id="developers" background="var(--color-surface)">
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
          <a href={DOCS_URL} style={{ fontSize: 14, fontWeight: 600, color: "var(--color-accent)", marginTop: 4 }}>
            Read the documentation →
          </a>
        </div>
      </div>
    </Section>
  );
}

function Pricing() {
  return (
    <Section id="pricing" background="#ffffff">
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
              <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.85 }}>{p.unit}</span>
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
    /* v4 closes on navy (#16206A), a shade off the page ground so the last
       call to action is a band rather than the page running out. It solves the
       same problem the old tint did — Pricing above and the footer below are
       both light — and solves it the way the rest of the page now works. */
    <section
      id="start"
      className="on-dark"
      style={{ background: "#16206A", padding: "clamp(56px,8vw,96px) 0" }}
    >
      <div className="mx-auto w-full" style={{ maxWidth: PAGE_W, paddingInline: "clamp(18px,4vw,40px)", textAlign: "center" }}>
        <span className="inline-flex" style={{ marginBottom: 22 }}>
          <SweepMark size={46} />
        </span>
        <h2 style={{ fontSize: "clamp(38px,5.6vw,72px)", letterSpacing: "-0.04em", lineHeight: 1.02, margin: 0, fontWeight: 800 }}>
          Your first renewal is <span style={{ color: "var(--color-accent)" }}>one signature</span> away.
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
    <footer
      className="on-dark"
      style={{ background: "#121A5C", borderTop: "1px solid rgba(255,255,255,0.18)", padding: "26px 0" }}
    >
      <div
        className="mx-auto flex w-full flex-wrap items-center"
        style={{ maxWidth: PAGE_W, paddingInline: "clamp(18px,4vw,40px)", gap: "10px 26px", fontSize: 13.5, color: "var(--color-neutral-800)" }}
      >
        <span className="flex items-center" style={{ gap: 9, color: "var(--color-text)", fontWeight: 700 }}>
          <SweepMark size={20} />
          Sweep Console
        </span>
        <a href={DOCS_URL} style={{ color: "var(--color-neutral-800)" }}>Documentation</a>
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
        {/*
          v4's band order. The page is a navy ground with light bands cut into
          it, so these alternate on purpose — two dark sections in a row read as
          one long section, which is the complaint the Pricing/StartCta pair
          drew before.

            Hero       #121A5C   dark
            Statement  #121A5C   dark
            HowItWorks #121A5C   dark
            Fallback   #0D1446   dark, deepest — it is the demo
            Demo       #E9EEFF   light
            Features   #121A5C   dark
            Compare    #121A5C   dark
            Custody    #E9EEFF   light
            Developers #F4F4FB   light
            Pricing    #fff      light — KEPT, see below
            StartCta   #16206A   dark

          ConsolePreview is dropped: v4 has no "Run it all from one place"
          band. Pricing is kept against v4, which drops it too, because it is
          where the platform fee is disclosed and a pricing page that does not
          state the rate is worse than an ugly one.
        */}
        <Hero />
        <Marks />
        <Statement />
        <HowItWorks />
        <Fallback />
        <Demo />
        <Features />
        <Compare />
        <Custody />
        <Developers />
        <Pricing />
        <StartCta />
      </main>
      <Footer />
    </div>
  );
}

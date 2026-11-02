/**
 * The landing page, built to the v4 design.
 *
 * WHAT V4 IS. Not a restyle — v2, v3 and v4 all carry the tokens this app
 * already ships. What v4 changes is that the page becomes a NAVY GROUND with
 * light bands cut into it, and its section list is a different set:
 *
 *   top · how · fallback · demo · features · compare · trust · developers · start
 *
 * Things from the old page that v4 does not have are GONE, not re-coloured:
 * the animated rail (RailViz, its orbit constants, Spin, MONTHS), the logo
 * strip (Marks), the Statement band, and the console preview. Keeping them
 * dark-tinted was the mistake in the first pass at this.
 *
 * The hero's subject is now <HoloScene> — an iridescent glass blob and arc in
 * three.js — not a coin travelling a rail.
 *
 * PRICING IS KEPT, though v4 drops it. It is where the platform fee is
 * disclosed, the header links to it, and a pricing page that does not state a
 * rate is worse than a mockup that forgot one.
 *
 * THE WEBHOOK NAMES ARE THE REAL ONES. The design shows
 * `checkout.session.completed` and `grant.revoked`; neither is sent. EVENTS
 * below is what apps/api actually emits — advertising an event a developer
 * cannot then subscribe to costs more trust than it buys.
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { DOCS_URL } from "@/lib/docs";
import { feeOn, feePercent, keepsOf } from "@/lib/fee";
import { HoloScene } from "@/components/landing/HoloScene";
import { ChainMark, SweepMark, UsdcMark, METAMASK_LOGO, CIRCLE_LOGO, type ChainKey } from "@/components/ui/marks";

/** v4 lays every band out on a 1200px measure. */
const PAGE_W = "min(1200px, 100%)";

/** The CTA gradient, used by both call-to-action buttons. */
const CTA_GRADIENT =
  "linear-gradient(100deg,#F6E7A9 0%,#EBC7F3 32%,#BCC5FF 58%,#A9F0EC 82%,#F3D2F0 100%)";

const CTA_STYLE: CSSProperties = {
  background: CTA_GRADIENT,
  color: "#121A5C",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.7), 0 12px 30px -12px rgba(205,148,230,0.7)",
  fontWeight: 700,
  borderRadius: 999,
  display: "inline-block",
};

/** A ghost button on navy: a hairline ring, no fill until hover. */
const GHOST_STYLE: CSSProperties = {
  color: "#fff",
  fontWeight: 500,
  borderRadius: 999,
  boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0.35)",
  display: "inline-block",
};

/** v4's three steps. Each card carries its own ground. */
const STEPS = [
  {
    n: "01",
    title: "Choose a plan",
    body: "Tiers, trials and a recommended pick, on a hosted checkout or a shareable payment link.",
    bg: "#1A2470",
    ink: "#F3F1FF",
    sub: "#B4B0DA",
    tileBg: "rgba(255,255,255,0.1)",
    chains: [] as ChainKey[],
    usdc: true,
  },
  {
    n: "02",
    title: "Pay from any chain",
    body: "Subscribers verify their email, connect a wallet and pick Base, Arbitrum or Optimism. One signature, no gas.",
    bg: "#4447D6",
    ink: "#fff",
    sub: "rgba(255,255,255,0.84)",
    tileBg: "rgba(255,255,255,0.18)",
    chains: ["base", "arbitrum", "optimism"] as ChainKey[],
    usdc: false,
  },
  {
    n: "03",
    title: "Settled on Arc",
    body: "USDC is swept over CCTP straight to your payout wallet. Renewals repeat on their own.",
    bg: "#0D1446",
    ink: "#fff",
    sub: "rgba(255,255,255,0.76)",
    tileBg: "#E5484D",
    chains: ["arc"] as ChainKey[],
    usdc: false,
  },
];

/** v4's feature rules. The colour is the little bar beside the number. */
const FEATURES = [
  { n: "01", color: "#CD94E6", title: "Gasless by default", body: "We submit every transaction and cover network and bridge costs. Subscribers pay the exact plan amount." },
  { n: "02", color: "#FF7A90", title: "Renewals with a fallback", body: "Authorize every chain once. If Base runs dry, the renewal charges whichever chain holds a full period." },
  { n: "03", color: "#9EE8F0", title: "Email-anchored customers", body: "A 6-digit code verifies each subscriber. Returning customers are recognised with the wallet they paid with." },
  { n: "04", color: "#CD94E6", title: "Plans, tiers and trials", body: "Daily to yearly intervals, free trials, feature lists and a recommended tier — previewed as subscribers see it." },
  { n: "05", color: "#9EE8F0", title: "A portal subscribers can use", body: "Customers sign in with email to see what they pay for, which wallet backs it, and revoke grants themselves." },
  { n: "06", color: "#FF7A90", title: "Webhooks, keys, test mode", body: "Signed webhooks, scoped API keys and a full test environment where no real USDC moves." },
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

/* ── shared primitives ─────────────────────────────────────────────────── */

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


/* ── the marquee under the hero ───────────────────────────────────────── */

/**
 * The logo strip v4 runs along the bottom of the hero.
 *
 * Two identical halves scrolling as one, so the loop has no seam, and the
 * whole thing is aria-hidden: it is a row of logos, not information, and a
 * screen reader reading "Base Arbitrum Optimism USDC Arc MetaMask Circle"
 * twice is noise. It stops dead under prefers-reduced-motion — an infinite
 * horizontal scroll is the single worst offender for motion sensitivity.
 */
const MARQUEE: Array<{ kind: "chain" | "token" | "logo"; key?: ChainKey; label: string; src?: string; h?: number }> = [
  { kind: "chain", key: "base", label: "Base" },
  { kind: "chain", key: "arbitrum", label: "Arbitrum" },
  { kind: "chain", key: "optimism", label: "Optimism" },
  { kind: "token", label: "USDC" },
  { kind: "chain", key: "arc", label: "Arc" },
  { kind: "logo", label: "MetaMask", src: METAMASK_LOGO, h: 30 },
  { kind: "logo", label: "Circle", src: CIRCLE_LOGO, h: 32 },
];

function Marquee() {
  const reduced = usePrefersReducedMotion();
  const half = (
    <div style={{ display: "flex", alignItems: "center", gap: 56, paddingRight: 56, flex: "none" }}>
      {MARQUEE.map((m) => (
        <span
          key={m.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 24,
            fontWeight: 500,
            color: "#fff",
            whiteSpace: "nowrap",
            letterSpacing: "-0.01em",
          }}
        >
          {m.kind === "chain" && m.key ? <ChainMark chain={m.key} size={44} /> : null}
          {m.kind === "token" ? <UsdcMark size={44} /> : null}
          {m.kind === "logo" ? (
            <img
              src={m.src}
              alt=""
              style={{
                height: m.h,
                width: "auto",
                display: "block",
                // Circle's mark is dark; invert it onto navy.
                filter: m.label === "Circle" ? "brightness(0) invert(1)" : "none",
              }}
            />
          ) : (
            m.label
          )}
        </span>
      ))}
    </div>
  );

  return (
    <div
      aria-hidden
      style={{
        position: "relative",
        background: "rgba(8,14,58,0.55)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        overflow: "hidden",
        WebkitMaskImage: "linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)",
        maskImage: "linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          width: "max-content",
          padding: "18px 0",
          animation: reduced ? undefined : "swp-marquee 38s linear infinite",
        }}
      >
        {half}
        {half}
      </div>
    </div>
  );
}

/* ── header ───────────────────────────────────────────────────────────── */

/**
 * v4's nav floats over the hero and only takes a ground once there is
 * something behind it — rgba(18,26,92,0.85) over a blur, with a white
 * hairline rather than a dark one, because a light rule on navy is a BRIGHT
 * line, not a quiet one.
 */
function Header() {
  const { user, loading } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  const link: CSSProperties = { color: "#fff", fontSize: 15.5, fontWeight: 400, whiteSpace: "nowrap" };

  return (
    <header
      className="on-dark sticky top-0"
      style={{
        zIndex: 50,
        background: scrolled ? "rgba(18,26,92,0.85)" : "transparent",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        boxShadow: scrolled ? "0 1px 0 rgba(255,255,255,0.08)" : "none",
        transition: "background 260ms ease, box-shadow 260ms ease",
      }}
    >
      <div
        className="mx-auto flex items-center"
        style={{ maxWidth: PAGE_W, padding: "18px clamp(18px,4vw,40px)", gap: 32 }}
      >
        <Link to="/" className="flex items-center" style={{ gap: 10, color: "#fff" }}>
          <SweepMark size={26} />
          <span style={{ fontSize: 20, fontWeight: 400, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
            Sweep <span style={{ fontWeight: 700, color: "#CD94E6" }}>Console</span>
          </span>
        </Link>
        <nav
          className="ml-auto hidden items-center md:flex"
          style={{ gap: 30 }}
        >
          <a href="#how" style={link}>How it works</a>
          <a href="#features" style={link}>Features</a>
          <a href="#pricing" style={link}>Pricing</a>
          <a href={DOCS_URL} style={link}>Documentation</a>
        </nav>
        <div className="ml-auto flex items-center md:ml-0" style={{ gap: 12 }}>
          {loading ? null : user ? (
            <Link to="/dashboard" style={{ ...CTA_STYLE, padding: "11px 22px", fontSize: 14 }}>
              Dashboard
            </Link>
          ) : (
            <>
              <Link to="/login" style={{ ...link, fontWeight: 500 }}>Log in</Link>
              <Link to="/signup" style={{ ...CTA_STYLE, padding: "11px 22px", fontSize: 14 }}>
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

/**
 * 100svh of navy, two blurred colour fields, the holo scene on the right and
 * the marquee pinned under it.
 *
 * The h1 is WEIGHT 400, not 800. v4's display type is light and large with
 * italic accents, which is the clearest single signal that this is a
 * different design from the one that was here — that page set everything in
 * 700/800.
 */
function Hero() {
  return (
    <section
      id="top"
      className="on-dark"
      style={{
        position: "relative",
        background: "#121A5C",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: "100svh",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: "-8%",
          top: "-18%",
          width: "48%",
          height: "60%",
          borderRadius: "50%",
          background:
            "radial-gradient(closest-side,rgba(205,148,230,0.35),rgba(107,92,255,0.15) 60%,transparent)",
          filter: "blur(30px)",
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: "-12%",
          top: "-10%",
          width: "40%",
          height: "50%",
          borderRadius: "50%",
          background: "radial-gradient(closest-side,rgba(64,224,255,0.12),transparent)",
          filter: "blur(30px)",
          pointerEvents: "none",
        }}
      />

      <div
        className="mx-auto"
        style={{
          position: "relative",
          maxWidth: PAGE_W,
          width: "100%",
          boxSizing: "border-box",
          padding: "clamp(88px,9vw,104px) clamp(18px,4vw,40px) clamp(16px,2vw,28px)",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,360px),1fr))",
          gap: "clamp(20px,4vw,48px)",
          alignItems: "center",
          flex: 1,
        }}
      >
        <div data-reveal="" style={{ position: "relative", zIndex: 2 }}>
          {/* The tilted ring that crosses behind the first word. */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: -46,
              top: -8,
              width: 120,
              height: 76,
              borderRadius: "50%",
              border: "1.5px solid rgba(205,148,230,0.55)",
              transform: "rotate(-24deg)",
              boxShadow: "0 0 18px rgba(205,148,230,0.35), inset 0 0 12px rgba(205,148,230,0.25)",
              pointerEvents: "none",
            }}
          />
          <h1
            style={{
              position: "relative",
              margin: 0,
              fontWeight: 400,
              fontSize: "clamp(46px,min(6.2vw,9.5svh),88px)",
              lineHeight: 1.1,
              letterSpacing: "-0.025em",
              color: "#fff",
            }}
          >
            Recurring <span style={{ color: "#CD94E6" }}>revenue</span>
            <br />
            in{" "}
            <span style={{ whiteSpace: "nowrap" }}>
              <span
                style={{
                  display: "inline-block",
                  width: "0.72em",
                  height: "0.72em",
                  marginRight: "0.12em",
                  verticalAlign: "baseline",
                }}
              >
                <UsdcMark />
              </span>
              <em style={{ color: "#CD94E6", fontStyle: "italic" }}>USDC.</em>
            </span>
          </h1>
          <p
            style={{
              margin: "22px 0 0",
              fontSize: "clamp(15.5px,1.3vw,17.5px)",
              lineHeight: 1.65,
              color: "rgba(255,255,255,0.82)",
              maxWidth: "42ch",
              fontWeight: 300,
            }}
          >
            Subscribers approve a USDC spending limit with one wallet signature. Renewals charge themselves from
            Base, Arbitrum or Optimism, and settle to you on Arc. Gas is on us.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 28 }}>
            <Link
              to="/signup"
              style={{
                ...CTA_STYLE,
                fontSize: 14.5,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "15px 30px",
              }}
            >
              Create your first plan
            </Link>
            <a
              href="#demo"
              style={{
                ...GHOST_STYLE,
                fontSize: 14.5,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "15px 26px",
              }}
            >
              Try the checkout
            </a>
          </div>
        </div>

        {/* The subject. Hidden below the two-column breakpoint, where it would
            be a 300px-tall smear behind the copy rather than an object. */}
        <div
          aria-hidden
          className="hidden md:block"
          style={{
            position: "relative",
            height: "min(clamp(300px,40vw,560px), calc(100svh - 230px))",
            minHeight: 260,
            marginRight: "calc(-1 * clamp(18px,4vw,40px))",
          }}
        >
          <div style={{ position: "absolute", inset: "-8% -14% -14% -10%" }}>
            <HoloScene />
          </div>
        </div>
      </div>

      <Marquee />
    </section>
  );
}

/* ── how it works ─────────────────────────────────────────────────────── */

function HowItWorks() {
  return (
    <Section id="how" dark background="#121A5C">
      <div data-reveal="" style={{ textAlign: "center", marginBottom: 52 }}>
        <Kicker>How it works</Kicker>
        <h2
          style={{
            margin: "0 auto",
            fontWeight: 700,
            fontSize: "clamp(32px,4vw,50px)",
            lineHeight: 1.12,
            letterSpacing: "-0.03em",
            maxWidth: "18ch",
            textWrap: "balance",
          }}
        >
          Three steps. Zero gas for your subscribers.
        </h2>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,280px),1fr))",
          gap: 20,
        }}
      >
        {STEPS.map((s) => (
          <div
            key={s.n}
            data-reveal=""
            style={{
              padding: "30px 28px 34px",
              borderRadius: 16,
              background: s.bg,
              color: s.ink,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              minHeight: 260,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: s.tileBg,
                  color: s.ink,
                  fontWeight: 800,
                  fontSize: 14,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {s.n}
              </span>
              {/* Overlapped marks, each ringed in the card's own ground so the
                  stack reads as a stack. */}
              <div style={{ display: "flex" }}>
                {s.usdc ? (
                  <span style={{ display: "block", borderRadius: "50%", background: "#fff", padding: 4, boxShadow: `0 0 0 2px ${s.bg}` }}>
                    <UsdcMark size={22} />
                  </span>
                ) : null}
                {s.chains.map((c, i) => (
                  <span
                    key={c}
                    style={{
                      display: "block",
                      borderRadius: "50%",
                      background: "#fff",
                      padding: 4,
                      marginLeft: i === 0 && !s.usdc ? 0 : -8,
                      boxShadow: `0 0 0 2px ${s.bg}`,
                    }}
                  >
                    <ChainMark chain={c} size={22} />
                  </span>
                ))}
              </div>
            </div>
            <h3 style={{ margin: "auto 0 0", fontWeight: 800, fontSize: 24, letterSpacing: "-0.025em" }}>
              {s.title}
            </h3>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: s.sub, textWrap: "pretty" }}>{s.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ── chain fallback ────────────────────────────────────────────────────── */

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


/* ── the checkout demo ─────────────────────────────────────────────────── */

/**
 * The hosted checkout, drawn as a subscriber sees it: email verified, wallet
 * connected, and the only decision left is which chain holds the funds.
 *
 * The numbered steps match AuthorizePage's, because they are the same three
 * steps — this is a picture of the real screen, not an idealised one.
 */
function Demo() {
  const [picked, setPicked] = useState<ChainKey>("base");
  const row: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 14px",
    borderRadius: 12,
    width: "100%",
    textAlign: "left",
    cursor: "pointer",
    transition: "background 160ms ease, box-shadow 160ms ease",
  };

  return (
    <Section id="demo" background="#E9EEFF">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))",
          gap: "clamp(36px,5vw,72px)",
          alignItems: "center",
        }}
      >
        <div data-reveal="">
          <Kicker align="left">Hosted checkout</Kicker>
          <h2
            style={{
              margin: "0 0 18px",
              fontWeight: 700,
              fontSize: "clamp(32px,4vw,50px)",
              lineHeight: 1.12,
              letterSpacing: "-0.03em",
              textWrap: "balance",
            }}
          >
            Pick a chain. That&rsquo;s the payment.
          </h2>
          <p style={{ margin: "0 0 26px", fontSize: 16, lineHeight: 1.65, color: "var(--color-neutral-700)", maxWidth: "44ch" }}>
            Email verified, wallet connected, one tap on the chain that holds the funds.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 15, color: "var(--color-neutral-800)" }}>
            {[
              "Network and bridge fees covered by Sweep Console",
              "Each charge goes straight to the creator",
              "Cancel anytime by revoking from the wallet",
            ].map((t) => (
              <span key={t} style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ width: 18, height: 4, borderRadius: 2, background: "var(--color-accent)", flex: "none" }} />
                {t}
              </span>
            ))}
          </div>
        </div>

        <div
          data-reveal=""
          style={{
            background: "var(--color-bg)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "0 0 0 1px var(--color-neutral-400), var(--shadow-lg)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "20px 22px", borderBottom: "1px solid var(--color-divider)" }}>
            <p className="m-0" style={{ fontWeight: 700, fontSize: 15 }}>Northwind Studio</p>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10 }}>
              <span style={{ fontWeight: 800, fontSize: 30, letterSpacing: "-0.03em" }}>$29.00</span>
              <span style={{ fontSize: 13, color: "var(--color-neutral-600)" }}>USDC / month</span>
            </div>
            <p className="m-0" style={{ marginTop: 2, fontSize: 13, color: "var(--color-neutral-600)" }}>Pro</p>
          </div>

          <div style={{ padding: "16px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              ["01", "jo@northwind.co", "Verified"],
              ["02", "0x7a3f…91c2", "Wallet connected"],
            ].map(([n, v, tag]) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-accent)", width: 22, flex: "none" }}>
                  {n}
                </span>
                <span style={{ fontWeight: 600 }}>{v}</span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, color: "var(--color-ok-text)" }}>{tag}</span>
              </div>
            ))}

            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-accent)", width: 22, flex: "none" }}>
                  03
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-neutral-700)" }}>
                  Pay from
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {CHAINS.map((c) => {
                  const on = picked === c.key;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setPicked(c.key)}
                      aria-pressed={on}
                      style={{
                        ...row,
                        background: on ? "var(--color-accent-200)" : "var(--color-neutral-100)",
                        boxShadow: on ? "inset 0 0 0 1.5px var(--color-accent)" : "inset 0 0 0 1px var(--color-divider)",
                      }}
                    >
                      <ChainMark chain={c.key} size={26} />
                      <span style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{c.name}</span>
                        <span style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>{c.note}</span>
                      </span>
                      <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, color: on ? "var(--color-accent)" : "var(--color-neutral-600)" }}>
                        {on ? "Selected" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="m-0" style={{ marginTop: 10, fontSize: 12, color: "var(--color-neutral-600)" }}>
                Renew from any funded chain — if {CHAINS.find((c) => c.key === picked)!.name} runs short, the next one pays.
              </p>
            </div>
          </div>

          <div style={{ padding: "14px 22px", borderTop: "1px solid var(--color-divider)", fontSize: 13.5 }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span style={{ color: "var(--color-neutral-600)" }}>Network fee</span>
              <span style={{ fontWeight: 600, color: "var(--color-ok-text)" }}>Covered by Sweep Console</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "4px 0" }}>
              <span style={{ fontWeight: 700 }}>Due today</span>
              <span style={{ fontWeight: 800, fontSize: 20, letterSpacing: "-0.02em" }}>
                $29.00 <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-neutral-600)" }}>USDC</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}


/* ── features ──────────────────────────────────────────────────────────── */

function Features() {
  return (
    <Section id="features" dark background="#121A5C">
      <div
        data-reveal=""
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 20,
          marginBottom: 48,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontWeight: 700,
            fontSize: "clamp(32px,4vw,50px)",
            lineHeight: 1.12,
            letterSpacing: "-0.03em",
            maxWidth: "17ch",
            textWrap: "balance",
          }}
        >
          Everything a subscription business needs, <span style={{ color: "var(--color-accent)" }}>on-chain</span>.
        </h2>
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: "var(--color-neutral-600)", maxWidth: "38ch" }}>
          From the first checkout to the fortieth renewal, one rail handles it.
        </p>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))",
          gap: "0 40px",
        }}
      >
        {FEATURES.map((f) => (
          <div
            key={f.n}
            data-reveal=""
            style={{
              padding: "28px 0 32px",
              borderTop: "1px solid var(--color-divider)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: 800, color: f.color }}>
              <span style={{ width: 28, height: 4, borderRadius: 2, background: f.color }} />
              {f.n}
            </span>
            <h3 style={{ margin: 0, fontWeight: 700, fontSize: 20, letterSpacing: "-0.015em" }}>{f.title}</h3>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.65, color: "var(--color-neutral-600)", textWrap: "pretty" }}>
              {f.body}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}


/* ── fees and payouts ──────────────────────────────────────────────────── */

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


/* ── trust and safety ──────────────────────────────────────────────────── */

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


/* ── developers ────────────────────────────────────────────────────────── */

function Developers() {
  return (
    <Section id="developers" background="var(--color-surface)">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))",
          gap: "clamp(36px,5vw,72px)",
          alignItems: "center",
        }}
      >
        <div data-reveal="">
          <Kicker align="left">For developers</Kicker>
          <h2
            style={{
              margin: "0 0 18px",
              fontWeight: 700,
              fontSize: "clamp(32px,4vw,50px)",
              lineHeight: 1.12,
              letterSpacing: "-0.03em",
              textWrap: "balance",
            }}
          >
            A checkout in one request.
          </h2>
          <p style={{ margin: "0 0 26px", fontSize: 16, lineHeight: 1.65, color: "var(--color-neutral-700)", maxWidth: "44ch" }}>
            Create a session, redirect, and listen for webhooks. Or skip code entirely with a shareable payment link.
          </p>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {EVENTS.map((e) => (
              <div
                key={e.name}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "6px 14px",
                  padding: "12px 0",
                  borderBottom: "1px solid var(--color-divider)",
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--color-text)" }}>{e.name}</span>
                <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--color-neutral-600)" }}>{e.desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div
          data-reveal=""
          style={{
            background: "#0D1446",
            borderRadius: 14,
            overflow: "hidden",
            boxShadow: "0 30px 60px -30px rgba(35,35,80,0.5)",
          }}
        >
          <div style={{ display: "flex", gap: 8, padding: "14px 18px", borderBottom: "1px solid #2C2C47" }}>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: "#3A3A5A" }} />
            ))}
          </div>
          <pre
            style={{
              margin: 0,
              padding: "20px 22px",
              overflowX: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              lineHeight: 1.75,
              color: "#C8C9E4",
            }}
          >
            {CODE}
          </pre>
        </div>
      </div>
    </Section>
  );
}


/* ── pricing ───────────────────────────────────────────────────────────── */

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


/* ── closing call ──────────────────────────────────────────────────────── */

function StartCta() {
  return (
    <section
      id="start"
      className="on-dark"
      style={{ position: "relative", background: "#16206A", overflow: "hidden" }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.05) 1px,transparent 1px)",
          backgroundSize: "56px 56px",
          WebkitMaskImage: "radial-gradient(ellipse 70% 80% at 50% 40%,#000 20%,transparent 80%)",
          maskImage: "radial-gradient(ellipse 70% 80% at 50% 40%,#000 20%,transparent 80%)",
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          top: "10%",
          width: "70%",
          height: "80%",
          transform: "translateX(-50%)",
          background: "radial-gradient(closest-side,rgba(205,148,230,0.35),transparent)",
          pointerEvents: "none",
        }}
      />
      <div
        className="mx-auto"
        style={{
          position: "relative",
          maxWidth: PAGE_W,
          padding: "clamp(88px,11vw,150px) clamp(18px,4vw,40px) clamp(64px,8vw,104px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
        }}
      >
        <div
          data-reveal=""
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "7px 14px 7px 10px",
            borderRadius: 999,
            background: "rgba(255,255,255,0.14)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.22)",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--color-danger)",
              boxShadow: "0 0 0 4px rgba(229,72,77,0.25)",
            }}
          />
          Test mode included &middot; no real USDC charged
        </div>
        <h2
          data-reveal=""
          style={{
            margin: "26px 0 0",
            fontWeight: 800,
            fontSize: "clamp(44px,7vw,96px)",
            lineHeight: 0.98,
            letterSpacing: "-0.05em",
            maxWidth: "14ch",
            textWrap: "balance",
          }}
        >
          Your first renewal is{" "}
          <span style={{ color: "#CD94E6", fontStyle: "italic", paddingRight: "0.08em" }}>one signature</span> away.
        </h2>
        <p
          data-reveal=""
          style={{
            margin: "24px 0 0",
            fontSize: "clamp(16px,1.4vw,18.5px)",
            lineHeight: 1.6,
            color: "rgba(255,255,255,0.88)",
            maxWidth: "44ch",
          }}
        >
          Create a plan, share the checkout, and let renewals settle themselves on Arc.
        </p>
        <div data-reveal="" style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 12, marginTop: 34 }}>
          <Link to="/signup" style={{ ...CTA_STYLE, fontSize: 15, padding: "14px 28px" }}>
            Create your first plan
          </Link>
          <a href={DOCS_URL} style={{ ...GHOST_STYLE, fontSize: 15, fontWeight: 600, padding: "14px 22px", borderRadius: 9 }}>
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}


/* ── footer ────────────────────────────────────────────────────────────── */

function Footer() {
  const link: CSSProperties = { color: "var(--color-neutral-700)" };
  return (
    <footer
      className="on-dark"
      style={{ background: "#121A5C", borderTop: "1px solid rgba(255,255,255,0.18)", padding: "26px 0" }}
    >
      <div
        className="mx-auto flex w-full flex-wrap items-center"
        style={{ maxWidth: PAGE_W, paddingInline: "clamp(18px,4vw,40px)", gap: "10px 26px", fontSize: 13.5 }}
      >
        <span className="flex items-center" style={{ gap: 9, color: "var(--color-text)", fontWeight: 700 }}>
          <SweepMark size={20} />
          Sweep Console
        </span>
        <span style={{ marginLeft: "auto", display: "flex", flexWrap: "wrap", gap: "10px 22px" }}>
          <a href={DOCS_URL} style={link}>Documentation</a>
          <Link to="/login" style={link}>Log in</Link>
          <Link to="/signup" style={link}>Get started</Link>
        </span>
      </div>
    </footer>
  );
}


/* ── the page ──────────────────────────────────────────────────────────── */

export function LandingPage() {
  const reduced = usePrefersReducedMotion();
  useScrollReveal(reduced);

  return (
    <div style={{ background: "#121A5C" }}>
      <Header />
      <main className="swp-in">
        {/*
          v4's band order. Navy is the page; the light bands are cut into it,
          and they alternate on purpose — two light sections in a row read as
          one long section.

            top         #121A5C
            how         #121A5C
            fallback    #0D1446   deepest, it is the demo
            demo        #E9EEFF
            features    #121A5C
            compare     #121A5C
            trust       #E9EEFF
            developers  #F4F4FB
            pricing     #ffffff   KEPT against v4 — it states the fee
            start       #16206A
        */}
        <Hero />
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

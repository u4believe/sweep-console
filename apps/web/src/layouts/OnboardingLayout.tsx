import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Logo } from "@/components/ui/Logo";

/**
 * The onboarding shell: an accent-filled aside carrying the whole journey, and
 * a content column for the step in hand.
 *
 * The four steps below are the real path a new merchant walks — account,
 * verified email, payout wallet, first plan — but they are spread across
 * several routes in this app rather than one wizard. The aside therefore
 * reflects progress, and the column renders whichever step the route owns.
 *
 * Two deliberate departures from the design canvas: the multi-route split
 * above (steps 03 and 04 render inside the portal, not this shell), and the
 * absence of the canvas's "Skip to console" escape — every step here is a
 * prerequisite for taking money, so there is nothing worth skipping to.
 * The canvas's "Back" is kept, as `back` below: skipping the flow and
 * correcting an answer inside it are different things.
 */

export const ONBOARDING_STEPS = [
  { n: "01", title: "Create your account", hint: "Email and company name" },
  { n: "02", title: "Verify your email", hint: "Six-digit code, or instant with Google" },
  { n: "03", title: "Link a payout wallet", hint: "Settlements go straight to it" },
  { n: "04", title: "Publish your first plan", hint: "Get a shareable checkout link" },
] as const;

/**
 * The way back out of a step. Because the flow is split across routes, "the
 * previous step" is a different thing on each page — sometimes a route, some-
 * times a state change on the page itself — so each caller names its own.
 * Omit it where there is genuinely nothing behind the current step.
 */
export interface OnboardingBack {
  /** Route to return to. Ignored when `onClick` is given. */
  to?: string;
  /** Use when going back means undoing state rather than changing route. */
  onClick?: () => void;
  /** Say what the merchant gets to change; defaults to a plain "Back". */
  label?: string;
}

function BackArrow() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" style={{ flex: "none" }}>
      <path
        d="M8.5 3 L3.5 8 L8.5 13 M3.5 8 H13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

export function OnboardingLayout({
  step,
  kicker,
  title,
  body,
  back,
  children,
}: {
  /** 1-based index of the active step. */
  step: number;
  kicker: string;
  title: string;
  body: string;
  back?: OnboardingBack;
  children: ReactNode;
}) {
  const backStyle = {
    alignSelf: "flex-start",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 20,
    padding: "4px 0",
    fontSize: 13,
    color: "var(--color-neutral-700)",
  } as const;

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.25fr]">
      <aside
        className="flex flex-col"
        style={{ background: "var(--color-accent)", color: "var(--color-bg)", padding: "40px 36px" }}
      >
        <Link
          to="/"
          className="flex items-center gap-2.5"
          style={{ marginBottom: 56, color: "var(--color-bg)" }}
        >
          <Logo height={24} fill="var(--color-bg)" />
          <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 16 }}>
            Sweep Console
          </span>
        </Link>

        <h2
          className="m-0"
          style={{
            fontSize: "clamp(32px, 4vw, 46px)", lineHeight: 0.98,
            letterSpacing: "-0.035em", marginBottom: 20,
          }}
        >
          Four steps to your first renewal.
        </h2>

        <div style={{ borderTop: "2px solid rgba(243,242,242,.35)", marginTop: "auto" }}>
          {ONBOARDING_STEPS.map((s, i) => (
            <div
              key={s.n}
              className="grid gap-3"
              style={{
                gridTemplateColumns: "34px 1fr",
                padding: "16px 0",
                borderBottom: "1px solid rgba(243,242,242,.28)",
                opacity: i + 1 === step ? 1 : i + 1 < step ? 0.75 : 0.45,
              }}
            >
              <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>{s.n}</span>
              <div>
                <p className="m-0" style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 15 }}>
                  {s.title}
                </p>
                <p className="m-0" style={{ marginTop: 2, fontSize: 12, opacity: 0.85 }}>{s.hint}</p>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="flex flex-col" style={{ padding: "40px 48px", background: "var(--color-bg)" }}>
        {back &&
          (back.onClick ? (
            <button type="button" className="btn btn-ghost" style={backStyle} onClick={back.onClick}>
              <BackArrow />
              {back.label ?? "Back"}
            </button>
          ) : (
            <Link to={back.to ?? "/"} className="btn btn-ghost" style={backStyle}>
              <BackArrow />
              {back.label ?? "Back"}
            </Link>
          ))}

        <div className="mb-8 flex flex-wrap items-center gap-2.5">
          {ONBOARDING_STEPS.map((s, i) => (
            <span
              key={s.n}
              style={{
                height: 3,
                width: 56,
                background: i + 1 <= step ? "var(--color-accent)" : "var(--color-neutral-300)",
              }}
            />
          ))}
          <span
            className="uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-neutral-600)", marginLeft: 8 }}
          >
            Step {step} of {ONBOARDING_STEPS.length}
          </span>
        </div>

        {/* Keyed on the step so the entrance replays as the merchant advances. */}
        <div key={step} className="swp-in" style={{ maxWidth: 520, animationDuration: "0.28s" }}>
          <p
            className="m-0 uppercase"
            style={{ fontSize: 10, letterSpacing: "0.16em", color: "var(--color-accent)", marginBottom: 8 }}
          >
            {kicker}
          </p>
          <h1
            className="m-0"
            style={{ fontSize: "clamp(28px, 4vw, 40px)", letterSpacing: "-0.03em", lineHeight: 1.02, marginBottom: 10 }}
          >
            {title}
          </h1>
          <p
            className="m-0"
            style={{ fontSize: 14.5, color: "var(--color-neutral-800)", marginBottom: 28, lineHeight: 1.6 }}
          >
            {body}
          </p>

          {children}
        </div>
      </main>
    </div>
  );
}

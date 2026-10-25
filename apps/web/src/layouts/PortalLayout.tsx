import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { SweepMark } from "@/components/ui/marks";
import { StepUpDialog } from "@/components/portal/StepUpDialog";

// The two dashboards. Facts about this product rather than configuration —
// a variable for them is one more thing that can point at the wrong network.
const LIVE_SITE_URL = "https://www.sweepconsole.xyz";
const SANDBOX_SITE_URL = "https://sandbox.sweepconsole.xyz";

/**
 * The hosted side, which every account has.
 */
const NAV_HOSTED = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/plans", label: "Plans" },
  { href: "/subscriptions", label: "Subscriptions" },
  { href: "/payments", label: "Payments" },
];

/** The rail's own destinations, once the account has it. */
const NAV_RAIL = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/rail/mandates", label: "Mandates" },
  { href: "/rail/charges", label: "Charges" },
];

/// Shown instead, while the account cannot use the rail: the page that asks.
const NAV_RAIL_LOCKED = [{ href: "/rail", label: "Payment rail" }];

const NAV_TAIL = [
  { href: "/webhooks", label: "Webhooks" },
  { href: "/api-keys", label: "API Keys" },
  { href: "/settings", label: "Settings" },
];

/**
 * Which half of the product the console is pointed at.
 *
 * The design carries this as a real control — a scope banner naming the
 * current flow with a link to the other, and a sidebar that changes with it.
 * I previously read it as a mockup toggle demonstrating two customer types
 * and left it out; it is a feature, and this is it.
 *
 * It is a VIEW, not an entitlement. Rail access is granted on top of a hosted
 * account and a merchant can run both, so switching scope changes what the
 * sidebar offers and nothing else — every route stays reachable, and landing
 * on one belonging to the other scope switches to it rather than showing a
 * page the nav denies.
 */
type Scope = "hosted" | "rail";
const SCOPE_KEY = "sweep.console.scope";

const SCOPE_COPY: Record<Scope, { label: string; note: string; other: Scope; switchTo: string }> = {
  hosted: {
    label: "Hosted subscriptions",
    note: "Plans, subscribers and renewals on the checkout we host.",
    other: "rail",
    switchTo: "Switch to the payment rail",
  },
  rail: {
    label: "Payment rail",
    note: "Mandates, charges and keys for checkouts you build yourself.",
    other: "hosted",
    switchTo: "Switch to hosted subscriptions",
  },
};

/// Which scope a path belongs to, or null when it belongs to both.
function scopeOf(pathname: string): Scope | null {
  if (pathname.startsWith("/rail")) return "rail";
  if (["/plans", "/subscriptions", "/payments"].some((p) => pathname.startsWith(p))) return "hosted";
  return null;
}

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/// Appended only for operator accounts. Hiding it is presentation, not security:
/// every admin route answers 404 to a non-admin regardless of what the nav shows.
const ADMIN_NAV = [
  { href: "/admin/rail", label: "Rail access" },
  { href: "/admin/treasury", label: "Balances" },
];

/** Two letters for the avatar, from whatever the account actually has. */
function initials(nameOrEmail: string | undefined): string {
  if (!nameOrEmail) return "··";
  const local = nameOrEmail.split("@")[0] ?? nameOrEmail;
  const parts = local.split(/[.\-_\s]+/).filter(Boolean);
  const take = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : local.slice(0, 2);
  return take.toUpperCase();
}

/**
 * The portal shell — the v2 sidebar.
 *
 * Replaces the Modernist top-nav variant entirely. That one organised with
 * rules: a sticky header closed by a 2px line, tabs underlined in accent,
 * nothing rounded and nothing floating. This one organises with a surface —
 * a 236px rail in neutral-100 against a white page, items that round and tint
 * on hover, and the identity sitting at the bottom of the rail rather than
 * across the top of the page.
 *
 * Below `lg` the rail becomes a sticky top bar with the same three parts in a
 * row, because 236px of chrome on a phone is most of the screen. The design
 * draws that as a second state (`narrow`); here it is a media query, so it
 * follows the viewport rather than a prop someone has to remember to set.
 */
export function PortalLayout() {
  const [isAdmin, setIsAdmin] = useState(false);
  /**
   * Undefined until /portal/me answers.
   *
   * Three states, not two: a `false` default would show "Payment rail" to
   * every account for a moment and then swap it for two different tabs,
   * moving the nav under a cursor already travelling towards it. Unknown
   * shows neither.
   */
  const [railEnabled, setRailEnabled] = useState<boolean | undefined>(undefined);

  const [mode, setMode] = useState<{ testMode: boolean; isLive: boolean } | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/portal/me`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: { isAdmin?: boolean; testMode?: boolean; isLive?: boolean; railEnabled?: boolean } }) => {
        setIsAdmin(!!json.data?.isAdmin);
        if (json.data) {
          setMode({ testMode: json.data.testMode !== false, isLive: !!json.data.isLive });
          setRailEnabled(!!json.data.railEnabled);
        }
      })
      .catch(() => setIsAdmin(false));
  }, []);

  /**
   * Operator screens are live-only, so they are not offered on the sandbox.
   *
   * Both answer 409 there: rail access is unrestricted on testnet so there is
   * nothing to approve, and platform balances on Sepolia mean nothing. A tab
   * that only ever errors is worse than no tab.
   */
  const showAdmin = isAdmin && mode?.testMode === false;

  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  /**
   * The remembered scope, corrected by where the person actually is.
   *
   * The route wins over the stored preference: someone following a link to
   * /payments while the console last sat in rail scope should see the hosted
   * sidebar, not a page their own nav disowns. Only paths that belong to
   * exactly one scope move it — /dashboard, /settings and the rest belong to
   * both and leave it alone.
   */
  const [scope, setScope] = useState<Scope>(() => {
    try {
      return localStorage.getItem(SCOPE_KEY) === "rail" ? "rail" : "hosted";
    } catch {
      return "hosted"; // private mode, blocked storage — the default is fine
    }
  });

  useEffect(() => {
    const belongs = scopeOf(pathname);
    if (belongs && belongs !== scope) setScope(belongs);
  }, [pathname, scope]);

  const chooseScope = (next: Scope) => {
    setScope(next);
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* the console still works; it just forgets between visits */
    }
    navigate(next === "rail" ? (railEnabled ? "/rail/charges" : "/rail") : "/dashboard");
  };

  /**
   * An account with no rail access is not offered the scope at all.
   *
   * It would switch to a single page asking to be let in, which is not a
   * half of the product — it is a request form, and it stays in the nav
   * where it already was.
   */
  const canSwitch = railEnabled === true;
  const effectiveScope: Scope = canSwitch ? scope : "hosted";

  const nav = [
    ...(effectiveScope === "rail" ? NAV_RAIL : NAV_HOSTED),
    ...(canSwitch || railEnabled === undefined ? [] : NAV_RAIL_LOCKED),
    ...NAV_TAIL,
    ...(showAdmin ? ADMIN_NAV : []),
  ];

  /**
   * An item is lit on its own path and anything beneath it, so "Plans" stays
   * lit on /plans/new and /plans/:planId.
   *
   * Whole paths, not the leading segment: the segment worked while every item
   * was one level deep, and "Mandates" at /rail/mandates would have compared
   * "rail" against "rail/mandates" and never lit at all.
   */
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  /**
   * Which deployment this is, and a way to the other one.
   *
   * The design draws this as a switch that sets state. Ours cannot be: the
   * mode follows the DEPLOYMENT, so changing it means changing site. A
   * session-set mode allowed test mode on the live deployment, where every
   * Circle call uses the live key and a test payout wallet comes back 404.
   * So the inactive half is a link, and the active half is not a control at
   * all.
   */
  const modeSwitch = mode && (
    <div
      className="flex"
      style={{
        padding: 4,
        gap: 4,
        background: "var(--color-track)",
        borderRadius: 10,
      }}
    >
      {([true, false] as const).map((isTest) => {
        const here = mode.testMode === isTest;
        const label = isTest ? "Test mode" : "Live";
        const sub = isTest ? "No real USDC" : "Real payments";
        const inner = (
          <>
            <span style={{ fontSize: 13, fontWeight: 700, color: here ? "#fff" : "var(--color-neutral-800)" }}>
              {label}
            </span>
            <span style={{ fontSize: 11, color: here ? "rgba(255,255,255,0.72)" : "var(--color-neutral-700)" }}>
              {sub}
            </span>
          </>
        );
        const box = {
          flex: 1,
          display: "flex",
          flexDirection: "column" as const,
          alignItems: "flex-start" as const,
          gap: 1,
          textAlign: "left" as const,
          borderRadius: 7,
          padding: "8px 10px",
          textDecoration: "none",
          background: here ? "var(--color-accent)" : "transparent",
          boxShadow: here ? "0 4px 10px -4px rgba(68,71,214,0.6)" : "none",
          transition: "background 160ms ease",
        };
        return here ? (
          <span key={label} style={box} aria-current="true">{inner}</span>
        ) : (
          <a
            key={label}
            href={isTest ? SANDBOX_SITE_URL : LIVE_SITE_URL}
            style={box}
            title={`Open the ${isTest ? "sandbox" : "live"} dashboard`}
          >
            {inner}
          </a>
        );
      })}
    </div>
  );

  const navButtons = nav.map((item) => {
    const active = isActive(item.href);
    return (
      <button
        key={item.href}
        type="button"
        onClick={() => navigate(item.href)}
        aria-current={active ? "page" : undefined}
        className="swp-navitem cursor-pointer"
        style={{
          textAlign: "left",
          font: "inherit",
          fontSize: 14,
          fontWeight: 500,
          border: 0,
          borderRadius: 7,
          padding: "9px 12px",
          whiteSpace: "nowrap",
          color: active ? "var(--color-accent)" : "var(--color-neutral-800)",
          background: active ? "var(--color-accent-200)" : "transparent",
        }}
      >
        {item.label}
      </button>
    );
  });

  const brand = (
    <button
      type="button"
      onClick={() => navigate("/")}
      className="flex cursor-pointer items-center gap-2.5 text-left"
      style={{ background: "transparent", border: 0, padding: 0, color: "var(--color-text)" }}
    >
      <SweepMark size={22} />
      <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 15, letterSpacing: "-0.02em" }}>
        Sweep Console
      </span>
    </button>
  );

  return (
    <div
      className="flex min-h-screen flex-col lg:flex-row"
      // The accent follows the scope — see [data-scope="rail"] in sweep.css.
      // Set here rather than branched at each component so everything already
      // reading var(--color-accent) changes with it.
      data-scope={effectiveScope}
      style={{ background: "var(--color-bg)" }}
    >
      {/* ── Wide: the rail ─────────────────────────────────────────────── */}
      <aside
        className="hidden lg:flex"
        style={{
          width: 236,
          flex: "none",
          flexDirection: "column",
          gap: 2,
          padding: "20px 14px",
          background: "var(--color-neutral-100)",
          borderRight: "1px solid var(--color-divider)",
          position: "sticky",
          top: 0,
          height: "100vh",
        }}
      >
        <div style={{ padding: "4px 10px 22px" }}>{brand}</div>
        <div style={{ margin: "0 0 14px" }}>{modeSwitch}</div>
        {navButtons}

        {/* Identity at the foot of the rail, not across the top of the page.
            `margin-top:auto` is what pins it there however long the nav is. */}
        <div
          className="flex items-center"
          style={{
            marginTop: "auto",
            gap: 10,
            padding: "12px 10px",
            borderTop: "1px solid var(--color-divider)",
            minWidth: 0,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 30, height: 30, flex: "none", borderRadius: "50%",
              background: "var(--color-accent-200)", color: "var(--color-accent)",
              display: "grid", placeItems: "center", fontWeight: 700, fontSize: 13,
            }}
          >
            {initials(user?.email)}
          </span>
          <span style={{ fontSize: 13, lineHeight: 1.3, minWidth: 0 }}>
            <span className="block truncate" style={{ fontWeight: 600 }}>{user?.email}</span>
            <button
              type="button"
              onClick={() => void logout()}
              className="cursor-pointer"
              style={{
                background: "transparent", border: 0, padding: 0, font: "inherit",
                fontSize: 12, color: "var(--color-neutral-700)",
              }}
            >
              Log out
            </button>
          </span>
        </div>
      </aside>

      {/* ── Narrow: the same three parts, stacked ──────────────────────── */}
      <header
        className="lg:hidden sticky top-0"
        style={{ zIndex: 30, background: "var(--color-bg)", borderBottom: "1px solid var(--color-divider)" }}
      >
        <div className="flex items-center" style={{ gap: 10, padding: "14px 18px" }}>
          {brand}
          <button
            type="button"
            onClick={() => void logout()}
            className="ml-auto cursor-pointer shrink-0"
            style={{
              background: "transparent", border: 0, font: "inherit",
              fontSize: 12, color: "var(--color-neutral-700)",
            }}
          >
            Log out
          </button>
        </div>
        <div style={{ padding: "0 12px 10px" }}>{modeSwitch}</div>
        {/* Scroll rather than wrap — a wrapped second row shifts every screen
            down by a line at exactly the widths where space is tightest. */}
        <div className="flex" style={{ gap: 4, overflowX: "auto", padding: "0 12px 10px" }}>
          {navButtons}
        </div>
      </header>

      <div className="min-w-0 flex-1" style={{ background: "var(--color-bg)" }}>
        {/*
          The scope banner: which half of the product this is, and the way to
          the other. The design puts it at the head of the content rather than
          in the rail, so it reads as a statement about what is below it.

          Only for an account that has both. One that does not has nothing to
          switch to, and a banner announcing "Hosted subscriptions" to someone
          who has only ever had that is noise.
        */}
        {/*
          Which money this is. On every console page, because the one thing a
          person must never be wrong about is whether the amounts in front of
          them are real.
        */}
        {mode && (
          <div className="swp-modebar" data-mode={mode.testMode ? "test" : "live"}>
            {mode.testMode
              ? "Test mode — no real USDC is moving."
              : "Live mode — charges move real USDC."}
          </div>
        )}

        {/*
          The scope strip. Only for an account that has both: one that does
          not has nothing to switch to, and announcing "Hosted subscriptions"
          to someone who has only ever had that is noise.
        */}
        {canSwitch && (
          <div className="swp-scopebar">
            <span
              className="tag"
              style={{
                background: effectiveScope === "rail" ? "var(--color-text)" : "var(--color-accent-200)",
                color: effectiveScope === "rail" ? "var(--color-bg)" : "var(--color-accent)",
              }}
            >
              {SCOPE_COPY[effectiveScope].label}
            </span>
            <span style={{ fontSize: 13.5, color: "var(--color-neutral-800)" }}>
              {SCOPE_COPY[effectiveScope].note}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginLeft: "auto", fontSize: 13.5, color: "var(--color-accent)" }}
              onClick={() => chooseScope(SCOPE_COPY[effectiveScope].other)}
            >
              {SCOPE_COPY[effectiveScope].switchTo} →
            </button>
          </div>
        )}

        {/* Keyed on the route so each screen plays the system's entrance. */}
        <main key={pathname} className="min-w-0 swp-in">
          <Outlet />
        </main>
      </div>

      {/* Mounted once for the whole portal. Any guarded request, on any screen,
          opens this — see lib/stepup.ts. Outside <main> so the route key above
          cannot unmount it mid-confirmation. */}
      <StepUpDialog />
    </div>
  );
}

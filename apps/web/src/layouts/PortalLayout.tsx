import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { Logo } from "@/components/ui/Logo";
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

/**
 * The rail, once the account has it.
 *
 * The design draws these as a SEPARATE console — a rail merchant sees
 * Dashboard · Mandates · Charges and no Plans at all. That is a demo toggle
 * in the mockup (`flow === 'rail'`) showing two kinds of customer, and this
 * product does not work that way: rail access is a grant on top of a hosted
 * account, and a merchant can run both. So these are added to the hosted
 * items rather than replacing them.
 */
const NAV_RAIL = [
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
  const railNav = railEnabled === undefined ? [] : railEnabled ? NAV_RAIL : NAV_RAIL_LOCKED;
  const nav = [...NAV_HOSTED, ...railNav, ...NAV_TAIL, ...(showAdmin ? ADMIN_NAV : [])];

  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

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
      <Logo height={22} />
      <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 15, letterSpacing: "-0.02em" }}>
        Sweep Console
      </span>
    </button>
  );

  return (
    <div className="flex min-h-screen flex-col lg:flex-row" style={{ background: "var(--color-bg)" }}>
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

      {/* Keyed on the route so each screen plays the system's entrance. */}
      <main key={pathname} className="min-w-0 flex-1 swp-in" style={{ background: "var(--color-bg)" }}>
        <Outlet />
      </main>

      {/* Mounted once for the whole portal. Any guarded request, on any screen,
          opens this — see lib/stepup.ts. Outside <main> so the route key above
          cannot unmount it mid-confirmation. */}
      <StepUpDialog />
    </div>
  );
}

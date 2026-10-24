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
 *
 * They were one "Payment rail" tab holding two tables behind a sub-tab.
 * Promoting them matches the design's intent — these are destinations a rail
 * merchant lives in, not a section they visit — without inventing an
 * either/or the account model does not have.
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

/**
 * The portal shell — the Modernist top-nav variant.
 *
 * Structure is load-bearing here: a sticky header closed by a 2px rule, an
 * identity row above a 1px rule, and tabs that mark the active section with a
 * 3px accent underline. Nothing is rounded and nothing floats; the rules do the
 * organising. The design carries a sidebar variant of this same shell — see
 * `dashboardShell` in the canvas — and the two are interchangeable because the
 * screens below make no assumption about which is mounted.
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
  const railNav =
    railEnabled === undefined ? [] : railEnabled ? NAV_RAIL : NAV_RAIL_LOCKED;
  const nav = [
    ...NAV_HOSTED,
    ...railNav,
    ...NAV_TAIL,
    ...(showAdmin ? ADMIN_NAV : []),
  ];

  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  /**
   * A tab is lit on its own path and on anything beneath it, so "Plans" stays
   * lit on /plans/new and /plans/:planId. Laid out horizontally, an unlit tab
   * bar on a child route reads as "nowhere" far more loudly than it did in
   * the rail.
   *
   * This compares whole paths rather than the leading segment, which it used
   * to. The segment worked while every tab was one level deep; "Mandates" at
   * /rail/mandates would have compared "rail" against "rail/mandates" and
   * never lit at all.
   */
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--color-bg)" }}>
      <header
        className="sticky top-0"
        style={{
          zIndex: 30,
          background: "var(--color-bg)",
          borderBottom: "1px solid var(--color-divider)",
        }}
      >
        {/* Identity row */}
        <div className="flex items-center" style={{ gap: 14, padding: "14px 32px" }}>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="flex cursor-pointer items-center gap-2.5 text-left"
            style={{ background: "transparent", border: 0, padding: 0 }}
          >
            <Logo height={21} />
            <span
              style={{
                fontFamily: "var(--font-heading)",
                fontWeight: 700,
                fontSize: 15,
                letterSpacing: "-0.02em",
              }}
            >
              Sweep Console
            </span>
          </button>

          {/* Which deployment this is, and a way to the other one.
              It sits beside the wordmark, where a hardcoded "Test mode" badge
              used to be — that one said "Test mode" on the live site too,
              which is the single place it must never say.
              Not a switch: the mode follows the deployment, so changing it
              means changing site. A session-set mode allowed test mode on the
              live deployment, where every Circle call uses the live key and a
              test payout wallet comes back 404. */}
          {mode && (
            <div
              className="flex shrink-0 items-center"
              style={{ border: "1px solid var(--color-divider)", marginLeft: 10 }}
            >
              {([true, false] as const).map((isTest) => {
                const here = mode.testMode === isTest;
                const href = isTest ? SANDBOX_SITE_URL : LIVE_SITE_URL;
                const label = isTest ? "Test" : "Live";
                const style = {
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase" as const,
                  padding: "5px 11px",
                  background: here ? "var(--color-text)" : "transparent",
                  color: here ? "var(--color-ground)" : "var(--color-neutral-700)",
                  textDecoration: "none",
                };
                return here ? (
                  <span key={label} style={style}>{label}</span>
                ) : (
                  <a key={label} href={href} style={style} title={`Open the ${label.toLowerCase()} dashboard`}>
                    {label}
                  </a>
                );
              })}
            </div>
          )}

          <span
            className="ml-auto truncate"
            style={{ fontSize: 12, color: "var(--color-neutral-800)", minWidth: 0 }}
          >
            {user?.email}
          </span>
          <button
            type="button"
            className="btn btn-ghost shrink-0"
            style={{ fontSize: 12, color: "var(--color-neutral-700)" }}
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </div>

        {/* Section tabs. Scroll rather than wrap — a wrapped second row would
            shift every screen down by a line at narrow widths. */}
        <nav
          className="flex"
          style={{
            borderTop: "1px solid var(--color-divider)",
            padding: "0 32px",
            overflowX: "auto",
          }}
        >
          {nav.map((item) => {
            const active = isActive(item.href);
            return (
              <button
                key={item.href}
                type="button"
                onClick={() => navigate(item.href)}
                aria-current={active ? "page" : undefined}
                className="cursor-pointer"
                style={{
                  background: "transparent",
                  border: 0,
                  borderBottom: `3px solid ${active ? "var(--color-accent)" : "transparent"}`,
                  color: active ? "var(--color-text)" : "var(--color-neutral-700)",
                  padding: "11px 16px 9px",
                  fontFamily: "var(--font-body)",
                  fontSize: 13.5,
                  whiteSpace: "nowrap",
                }}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Keyed on the route so each screen plays the system's entrance. */}
      <main key={pathname} className="min-w-0 swp-in" style={{ background: "var(--color-bg)" }}>
        <Outlet />
      </main>

      {/* Mounted once for the whole portal. Any guarded request, on any screen,
          opens this — see lib/stepup.ts. Outside <main> so the route key above
          cannot unmount it mid-confirmation. */}
      <StepUpDialog />
    </div>
  );
}

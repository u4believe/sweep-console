import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { Logo } from "@/components/ui/Logo";
import { StepUpDialog } from "@/components/portal/StepUpDialog";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/plans", label: "Plans" },
  { href: "/subscriptions", label: "Subscriptions" },
  { href: "/payments", label: "Payments" },
  { href: "/webhooks", label: "Webhooks" },
  { href: "/api-keys", label: "API Keys" },
  { href: "/settings", label: "Settings" },
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
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Match on the leading segment, not the whole path, so "Plans" stays lit on
  // /plans/new and /plans/:planId. Laid out horizontally, an unlit tab bar on a
  // child route reads as "nowhere" far more loudly than it did in the rail.
  const section = pathname.split("/")[1] ?? "";

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--color-bg)" }}>
      <header
        className="sticky top-0"
        style={{
          zIndex: 30,
          background: "var(--color-bg)",
          borderBottom: "2px solid var(--color-divider)",
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
                fontWeight: 800,
                fontSize: 15,
                letterSpacing: "-0.02em",
              }}
            >
              Sweep Console
            </span>
          </button>

          <span className="tag tag-accent" style={{ marginLeft: 6 }}>Test mode</span>

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
          {NAV.map((item) => {
            const active = section === item.href.slice(1);
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

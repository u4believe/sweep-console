import { Link, Outlet } from "react-router-dom";
import { Logo } from "@/components/ui/Logo";

/**
 * The shell for returning-user pages — login, forgot password, reset password.
 *
 * These are not onboarding, so they don't carry the four-step aside; they get a
 * single ruled column on the ground. Signup and email verification DO belong to
 * onboarding and render OnboardingLayout themselves.
 */
export function AuthLayout() {
  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--color-bg)" }}>
      <header
        className="flex items-center"
        style={{ padding: "18px 40px", borderBottom: "2px solid var(--color-divider)" }}
      >
        <Link to="/" className="flex items-center gap-2.5" style={{ color: "var(--color-text)" }}>
          <Logo height={22} />
          <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 16, letterSpacing: "-0.02em" }}>
            Sweep Console
          </span>
        </Link>
      </header>

      <main className="flex flex-1 justify-center" style={{ padding: "56px 32px" }}>
        <div style={{ width: "100%", maxWidth: 420 }}>
          <Outlet />
        </div>
      </main>

      <footer
        className="flex flex-wrap items-center gap-6"
        style={{ padding: "24px 40px", fontSize: 12, color: "var(--color-neutral-700)" }}
      >
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, color: "var(--color-text)" }}>
          Sweep Console
        </span>
        <span className="ml-auto">Payment infrastructure for on-chain recurring revenue</span>
      </footer>
    </div>
  );
}

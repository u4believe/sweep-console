import { useState, useId } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { Turnstile, TURNSTILE_ENABLED } from "@/components/Turnstile";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [captcha, setCaptcha] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);
  const passwordId = useId();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(e.currentTarget);
    try {
      await login(form.get("email") as string, form.get("password") as string, remember, captcha);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setCaptchaReset((n) => n + 1); // token is single-use — mint a fresh one
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p
        className="m-0 uppercase"
        style={{ fontSize: 10, letterSpacing: "0.16em", color: "var(--color-accent)", marginBottom: 8 }}
      >
        Welcome back
      </p>
      <h1 className="m-0" style={{ fontSize: 34, letterSpacing: "-0.03em", lineHeight: 1.05, marginBottom: 8 }}>
        Sign in to your console.
      </h1>
      <p className="m-0" style={{ fontSize: 14, color: "var(--color-neutral-800)", marginBottom: 24 }}>
        Manage plans, subscribers and settlement.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4" style={{ borderTop: "2px solid var(--color-divider)", paddingTop: 20 }}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            className="input"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>

        <div className="field">
          <label htmlFor={passwordId}>Password</label>
          <div className="flex gap-2">
            <input
              id={passwordId}
              name="password"
              className="input"
              type={showPassword ? "text" : "password"}
              required
              autoComplete="current-password"
              placeholder="••••••••"
            />
            <button
              type="button"
              className="btn btn-secondary shrink-0"
              style={{ padding: "6px 12px", fontSize: 12 }}
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2" style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              style={{ accentColor: "var(--color-accent)", width: 15, height: 15 }}
            />
            Remember me
          </label>
          <Link to="/forgot-password" style={{ fontSize: 13, color: "var(--color-accent)" }}>
            Forgot password?
          </Link>
        </div>

        <Turnstile onVerify={setCaptcha} onExpire={() => setCaptcha("")} resetSignal={captchaReset} />

        {error && (
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{error}</p>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-block"
          style={{ padding: "12px 20px", justifyContent: "center" }}
          disabled={loading || (TURNSTILE_ENABLED && !captcha)}
        >
          {loading ? "Signing in…" : "Log in"}
        </button>

        <div
          className="flex flex-wrap items-center gap-3"
          style={{ borderTop: "1px solid var(--color-divider)", paddingTop: 16 }}
        >
          <GoogleButton label="Continue with Google" next={next} remember={remember} onError={setError} />
        </div>

        <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
          No account?{" "}
          <Link to="/signup" style={{ color: "var(--color-accent)" }}>Create one</Link>
        </p>
      </form>
    </div>
  );
}

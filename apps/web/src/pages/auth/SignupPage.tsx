import { useState } from "react";
import { Link } from "react-router-dom";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { Turnstile, TURNSTILE_ENABLED } from "@/components/Turnstile";
import { OnboardingLayout } from "@/layouts/OnboardingLayout";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/** Step 01 of onboarding — create the account. */
export function SignupPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [captcha, setCaptcha] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(e.currentTarget);
    const res = await fetch(`${API_URL}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), turnstileToken: captcha }),
    });
    let data: { error?: { message?: string } } = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setLoading(false);
    if (!res.ok) {
      setError(data.error?.message ?? "Something went wrong. Please try again.");
      setCaptchaReset((n) => n + 1); // token is single-use — mint a fresh one
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <OnboardingLayout
        step={2}
        back={{ onClick: () => setSent(false), label: "Use a different email" }}
        kicker="Check your inbox"
        title="We've sent you a verification link."
        body="Open it to set your name and password and finish creating your account. Didn't arrive? Check your spam folder."
      >
        <div style={{ borderTop: "2px solid var(--color-divider)", paddingTop: 20 }}>
          <Link to="/login" className="btn btn-secondary" style={{ padding: "11px 18px" }}>
            Back to login
          </Link>
        </div>
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout
      step={1}
      back={{ to: "/", label: "Back to home" }}
      kicker="Create your account"
      title="Start accepting USDC subscriptions."
      body="We'll email you a link to set your name and password. Test mode is on by default — nothing is charged until you go live."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input
            id="email"
            name="email"
            className="input"
            type="email"
            required
            placeholder="you@example.com"
          />
        </div>

        <Turnstile onVerify={setCaptcha} onExpire={() => setCaptcha("")} resetSignal={captchaReset} />

        {error && (
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{error}</p>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          style={{ padding: "12px 20px", alignSelf: "flex-start" }}
          disabled={loading || (TURNSTILE_ENABLED && !captcha)}
        >
          {loading ? "Sending…" : "Send verification email"}
        </button>

        <div
          className="flex flex-wrap items-center gap-3"
          style={{ borderTop: "1px solid var(--color-divider)", paddingTop: 16 }}
        >
          <GoogleButton label="Continue with Google" onError={setError} />
          <span style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>
            Google accounts skip the email step.
          </span>
        </div>

        <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
          Already have an account?{" "}
          <Link to="/login" style={{ color: "var(--color-accent)" }}>Log in</Link>
        </p>
      </form>
    </OnboardingLayout>
  );
}

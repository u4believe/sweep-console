import { useState, useId, Suspense } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { OnboardingLayout } from "@/layouts/OnboardingLayout";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * Step 02 of onboarding — the email is proven by the link's token, so what's
 * left is naming the account and setting a password.
 */
function VerifyForm() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const passwordId = useId();
  const nameId = useId();

  if (!token) {
    return (
      <OnboardingLayout
        step={2}
        kicker="Verification"
        title="That link isn't valid."
        body="The verification link is missing its token, or has already been used. Request a fresh one from sign-up."
      >
        <div style={{ borderTop: "2px solid var(--color-divider)", paddingTop: 20 }}>
          <Link to="/signup" className="btn btn-primary" style={{ padding: "11px 18px" }}>
            Back to sign up
          </Link>
        </div>
      </OnboardingLayout>
    );
  }

  if (done) {
    return (
      <OnboardingLayout
        step={3}
        kicker="Account created"
        title="You're in. Next, link a payout wallet."
        body="Settlements go straight to your own wallet — Sweep Console never holds your balance. You can link it from Settings once you're signed in."
      >
        <div
          className="flex flex-wrap items-center gap-3"
          style={{ borderTop: "2px solid var(--color-divider)", paddingTop: 20 }}
        >
          <Link to="/login" className="btn btn-primary" style={{ padding: "12px 20px" }}>
            Log in
          </Link>
          <span style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>
            Then head to Settings to link your wallet.
          </span>
        </div>
      </OnboardingLayout>
    );
  }

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await fetch(`${API_URL}/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, password }),
    });
    let data: { error?: { message?: string } } = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setLoading(false);
    if (!res.ok) {
      setError(data.error?.message ?? "Verification failed. Please try again.");
      return;
    }
    setDone(true);
  }

  return (
    <OnboardingLayout
      step={2}
      // Going back means starting over with another address — the token in
      // this link is bound to the one already proven, so say so plainly.
      back={{ to: "/signup", label: "Use a different email" }}
      kicker="Email verified"
      title="Finish setting up."
      body="Add the name your subscribers will see at checkout, and a password for signing in."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="field">
          <label htmlFor={nameId}>Company name — shown to subscribers at checkout</label>
          <input
            id={nameId}
            className="input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Acme Inc."
          />
        </div>

        <div className="field">
          <label htmlFor={passwordId}>Password</label>
          <div className="flex gap-2">
            <input
              id={passwordId}
              className="input"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              placeholder="Min. 8 characters"
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

        {error && (
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{error}</p>
        )}

        <div style={{ borderTop: "2px solid var(--color-divider)", paddingTop: 20 }}>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ padding: "12px 20px" }}
            disabled={loading || password.length < 8 || name.trim().length === 0}
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </div>
      </form>
    </OnboardingLayout>
  );
}

export function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <OnboardingLayout step={2} kicker="Verification" title="Loading…" body="One moment.">
          <span />
        </OnboardingLayout>
      }
    >
      <VerifyForm />
    </Suspense>
  );
}

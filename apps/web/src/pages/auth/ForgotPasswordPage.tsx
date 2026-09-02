import { useState } from "react";
import { Link } from "react-router-dom";
import { Turnstile, TURNSTILE_ENABLED } from "@/components/Turnstile";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export function ForgotPasswordPage() {
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
    const res = await fetch(`${API_URL}/auth/forgot-password`, {
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
      <div style={{ textAlign: "left" }}>
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-100">
          <svg className="h-7 w-7 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <h2 className="m-0" style={{ fontSize: 30, letterSpacing: "-0.03em", lineHeight: 1.05 }}>Check your inbox</h2>
        <p className="m-0" style={{ marginTop: 8, fontSize: 14, color: "var(--color-neutral-800)" }}>
          If that email is registered, we&apos;ve sent a link to reset your password. The link expires in 15 minutes.
        </p>
        <Link to="/login" style={{ display: "inline-block", marginTop: 20, fontSize: 13, color: "var(--color-accent)" }}>
          Back to login
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="m-0" style={{ fontSize: 30, letterSpacing: "-0.03em", lineHeight: 1.05 }}>Reset your password</h2>
        <p className="m-0" style={{ marginTop: 8, fontSize: 14, color: "var(--color-neutral-800)" }}>Enter your email and we&apos;ll send you a reset link.</p>
      </div>

      {error && (
        <p className="m-0" style={{ marginBottom: 16, fontSize: 13, color: "var(--color-accent-700)" }}>{error}</p>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" style={{ display: "block", fontSize: 12, marginBottom: 5, color: "var(--color-neutral-700)" }}>Email</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            className="input"
          />
        </div>

        <Turnstile onVerify={setCaptcha} onExpire={() => setCaptcha("")} resetSignal={captchaReset} />

        <button
          type="submit"
          disabled={loading || (TURNSTILE_ENABLED && !captcha)}
          className="btn btn-primary btn-block" style={{ padding: "12px 20px", justifyContent: "center" }}
        >
          {loading ? "Sending…" : "Send reset link"}
        </button>
      </form>

      <p className="m-0" style={{ marginTop: 20, fontSize: 13, color: "var(--color-neutral-700)" }}>
        Remembered it?{" "}
        <Link to="/login" style={{ color: "var(--color-accent)" }}>Back to login</Link>
      </p>
    </div>
  );
}

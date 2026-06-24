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
      <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-100">
          <svg className="h-7 w-7 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-gray-900">Check your inbox</h2>
        <p className="mt-2 text-sm text-gray-500">
          If that email is registered, we&apos;ve sent a link to reset your password. The link expires in 1 hour.
        </p>
        <Link to="/login" className="mt-5 inline-block text-sm font-medium text-brand-700 hover:underline">
          Back to login
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-gray-900">Reset your password</h2>
        <p className="mt-1 text-sm text-gray-500">Enter your email and we&apos;ll send you a reset link.</p>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-700">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <Turnstile onVerify={setCaptcha} onExpire={() => setCaptcha("")} resetSignal={captchaReset} />

        <button
          type="submit"
          disabled={loading || (TURNSTILE_ENABLED && !captcha)}
          className="w-full rounded-lg bg-gray-900 py-2.5 font-medium text-white transition hover:bg-black disabled:opacity-50"
        >
          {loading ? "Sending…" : "Send reset link"}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-gray-500">
        Remembered it?{" "}
        <Link to="/login" className="font-medium text-brand-700 hover:underline">Back to login</Link>
      </p>
    </div>
  );
}

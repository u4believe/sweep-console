import { useState, useId } from "react";
import { useSearchParams, Link } from "react-router-dom";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const passwordId = useId();
  const confirmId = useId();

  if (!token) {
    return (
      <div style={{ textAlign: "left" }}>
        <p className="m-0" style={{ fontSize: 14, color: "var(--color-accent-700)" }}>This reset link is invalid.</p>
        <Link to="/forgot-password" style={{ display: "inline-block", marginTop: 16, fontSize: 13, color: "var(--color-accent)" }}>
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div style={{ textAlign: "left" }}>
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-100">
          <svg className="h-7 w-7 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="m-0" style={{ fontSize: 30, letterSpacing: "-0.03em", lineHeight: 1.05 }}>Password updated</h2>
        <p className="m-0" style={{ marginTop: 8, fontSize: 14, color: "var(--color-neutral-800)" }}>You can now sign in with your new password.</p>
        <Link
          to="/login"
          className="btn btn-primary btn-block" style={{ marginTop: 20, padding: "12px 20px", justifyContent: "center" }}
        >
          Login
        </Link>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    const res = await fetch(`${API_URL}/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    let data: { error?: { message?: string } } = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setLoading(false);
    if (!res.ok) {
      setError(data.error?.message ?? "Couldn't reset your password. Please try again.");
      return;
    }
    setDone(true);
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="mb-5">
        <h2 className="m-0" style={{ fontSize: 30, letterSpacing: "-0.03em", lineHeight: 1.05 }}>Choose a new password</h2>
        <p className="m-0" style={{ marginTop: 8, fontSize: 14, color: "var(--color-neutral-800)" }}>Pick a strong password you don&apos;t use elsewhere.</p>
      </div>

      {error && (
        <p className="m-0" style={{ marginBottom: 16, fontSize: 13, color: "var(--color-accent-700)" }}>{error}</p>
      )}

      <div className="space-y-4">
        <div>
          <label htmlFor={passwordId} style={{ display: "block", fontSize: 12, marginBottom: 5, color: "var(--color-neutral-700)" }}>New password</label>
          <div className="flex gap-2">
            <input
              id={passwordId}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required minLength={8} placeholder="Min. 8 characters"
              className="input"
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

        <div>
          <label htmlFor={confirmId} style={{ display: "block", fontSize: 12, marginBottom: 5, color: "var(--color-neutral-700)" }}>Confirm password</label>
          <input
            id={confirmId}
            type={showPassword ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required minLength={8} placeholder="Re-enter password"
            className="input"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading || password.length < 8}
        className="btn btn-primary btn-block"
        style={{ marginTop: 20, padding: "12px 20px", justifyContent: "center" }}
      >
        {loading ? "Updating…" : "Update password"}
      </button>

      <p className="m-0" style={{ marginTop: 20, fontSize: 13, color: "var(--color-neutral-700)" }}>
        <Link to="/login" style={{ color: "var(--color-accent)" }}>Back to login</Link>
      </p>
    </form>
  );
}

import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { OnboardingLayout } from "@/layouts/OnboardingLayout";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

// Shown once, right after a brand-new Google account is created — it has no
// company name yet (Google only gives us the person's display name).
export function OnboardingPage() {
  const { user, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.name ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/auth/complete-profile`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(data.error?.message ?? "Couldn't save. Please try again.");
      }
      await refresh();
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Already onboarded (or arrived here directly) → no reason to be on /welcome.
  if (user?.onboarded) return <Navigate to="/dashboard" replace />;

  const firstName = user?.name?.trim().split(" ")[0];

  return (
    <OnboardingLayout
      // Google proved the address at sign-in, so steps 01 and 02 are already
      // behind this page — it only collects what Google can't give us.
      step={2}
      // The only answer left to change is which Google account signed in, and
      // undoing that means ending the session. Labelled for what it does.
      back={{
        label: "Use a different account",
        onClick: () => {
          void logout().then(() => navigate("/signup", { replace: true }));
        },
      }}
      kicker={firstName ? `Welcome, ${firstName}` : "Welcome"}
      title="What should subscribers call you?"
      body="This is the name shown on your checkout page and on every receipt. You can change it later in Settings."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="field">
          <label htmlFor="company">Company name — shown to subscribers at checkout</label>
          <input
            id="company"
            className="input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            placeholder="Acme Inc."
            autoFocus
          />
        </div>

        {error && (
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{error}</p>
        )}

        <div
          className="flex flex-wrap items-center gap-3"
          style={{ borderTop: "2px solid var(--color-divider)", paddingTop: 20 }}
        >
          <button
            type="submit"
            className="btn btn-primary"
            style={{ padding: "12px 20px" }}
            disabled={loading || name.trim().length === 0}
          >
            {loading ? "Saving…" : "Continue to dashboard"}
          </button>
          <span style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>
            Test mode is on by default.
          </span>
        </div>
      </form>
    </OnboardingLayout>
  );
}

import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { Logo } from "@/components/ui/Logo";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

// Shown once, right after a brand-new Google account is created — it has no
// company name yet (Google only gives us the person's display name).
export function OnboardingPage() {
  const { user, refresh } = useAuth();
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-brand-50 via-white to-white px-4 py-12">
      <div className="mb-8 flex flex-col items-center gap-3">
        <Logo height={48} />
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Sweep Console</h1>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
        <h2 className="text-xl font-bold text-gray-900">
          Welcome{firstName ? `, ${firstName}` : ""} 👋
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          One quick thing — what&apos;s your business or company name? This is what your subscribers see
          on the checkout page.
        </p>

        {error && <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

        <label htmlFor="company" className="mb-1 mt-5 block text-sm font-medium text-gray-700">Company name</label>
        <input
          id="company"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          placeholder="Acme Inc."
          autoFocus
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />

        <button
          type="submit"
          disabled={loading || name.trim().length === 0}
          className="mt-5 w-full rounded-xl bg-gray-900 py-2.5 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-50"
        >
          {loading ? "Saving…" : "Continue to dashboard"}
        </button>
      </form>

      <footer className="mt-10 text-center text-xs text-gray-400">
        A payment infrastructure for developers · Powered by stablecoins
      </footer>
    </div>
  );
}

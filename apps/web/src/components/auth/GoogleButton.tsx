import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { requestGoogleAccessToken } from "@/lib/google";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface Props {
  label: string;
  /** Where to go after a successful sign-in. */
  next?: string;
  /** Persist the session (mirrors the login "remember me" choice). */
  remember?: boolean;
  onError?: (message: string) => void;
}

function GoogleGlyph() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function GoogleButton({ label, next = "/dashboard", remember, onError }: Props) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    onError?.("");
    setLoading(true);
    try {
      const accessToken = await requestGoogleAccessToken();
      const res = await fetch(`${API_URL}/auth/google`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: accessToken, remember }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        created?: boolean;
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(data.error?.message ?? "Google sign-in failed.");
      }
      await refresh();
      // Brand-new Google accounts have no company name yet → onboard first.
      navigate(data.created ? "/welcome" : next, { replace: true });
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "Google sign-in failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="flex w-full items-center justify-center gap-3 rounded-lg border border-gray-200 bg-white py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-60"
    >
      {loading ? (
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
      ) : (
        <GoogleGlyph />
      )}
      {loading ? "Connecting…" : label}
    </button>
  );
}

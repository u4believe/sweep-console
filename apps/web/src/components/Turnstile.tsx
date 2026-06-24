import { useEffect, useRef } from "react";

// Cloudflare Turnstile widget (explicit render). Produces a one-time token the
// server verifies via siteverify. When VITE_TURNSTILE_SITE_KEY is unset (local
// dev) the component renders nothing and TURNSTILE_ENABLED is false, so forms
// don't gate on it.
//
// Docs: https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** True when a site key is configured — forms should require a token. */
export const TURNSTILE_ENABLED = !!SITE_KEY;

interface TurnstileOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
  theme?: "auto" | "light" | "dark";
  size?: "normal" | "flexible" | "compact";
}

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: TurnstileOptions) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Turnstile"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface TurnstileProps {
  /** Called with a fresh token each time the challenge is solved/refreshed. */
  onVerify: (token: string) => void;
  /** Called when the token expires or errors — clear any stored token. */
  onExpire?: () => void;
  /** Bump this number to force a fresh challenge (e.g. after a token is consumed). */
  resetSignal?: number;
  className?: string;
}

export function Turnstile({ onVerify, onExpire, resetSignal = 0, className }: TurnstileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  // Keep the latest callbacks without re-rendering the widget.
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  onVerifyRef.current = onVerify;
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (!SITE_KEY) return; // not configured — render nothing
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: SITE_KEY,
          callback: (token) => onVerifyRef.current(token),
          "expired-callback": () => onExpireRef.current?.(),
          "error-callback": () => onExpireRef.current?.(),
          theme: "auto",
        });
      })
      .catch(() => {
        /* script blocked/unreachable — the server still enforces if configured */
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          /* ignore */
        }
        widgetId.current = null;
      }
    };
  }, []);

  // A Turnstile token is single-use; reset to mint a fresh one for retries/resends.
  useEffect(() => {
    if (resetSignal === 0) return;
    onExpireRef.current?.();
    if (widgetId.current && window.turnstile) {
      try {
        window.turnstile.reset(widgetId.current);
      } catch {
        /* ignore */
      }
    }
  }, [resetSignal]);

  if (!SITE_KEY) return null;
  return <div ref={ref} className={className} />;
}

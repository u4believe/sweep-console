import { useEffect, useState } from "react";
import { ErrorNote, Kicker, Section } from "./primitives";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface SecurityState {
  step_up_enabled: boolean;
  totp_enrolled: boolean;
  totp_setup_started: boolean;
  totp_confirmed_at: string | null;
  recovery_codes_remaining: number;
}

/**
 * Authenticator enrolment and recovery codes.
 *
 * The portal asks for a second proof before anything destructive. Plan and tier
 * changes take an emailed code, so this panel stays optional rather than a
 * blocking setup step — but an emailed code is the same factor an attacker who
 * has taken the inbox already holds, so everything that moves money or hands
 * over a credential accepts nothing but the authenticator, and is unavailable
 * until one is enrolled. This is where it gets set up.
 *
 * The on-screen copy is deliberately terser than this. Which factor an action
 * needs is not a secret — the dialog has to name it, or nobody could answer it —
 * but the panel does not need to walk through the threat model to be useful.
 */
export function SecuritySettings() {
  const [state, setState] = useState<SecurityState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Enrolment, which runs entirely inside this panel: scan → confirm → codes.
  const [enrolling, setEnrolling] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  // Shown once, never retrievable. Held in state only until the merchant leaves.
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  async function load() {
    try {
      const res = await fetch(`${API_URL}/portal/security`, { credentials: "include" });
      if (!res.ok) throw new Error(await messageOf(res, "Couldn't load your security settings."));
      setState((await res.json()) as SecurityState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your security settings.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function startEnrolment() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/portal/security/totp/setup`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await messageOf(res, "Couldn't start setup."));
      const data = (await res.json()) as { qr: string; secret: string };
      setEnrolling({ qr: data.qr, secret: data.secret });
      setCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start setup.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrolment() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/portal/security/totp/confirm`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) throw new Error(await messageOf(res, "That code didn't match."));
      const data = (await res.json()) as { recovery_codes: string[] };
      setFreshCodes(data.recovery_codes);
      setEnrolling(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That code didn't match.");
    } finally {
      setBusy(false);
    }
  }

  // Both of these are themselves guarded — turning the second factor off, or
  // printing a new sheet of codes, is a takeover step if a session is stolen.
  async function disable() {
    setBusy(true);
    setError("");
    const res = await apiFetch(`/portal/security/totp/disable`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      if (!(await wasCancelled(res))) setError(await messageOf(res, "Couldn't turn off the authenticator."));
      return;
    }
    setFreshCodes(null);
    await load();
  }

  async function regenerateCodes() {
    setBusy(true);
    setError("");
    const res = await apiFetch(`/portal/security/recovery-codes`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      if (!(await wasCancelled(res))) setError(await messageOf(res, "Couldn't issue new codes."));
      return;
    }
    setFreshCodes(((await res.json()) as { recovery_codes: string[] }).recovery_codes);
    await load();
  }

  if (!state) {
    return (
      <Section title="Security">
        {error ? <ErrorNote>{error}</ErrorNote> : (
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>Loading…</p>
        )}
      </Section>
    );
  }

  return (
    <Section title="Security">
      <p className="m-0 mb-3" style={{ fontSize: 13, color: "var(--color-neutral-700)", maxWidth: 640, lineHeight: 1.6 }}>
        Destructive actions ask you to confirm a second time. Plan and tier changes accept an
        emailed code. Anything involving money or credentials needs an authenticator app, and
        stays unavailable until you add one.
      </p>

      {!state.step_up_enabled && (
        <p
          className="m-0 mb-3"
          style={{
            fontSize: 12.5,
            color: "var(--color-neutral-700)",
            borderLeft: "3px solid var(--color-divider)",
            paddingLeft: 12,
          }}
        >
          Confirmation prompts are currently switched off for this environment, so nothing will ask
          you yet. You can still enrol now — it takes effect the moment they&apos;re turned on.
        </p>
      )}

      <div style={{ borderTop: "1px solid var(--color-divider)", padding: "14px 0" }}>
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <p className="m-0" style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 14 }}>
              Authenticator app
            </p>
            <p className="m-0" style={{ fontSize: 12.5, color: "var(--color-neutral-700)", marginTop: 3 }}>
              {state.totp_enrolled
                ? `Active since ${new Date(state.totp_confirmed_at!).toLocaleDateString()} · ${state.recovery_codes_remaining} recovery code${state.recovery_codes_remaining === 1 ? "" : "s"} left`
                : "Google Authenticator, 1Password, Authy — any TOTP app."}
            </p>
          </div>
          <span className={`tag ${state.totp_enrolled ? "tag-accent" : "tag-neutral"}`} style={{ marginLeft: "auto" }}>
            {state.totp_enrolled ? "On" : "Off"}
          </span>
        </div>

        <div className="flex flex-wrap gap-2" style={{ marginTop: 12 }}>
          {state.totp_enrolled ? (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => void regenerateCodes()} disabled={busy}>
                New recovery codes
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void disable()} disabled={busy}>
                Turn off
              </button>
            </>
          ) : (
            !enrolling && (
              <button type="button" className="btn btn-primary" onClick={() => void startEnrolment()} disabled={busy}>
                {state.totp_setup_started ? "Resume setup" : "Set up authenticator"}
              </button>
            )
          )}
        </div>
      </div>

      {enrolling && (
        <div style={{ borderTop: "1px solid var(--color-divider)", padding: "18px 0" }}>
          <div className="flex flex-wrap items-start" style={{ gap: 24 }}>
            <img
              src={enrolling.qr}
              alt="Authenticator setup QR code"
              width={200}
              height={200}
              style={{ border: "1px solid var(--color-divider)", background: "#fff" }}
            />
            <div style={{ flex: "1 1 260px", minWidth: 240 }}>
              <Kicker>Step 1</Kicker>
              <p className="m-0" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.6 }}>
                Scan the code with your authenticator app. Can&apos;t scan? Enter this key by hand:
              </p>
              <code
                style={{
                  display: "block",
                  fontFamily: "ui-monospace, Menlo, monospace",
                  fontSize: 12.5,
                  wordBreak: "break-all",
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-divider)",
                  padding: "9px 12px",
                  marginBottom: 18,
                }}
              >
                {enrolling.secret}
              </code>

              <Kicker>Step 2</Kicker>
              <label htmlFor="totp-confirm" style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
                Enter the 6-digit code it shows
              </label>
              <input
                id="totp-confirm"
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void confirmEnrolment(); }}
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                autoComplete="one-time-code"
                style={{ marginTop: 6, maxWidth: 200, letterSpacing: "0.3em", fontFamily: "ui-monospace, Menlo, monospace" }}
              />
              <div className="flex flex-wrap gap-2" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void confirmEnrolment()}
                  disabled={busy || code.trim().length < 6}
                >
                  {busy ? "Checking…" : "Turn on"}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setEnrolling(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {freshCodes && (
        <div style={{ borderTop: "1px solid var(--color-divider)", padding: "18px 0" }}>
          <Kicker>Recovery codes — shown once</Kicker>
          <p className="m-0" style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12, maxWidth: 620 }}>
            Save these somewhere that is not your phone. Each one works once, and any of them gets
            you past a confirmation prompt if you lose the authenticator. We store only hashes — if
            you leave this screen without copying them, they cannot be shown again.
          </p>
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
              background: "var(--color-surface)",
              border: "1px solid var(--color-divider)",
              padding: 14,
              fontFamily: "ui-monospace, Menlo, monospace",
              fontSize: 13,
            }}
          >
            {freshCodes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <div className="flex flex-wrap gap-2" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void navigator.clipboard.writeText(freshCodes.join("\n"))}
            >
              Copy all
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setFreshCodes(null)}>
              I&apos;ve saved them
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ marginTop: 12 }}><ErrorNote>{error}</ErrorNote></div>}
    </Section>
  );
}

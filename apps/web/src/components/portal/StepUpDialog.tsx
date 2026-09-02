import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Dialog, ErrorNote } from "./primitives";
import {
  registerStepUpRequester,
  startEmailChallenge,
  verifyStepUp,
  type StepUpMethod,
  type StepUpNeed,
} from "@/lib/stepup";

const METHOD_LABEL: Record<StepUpMethod, string> = {
  totp: "Authenticator app",
  email: "Email a code",
  recovery: "Recovery code",
};

/**
 * The one confirmation prompt for every guarded action.
 *
 * Mounted once, in PortalLayout. It registers itself as the step-up requester,
 * so any `apiFetch` anywhere in the portal that meets a 401 `step_up_required`
 * opens this — no page has to know which of its buttons are guarded.
 *
 * Which methods appear is the server's decision, carried on the 401: money-
 * moving actions list only the authenticator once one is enrolled, because
 * email is precisely the factor an attacker holding the inbox already has.
 */
export function StepUpDialog() {
  const [need, setNeed] = useState<StepUpNeed | null>(null);
  const [method, setMethod] = useState<StepUpMethod>("totp");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Held across renders so resolving is possible from any handler below. The
  // promise returned to apiFetch stays pending until the merchant confirms or
  // dismisses — that is what makes the original request wait.
  const resolveRef = useRef<((token: string | null) => void) | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () =>
      registerStepUpRequester(
        (incoming) =>
          new Promise<string | null>((resolve) => {
            resolveRef.current = resolve;
            setNeed(incoming);
            setMethod(incoming.methods[0] ?? "email");
            setCode("");
            setError("");
            setExpiresAt(null);
          })
      ),
    []
  );

  useEffect(() => {
    if (need) inputRef.current?.focus();
  }, [need, method]);

  function settle(token: string | null) {
    resolveRef.current?.(token);
    resolveRef.current = null;
    setNeed(null);
    setCode("");
    setError("");
    setExpiresAt(null);
  }

  // An emailed code lives two minutes. Counting it down beats letting someone
  // finish typing into a field that stopped accepting anything 40 seconds ago.
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  async function sendCode() {
    if (!need) return;
    setSending(true);
    setError("");
    try {
      setExpiresAt(await startEmailChallenge(need.action));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the code.");
    } finally {
      setSending(false);
    }
  }

  async function confirm() {
    if (!need || !code.trim()) return;
    setBusy(true);
    setError("");
    try {
      settle(await verifyStepUp(need.action, method, code.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That code didn't work.");
      setBusy(false);
      setCode("");
      inputRef.current?.focus();
      return;
    }
    setBusy(false);
  }

  if (!need) return null;

  // Nothing to ask for: this action takes only an authenticator and there isn't
  // one yet. A code field here would be a prompt with no possible answer.
  if (need.enrolment_required) {
    return (
      <Dialog
        title="Set up an authenticator first"
        onDismiss={() => settle(null)}
        actions={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => settle(null)}>
              Not now
            </button>
            <Link
              to="/settings"
              className="btn btn-primary"
              onClick={() => settle(null)}
            >
              Go to Security
            </Link>
          </>
        }
      >
        <p className="m-0" style={{ fontSize: 13.5, color: "var(--color-neutral-800)", lineHeight: 1.6 }}>
          To {need.action_label}, you need an authenticator app on this account. This action
          hands over a credential that outlives your session, so an emailed code isn&apos;t
          accepted for it — anyone who reached your inbox could use one.
        </p>
        <p className="m-0" style={{ fontSize: 12.5, color: "var(--color-neutral-700)", marginTop: 12, lineHeight: 1.6 }}>
          Setting one up takes about a minute under Settings → Security, and you&apos;ll get
          recovery codes for if you lose the phone.
        </p>
      </Dialog>
    );
  }

  const recovery = method === "recovery";

  return (
    <Dialog
      title={`Confirm it's you`}
      onDismiss={() => settle(null)}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={() => settle(null)} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void confirm()}
            disabled={busy || !code.trim()}
          >
            {busy ? "Checking…" : "Confirm"}
          </button>
        </>
      }
    >
      <p className="m-0" style={{ fontSize: 13.5, color: "var(--color-neutral-800)", marginBottom: 14 }}>
        Before we {need.action_label}, prove this is you.
        {need.required === "totp" && " Only your authenticator is accepted for this one."}
      </p>

      {need.methods.length > 1 && (
        <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 14 }}>
          {need.methods.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMethod(m); setCode(""); setError(""); }}
              className="cursor-pointer"
              style={{
                background: method === m ? "var(--color-text)" : "transparent",
                color: method === m ? "var(--color-bg)" : "var(--color-neutral-700)",
                border: "1px solid var(--color-divider)",
                padding: "5px 10px",
                fontSize: 12,
                fontFamily: "var(--font-body)",
              }}
            >
              {METHOD_LABEL[m]}
            </button>
          ))}
        </div>
      )}

      {method === "email" && (
        <div style={{ marginBottom: 12 }}>
          <button type="button" className="btn btn-secondary" onClick={() => void sendCode()} disabled={sending}>
            {sending ? "Sending…" : expiresAt ? "Send another code" : "Email me a code"}
          </button>
          {expiresAt && (
            <p
              className="m-0"
              style={{
                fontSize: 12,
                marginTop: 8,
                color: secondsLeft === 0 ? "var(--color-accent-700)" : "var(--color-neutral-700)",
              }}
            >
              {secondsLeft > 0 ? (
                <>
                  Sent to the address on your account. Expires in{" "}
                  <strong>
                    {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
                  </strong>
                  .
                </>
              ) : (
                <>That code has expired — send another.</>
              )}
            </p>
          )}
        </div>
      )}

      <label htmlFor="stepup-code" style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>
        {recovery ? "Recovery code" : method === "totp" ? "6-digit code from your app" : "6-digit code from the email"}
      </label>
      <input
        id="stepup-code"
        ref={inputRef}
        className="input"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void confirm(); }}
        // A one-time code should never be autofilled from a password manager or
        // corrected by the keyboard.
        autoComplete="one-time-code"
        inputMode={recovery ? "text" : "numeric"}
        maxLength={recovery ? 20 : 6}
        placeholder={recovery ? "xxxxx-xxxxx" : "000000"}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        style={{ marginTop: 6, letterSpacing: recovery ? "0.04em" : "0.3em", fontFamily: "ui-monospace, Menlo, monospace" }}
      />

      {error && <div style={{ marginTop: 12 }}><ErrorNote>{error}</ErrorNote></div>}
    </Dialog>
  );
}

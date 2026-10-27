import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Section } from "@/components/portal/primitives";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * Does this account have to enrol an authenticator before it can act?
 *
 * The answer comes from the API as one boolean rather than being assembled
 * here from `step_up_enabled`, the mode and `totp_enrolled`. Those three are
 * exactly what requireStepUp weighs, and a second copy of that rule in the
 * client would eventually disagree with the gate that actually runs — showing
 * a prompt where the action would have been allowed, or worse, showing none
 * where it will be refused.
 *
 * `null` while loading, so a caller can render nothing rather than flash a
 * prompt at a merchant who turns out to be enrolled.
 */
export function useEnrolmentRequired(): boolean | null {
  const [required, setRequired] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${API_URL}/portal/security`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: { enrolment_required?: boolean } }) => {
        if (live) setRequired(Boolean(json.data?.enrolment_required));
      })
      // A failure here must not block the page. The server gate still runs,
      // so the worst case is the old behaviour: the refusal arrives on submit
      // instead of before it.
      .catch(() => { if (live) setRequired(false); });
    return () => { live = false; };
  }, []);
  return required;
}

/**
 * Shown in place of a form the account cannot yet submit.
 *
 * This exists because the refusal used to arrive only after the merchant had
 * filled in a plan's name, price, interval and trial — and arrived as
 * "Couldn't create the plan", which named neither the cause nor the remedy.
 * Work was lost to a rule nothing on the page had mentioned.
 */
export function EnrolmentGate({ action }: { action: string }) {
  return (
    <Section bordered={false}>
      <div
        style={{
          border: "1px solid var(--color-accent-300, var(--color-divider))",
          background: "var(--color-surface)",
          borderRadius: "var(--radius-md, 9px)",
          padding: "18px 20px",
        }}
      >
        <h2
          className="m-0"
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--color-neutral-900)",
            letterSpacing: "-0.01em",
          }}
        >
          Set up two-factor authentication first
        </h2>
        <p
          className="m-0"
          style={{ fontSize: 13.5, color: "var(--color-neutral-800)", marginTop: 8, lineHeight: 1.6 }}
        >
          On the live console, {action} needs an authenticator app on this account. It takes about
          a minute, and you only do it once — you won&apos;t be asked for a code every time.
        </p>
        <p
          className="m-0"
          style={{ fontSize: 12.5, color: "var(--color-neutral-700)", marginTop: 8, lineHeight: 1.6 }}
        >
          You&apos;ll get recovery codes as part of setup. Keep them somewhere other than the phone
          holding the authenticator.
        </p>
        <Link to="/settings" className="btn btn-primary" style={{ marginTop: 14 }}>
          Set up two-factor authentication
        </Link>
      </div>
    </Section>
  );
}

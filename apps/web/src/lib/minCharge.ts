import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * The smallest amount a plan or tier may charge, in USDC, or null when the
 * deployment has no floor.
 *
 * READ FROM THE API, never written here. `GET /config` exists precisely so a
 * client does not hardcode a number that moves with gas — the floor is
 * derived from measured settlement cost and will change when that does. A
 * copy in the frontend would go stale silently and start refusing amounts the
 * API accepts, or worse, accepting ones it refuses.
 *
 * Testnet has no floor at all, so this is null there and the forms impose
 * nothing: a developer trying a 1-cent plan to watch the product behave is
 * what the sandbox is for.
 *
 * Null while loading as well as when absent. Callers treat both the same —
 * no floor to enforce — because a form that blocks input until a config
 * request lands is worse than one that briefly lets a too-small number be
 * typed and is corrected by the server.
 */
export function useMinCharge(): number | null {
  const [min, setMin] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${API_URL}/config`)
      .then((r) => r.json())
      .then((json: { min_charge_usdc?: string | null }) => {
        const raw = json?.min_charge_usdc;
        if (!live || raw == null) return;
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) setMin(n);
      })
      .catch(() => {
        /* No floor enforced client-side. The server still refuses. */
      });
    return () => { live = false; };
  }, []);
  return min;
}

/**
 * Why the floor exists, in the creator's terms.
 *
 * They are not refused for a malformed field — the number they typed is a
 * perfectly good price. They are refused by economics, and a message that
 * does not say so reads as an arbitrary limit. So it names the cause: a
 * payment costs roughly the same to collect whatever its size, which is the
 * one fact that makes a minimum make sense rather than feel invented.
 */
export function minChargeHint(min: number): string {
  return (
    `Minimum ${min.toFixed(2)} USDC. Collecting a payment costs about the same ` +
    `in network fees whatever its size, so below this the fee would take more ` +
    `than the payment is worth. Test mode has no minimum.`
  );
}

/** The refusal shown against the field itself, once they have typed too little. */
export function minChargeError(min: number, typed: number): string {
  return `${typed.toFixed(2)} USDC is below the ${min.toFixed(2)} USDC minimum for live plans.`;
}

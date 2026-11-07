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
 * The floor, as a hint under the amount field.
 *
 * It used to explain itself — that a payment costs about the same to collect
 * whatever its size, so below the floor the fee outweighs the payment. True,
 * and three sentences of it above a single number field. The reason belongs
 * in the docs; the field needs the number.
 *
 * minChargeError still explains, because that one appears only after someone
 * has typed too little and is owed a reason.
 */
export function minChargeHint(min: number): string {
  return `Minimum plan/tier price is ${min.toFixed(2)} USDC.`;
}

/** The refusal shown against the field itself, once they have typed too little. */
export function minChargeError(min: number, typed: number): string {
  return `${typed.toFixed(2)} USDC is below the ${min.toFixed(2)} USDC minimum for live plans.`;
}

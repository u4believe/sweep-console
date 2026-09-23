import type { Usdc } from "./types.js";

/**
 * The single most common way to lose money on this rail is a factor of 10⁶.
 *
 * `max_amount` and `amount` are USDC micro-units: 5000000 is 5 USDC. Written as
 * a bare number that is one keystroke away from a payer signing a ceiling a
 * million times too large, or a charge of nine ten-thousandths of a cent. The
 * API cannot catch either — both are valid integers.
 *
 * So amounts are a branded type, and this is the only way to make one. A plain
 * number will not compile where a `Usdc` is expected, which moves the whole
 * class of mistake from production to your editor.
 *
 *   usdc("9.00")   // 9000000
 *   usdc("0.5")    // 500000
 *   usdc(9)        // 9000000 — whole dollars only, for convenience
 *
 * Strings are preferred: 0.1 + 0.2 is not 0.3 in binary floating point, and a
 * price that arrives from a database as a decimal string should never be routed
 * through a float on its way here.
 */
export function usdc(amount: string | number): Usdc {
  const text = typeof amount === "number" ? String(amount) : amount.trim();

  if (!/^\d+(\.\d{1,6})?$/.test(text)) {
    throw new RangeError(
      `usdc(): expected a positive amount with at most 6 decimal places, got ${JSON.stringify(amount)}. ` +
        `Examples: usdc("9.00"), usdc("0.5"), usdc(9).`
    );
  }

  const [whole = "0", fraction = ""] = text.split(".");
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));

  if (micro <= 0n) throw new RangeError("usdc(): amount must be greater than zero.");
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("usdc(): amount is too large.");

  return Number(micro) as Usdc;
}

/** The inverse, for display: `format(9000000)` → `"9.00"`. */
export function format(amount: Usdc | number): string {
  const negative = amount < 0;
  const micro = BigInt(Math.abs(Math.trunc(amount)));
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

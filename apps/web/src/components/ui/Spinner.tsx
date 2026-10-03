/**
 * The one spinner.
 *
 * Four files had each written `h-4 w-4 animate-spin rounded-full border-2
 * border-brand-200 border-t-brand-600` by hand, which is how three of them
 * ended up slightly different sizes.
 *
 * It keeps turning under `prefers-reduced-motion` rather than stopping. A
 * progress indicator that holds still does not read as "calm", it reads as
 * "frozen" — which on a payment screen is the one impression worth avoiding.
 * It turns more slowly instead.
 */
export function Spinner({
  size = 16,
  tone = "accent",
  className = "",
  label,
}: {
  size?: number;
  /** `accent` on light ground, `onAccent` inside a filled button. */
  tone?: "accent" | "onAccent" | "muted";
  className?: string;
  /** Announced to screen readers. Omit when adjacent text already says it. */
  label?: string;
}) {
  const ring =
    tone === "onAccent"
      ? { borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" }
      : tone === "muted"
        ? { borderColor: "var(--color-neutral-300)", borderTopColor: "var(--color-neutral-700)" }
        : { borderColor: "var(--color-accent-200, #dbe9fa)", borderTopColor: "var(--color-accent, #2f6fc9)" };

  return (
    <span
      className={`swp-spin inline-block shrink-0 rounded-full ${className}`}
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 8)), borderStyle: "solid", ...ring }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/**
 * An indeterminate bar for a row that is working — the chain row on checkout.
 *
 * Paired with the spinner rather than replacing it: the spinner says "busy",
 * this says "busy HERE", and on a list of three chains the second question is
 * the one the subscriber is actually asking.
 */
export function ActivityBar({ className = "" }: { className?: string }) {
  return (
    <span className={`swp-activity block overflow-hidden ${className}`} aria-hidden="true">
      <span className="swp-activity-fill block h-full" />
    </span>
  );
}

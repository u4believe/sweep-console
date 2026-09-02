import type { ReactNode } from "react";

/**
 * Shared building blocks for the portal, expressed in the Modernist system.
 *
 * The system organises with alignment and rules rather than cards and shadows,
 * so these primitives are mostly about drawing the right dividers in the right
 * places. Take every value from the design tokens — never a raw hex or font.
 */

/* ── layout ──────────────────────────────────────────────────────────────── */

/** A ruled content section. `bordered` draws the closing 2px rule. */
export function Section({
  title,
  action,
  children,
  bordered = true,
  padded = true,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  bordered?: boolean;
  padded?: boolean;
}) {
  return (
    <section
      style={{
        padding: padded ? "24px 32px" : undefined,
        borderBottom: bordered ? "2px solid var(--color-divider)" : undefined,
      }}
    >
      {title && (
        <div className="mb-3.5 flex items-baseline gap-3">
          <h3 className="m-0" style={{ fontSize: 20, letterSpacing: "-0.02em" }}>
            {title}
          </h3>
          {action && <div className="ml-auto">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** The small uppercase eyebrow used above values and section titles. */
export function Kicker({ children }: { children: ReactNode }) {
  return (
    <p
      className="m-0 mb-2 uppercase"
      style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-neutral-600)" }}
    >
      {children}
    </p>
  );
}

export interface Kpi {
  label: string;
  value: string;
  unit?: string;
  /** Accent a figure that needs attention (e.g. failures). */
  accent?: boolean;
}

/**
 * The band of equal-width statistic cells that opens several portal screens.
 * Cells are divided by hairlines; the band closes with a 2px rule.
 */
export function KpiBand({ items, loading = false, size = 44 }: { items: Kpi[]; loading?: boolean; size?: number }) {
  const cells: (Kpi | null)[] = loading ? Array.from({ length: 4 }, () => null) : items;
  return (
    <div
      className="grid grid-cols-2 lg:grid-cols-4"
      style={{ borderBottom: "2px solid var(--color-divider)" }}
    >
      {cells.map((k, i) => (
        <div
          key={k?.label ?? i}
          style={{
            padding: "20px 26px 22px",
            borderLeft: i === 0 ? undefined : "1px solid var(--color-divider)",
          }}
        >
          {k ? (
            <>
              <Kicker>{k.label}</Kicker>
              <p
                className="m-0"
                style={{
                  fontFamily: "var(--font-heading)",
                  fontWeight: 800,
                  fontSize: size,
                  lineHeight: 1,
                  letterSpacing: "-0.035em",
                  color: k.accent ? "var(--color-accent)" : undefined,
                }}
              >
                {k.value}
                {k.unit && <span style={{ fontSize: 15, marginLeft: 6, letterSpacing: 0 }}>{k.unit}</span>}
              </p>
            </>
          ) : (
            <>
              <div className="mb-3 h-2.5 w-24 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
              <div className="h-9 w-16 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Horizontal filter tabs sitting under the page header, over a 2px rule. */
export function FilterTabs<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: T; label: string; count?: number }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div
      className="flex overflow-x-auto"
      style={{ borderBottom: "2px solid var(--color-divider)", padding: "0 32px" }}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className="cursor-pointer whitespace-nowrap"
            style={{
              background: "transparent",
              border: 0,
              borderBottom: `3px solid ${on ? "var(--color-accent)" : "transparent"}`,
              color: on ? "var(--color-text)" : "var(--color-neutral-700)",
              padding: "12px 16px 10px",
              fontFamily: "var(--font-body)",
              fontSize: 13,
            }}
          >
            {t.label}{" "}
            {t.count !== undefined && (
              <span
                style={{
                  fontFamily: "ui-monospace, Menlo, monospace",
                  fontSize: 11,
                  color: "var(--color-neutral-600)",
                }}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── content states ──────────────────────────────────────────────────────── */

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <Section bordered={false}>
      <p className="m-0" style={{ color: "var(--color-accent-700)" }}>{children}</p>
    </Section>
  );
}

export function EmptyNote({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ padding: "64px 32px", borderTop: "1px solid var(--color-divider)" }}>
      <p className="m-0" style={{ fontSize: 15, color: "var(--color-neutral-700)" }}>{title}</p>
      {hint && (
        <p className="m-0 mt-1" style={{ fontSize: 13, color: "var(--color-neutral-600)" }}>{hint}</p>
      )}
    </div>
  );
}

/** Skeleton rows sized to the design's table. */
export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex gap-6"
          style={{ borderBottom: "1px solid var(--color-divider)", padding: "12px 8px" }}
        >
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className="h-3.5 animate-pulse"
              style={{ background: "var(--color-neutral-300)", width: c === 0 ? 160 : 80 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── dialog ──────────────────────────────────────────────────────────────── */

/**
 * A modal at the system's top elevation. Actions sit flush right; the
 * backdrop is the design system's own `.dialog-backdrop`.
 */
export function Dialog({
  title,
  children,
  actions,
  onDismiss,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div
      className="dialog-backdrop"
      style={{ zIndex: 50 }}
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <p className="dialog-title m-0">{title}</p>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

/* ── status ──────────────────────────────────────────────────────────────── */

/**
 * Maps a domain status onto the design system's tag variants.
 *
 * The system is a mono palette — `.tag-accent` and `.tag-accent-2` read the
 * same — so states are distinguished by fill vs. outline vs. neutral rather
 * than by hue. Live/successful states take the accent fill, states needing
 * attention take the accent outline, and terminal states go neutral.
 */
const TAG_BY_STATUS: Record<string, string> = {
  active: "tag-accent",
  succeeded: "tag-accent",
  delivered: "tag-accent",
  trialing: "tag-outline",
  pending: "tag-outline",
  past_due: "tag-outline",
  failed: "tag-outline",
  cancelled: "tag-neutral",
  canceled: "tag-neutral",
  refunded: "tag-neutral",
  paused: "tag-neutral",
  expired: "tag-neutral",
};

export function StatusTag({ status }: { status: string }) {
  const variant = TAG_BY_STATUS[status.toLowerCase()] ?? "tag-neutral";
  return <span className={`tag ${variant}`}>{status.replace(/_/g, " ")}</span>;
}

/* ── text helpers ────────────────────────────────────────────────────────── */

/** Monospace inline value — addresses, ids, tx hashes. */
export function Mono({ children, size = 12 }: { children: ReactNode; size?: number }) {
  return (
    <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: size }}>{children}</span>
  );
}

export function shortAddress(address: string): string {
  return address.length >= 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

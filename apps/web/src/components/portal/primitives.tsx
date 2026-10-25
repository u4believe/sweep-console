import type { ReactNode } from "react";

/**
 * Shared building blocks for the portal, in the v2 system.
 *
 * These are the leverage point for the console's look: every portal screen
 * builds from them, so what they draw is what Dashboard, Plans, Subscriptions,
 * Payments, Rail, Webhooks, API Keys and Settings all look like.
 *
 * They used to express the Modernist system, which organises with alignment
 * and rules — full-bleed bands separated by dividers, nothing rounded,
 * nothing floating. v2 organises with SURFACES: a rounded card on a tinted
 * ground, separated by space rather than a line. Swapping the tokens under
 * the old shapes moved the colours and kept the skeleton, which is why the
 * console still looked like the previous design in new paint.
 *
 * Take every value from the tokens — never a raw hex or font.
 */

/* ── layout ──────────────────────────────────────────────────────────────── */

/**
 * A content section, now a card rather than a ruled band.
 *
 * `bordered` is kept and still means "separate this from what follows", but
 * it draws the card's own edge instead of a divider underneath — so the dozens
 * of call sites passing `bordered={false}` still mean what they meant: a
 * region that runs into the next one.
 */
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
        margin: bordered ? "0 24px 18px" : undefined,
        padding: padded ? (bordered ? 22 : "20px 26px") : undefined,
        background: bordered ? "var(--color-bg)" : undefined,
        border: bordered ? "1px solid var(--color-divider)" : undefined,
        borderRadius: bordered ? "var(--radius-lg)" : undefined,
      }}
    >
      {title && (
        <div className="mb-3.5 flex items-baseline gap-3">
          <h3 className="m-0" style={{ fontSize: 18, letterSpacing: "-0.02em" }}>
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
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.1em",
        // neutral-600 is 3.3:1 and this is 11px. One step darker, which the
        // token file flags for exactly this case.
        color: "var(--color-neutral-800)",
      }}
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
 * The statistics that open several portal screens — separate cards now, not
 * one band cut by hairlines.
 *
 * The figure drops from 44px to 30px. At 44 it was the Modernist poster
 * number, correct on a page organised by scale; on a page organised by
 * surfaces it overpowers the card holding it and makes four of them a wall.
 * Call sites passing `size` still win, so a screen that wants the big number
 * keeps it.
 */
export function KpiBand({ items, loading = false, size = 30 }: { items: Kpi[]; loading?: boolean; size?: number }) {
  const cells: (Kpi | null)[] = loading ? Array.from({ length: 4 }, () => null) : items;
  return (
    <div
      className="grid grid-cols-2 lg:grid-cols-4"
      style={{ gap: 14, padding: "20px 24px 6px" }}
    >
      {cells.map((k, i) => (
        <div
          key={k?.label ?? i}
          style={{
            padding: "16px 18px",
            // Tinted, not white. The design fills these from the surface so
            // they read as a band of figures against the page; white cards on
            // a white page need a border to exist at all, and four bordered
            // boxes in a row is a grid where the design has a rhythm.
            background: "var(--color-neutral-200)",
            borderRadius: "var(--radius-lg)",
          }}
        >
          {k ? (
            <>
              <Kicker>{k.label}</Kicker>
              <p
                className="m-0"
                style={{
                  fontFamily: "var(--font-heading)",
                  fontWeight: 700,
                  fontSize: size,
                  lineHeight: 1.1,
                  letterSpacing: "-0.03em",
                  color: k.accent ? "var(--color-accent)" : undefined,
                }}
              >
                {k.value}
                {k.unit && <span style={{ fontSize: 13, marginLeft: 5, letterSpacing: 0, color: "var(--color-neutral-800)" }}>{k.unit}</span>}
              </p>
            </>
          ) : (
            <>
              <div className="mb-3 h-2.5 w-20 animate-pulse" style={{ background: "var(--color-neutral-300)", borderRadius: 4 }} />
              <div className="h-7 w-16 animate-pulse" style={{ background: "var(--color-neutral-300)", borderRadius: 5 }} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Filter tabs under the page header — a row of pills, matching the sidebar's
 * items, rather than the underlined bar the Modernist system used. Two
 * different active-state idioms on one screen read as two different controls.
 */
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
    <div className="flex overflow-x-auto" style={{ gap: 4, padding: "4px 24px 14px" }}>
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            aria-current={on ? "page" : undefined}
            className="swp-navitem cursor-pointer whitespace-nowrap"
            style={{
              background: on ? "var(--color-accent-200)" : "transparent",
              border: 0,
              borderRadius: "var(--radius-sm)",
              color: on ? "var(--color-accent)" : "var(--color-neutral-800)",
              padding: "8px 13px",
              fontFamily: "var(--font-body)",
              fontWeight: on ? 600 : 500,
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

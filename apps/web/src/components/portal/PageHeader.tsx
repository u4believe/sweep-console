import type { ReactNode } from "react";

interface PageHeaderProps {
  /** Small uppercase eyebrow above the title. */
  kicker: string;
  title: string;
  /** Optional back affordance, rendered as the design's secondary button. */
  onBack?: () => void;
  /** Primary action for the page, rendered flush right. */
  action?: ReactNode;
}

/**
 * The portal's page title band — kicker, display title, and right-aligned
 * actions over a 2px rule. Every portal page opens with one of these; it is
 * the band the design carries across all nine portal screens.
 */
export function PageHeader({ kicker, title, onBack, action }: PageHeaderProps) {
  return (
    <div
      className="flex flex-wrap items-end gap-4 px-8 pb-[18px] pt-[26px]"
      style={{ borderBottom: "2px solid var(--color-divider)" }}
    >
      <div className="min-w-0">
        <p
          className="m-0 mb-1.5 uppercase"
          style={{
            fontSize: 10,
            letterSpacing: "0.16em",
            color: "var(--color-neutral-600)",
          }}
        >
          {kicker}
        </p>
        <h1 className="m-0" style={{ fontSize: 36, letterSpacing: "-0.03em", lineHeight: 1 }}>
          {title}
        </h1>
      </div>

      {(onBack || action) && (
        <div className="ml-auto flex items-center gap-2.5">
          {onBack && (
            <button type="button" className="btn btn-secondary" style={{ padding: "9px 14px" }} onClick={onBack}>
              ← Back
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

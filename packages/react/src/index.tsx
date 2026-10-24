/**
 * @sweepconsole/react — the authorize button as a component.
 *
 * A thin wrapper over `@sweepconsole/js`, and deliberately thin: the vanilla
 * package is the one that can be loaded from a script tag, is the one the CDN
 * build ships, and is where the modal, the postMessage protocol and the popup
 * fallback live. Anything implemented here instead of there would be missing
 * for everyone not using React.
 *
 * So this file owns exactly three things React needs and vanilla does not:
 * mounting against a ref, keeping the latest callbacks without re-mounting,
 * and tearing down on unmount.
 */

import { useEffect, useRef } from "react";
import { authorize, type AuthorizeOptions, type AuthorizeResult } from "@sweepconsole/js";

export type { AuthorizeResult };

export interface SweepAuthorizeProps {
  /**
   * Your endpoint, which creates the mandate and returns a URL. POSTed to.
   *
   * It must be YOUR server, not Sweep's: the payer reference that goes into a
   * mandate decides who a recurring charge is attributed to, and anything the
   * browser sends is something the person at the browser can change. Your
   * server reads the payer from its own session and asks Sweep for the link.
   */
  session: AuthorizeOptions["session"];
  /** Called once the payer has signed. The modal closes first. */
  onAuthorized?: (mandate: AuthorizeResult) => void;
  /** Called if they dismissed it without signing. */
  onCancelled?: () => void;
  /** Called if the session could not be created. */
  onError?: (error: Error) => void;
  /**
   * "modal" (default) opens the checkout over your page; "popup" opens a
   * window; "redirect" navigates, exactly like the vanilla `mount()`.
   */
  mode?: AuthorizeOptions["mode"];
  variant?: AuthorizeOptions["variant"];
  size?: AuthorizeOptions["size"];
  block?: boolean;
  /** Button text. Defaults to "Authorize payments". */
  children?: string;
  className?: string;
}

/**
 * A button that opens the rail checkout over the current page.
 *
 * ```tsx
 * <SweepAuthorize
 *   session="/api/sweep/mandate-link"
 *   onAuthorized={(m) => saveMandate(m.mandate_id)}
 * >
 *   Authorize with wallet
 * </SweepAuthorize>
 * ```
 */
export function SweepAuthorize(props: SweepAuthorizeProps) {
  const host = useRef<HTMLSpanElement | null>(null);

  /**
   * The callbacks, read through a ref.
   *
   * A parent that passes an inline arrow gives a new function identity every
   * render. Listing those in the effect's deps would tear the button down and
   * rebuild it on each one — losing its busy state mid-click, and closing an
   * open modal out from under the payer. The ref keeps the effect's deps to
   * the things that genuinely change what gets mounted.
   */
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const handle = authorize(el, {
      session: (...args: Parameters<Extract<AuthorizeOptions["session"], (...a: never[]) => unknown>>) =>
        // Resolved at call time so a `session` prop that changes between
        // renders is honoured without remounting.
        typeof latest.current.session === "function"
          ? (latest.current.session as (...a: unknown[]) => unknown)(...args)
          : latest.current.session,
      mode: props.mode,
      variant: props.variant,
      size: props.size,
      block: props.block,
      label: props.children,
      onAuthorized: (m) => latest.current.onAuthorized?.(m),
      onCancelled: () => latest.current.onCancelled?.(),
      onError: (e) => latest.current.onError?.(e),
    } as AuthorizeOptions);

    return () => handle.destroy();
    // Only what changes the mounted button. Callbacks and `session` come
    // through `latest`, which is why they are absent here on purpose.
  }, [props.mode, props.variant, props.size, props.block, props.children]);

  return <span ref={host} className={props.className} />;
}

export default SweepAuthorize;

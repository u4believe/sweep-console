import { createContext, useContext, type ReactNode } from "react";

/**
 * Which half of the product the console is pointed at.
 *
 * Owned by PortalLayout, which has the control and the entitlement, and
 * published here because the scope is no longer only a nav concern: it
 * re-themes the console, and it decides which webhook events a screen
 * offers. A page reaching into localStorage for it would read a value the
 * layout may have already corrected from the route.
 */
export type Scope = "hosted" | "rail";

/**
 * Defaults to "hosted" outside a provider.
 *
 * That is the honest default rather than a thrown error: these screens are
 * also rendered in isolation (a storybook, a test), and a page that explodes
 * without a provider is harder to work on than one that shows the side every
 * account has.
 */
const ScopeContext = createContext<Scope>("hosted");

export function ScopeProvider({ scope, children }: { scope: Scope; children: ReactNode }) {
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

export function useScope(): Scope {
  return useContext(ScopeContext);
}

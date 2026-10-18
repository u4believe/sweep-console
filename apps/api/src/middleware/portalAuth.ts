import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { isMainnet } from "../lib/gateway/chains";

export interface PortalRequest extends Request {
  merchantDbId: string;
  /** Which mode the dashboard is currently showing. See portalScope. */
  isTestMode: boolean;
}

export interface SessionPayload {
  dbId: string;
  merchantId: string;
  email: string;
  name: string;
  onboarded?: boolean; // optional: tokens issued before this field default to "onboarded"
  /**
   * Vestigial. Sessions issued between 347faf7 and this change carry it, and
   * it is now ignored — the deployment decides the mode. Kept in the type so
   * an old cookie still decodes rather than failing verification.
   */
  testMode?: boolean;
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return secret;
}

export function verifyPortalSession(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = req.cookies["sweep_session"];

  if (!token) {
    res.status(401).json({ error: { message: "Not authenticated", code: "unauthorized" } });
    return;
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as SessionPayload;
    (req as PortalRequest).merchantDbId = payload.dbId;
    /**
     * The DEPLOYMENT decides the mode, not the session.
     *
     * It was the session for one day, and that produced a state that cannot
     * work: a merchant signed into the live deployment with a test-mode
     * session got test rows from the shared database while every Circle call
     * used the live key — so their payout wallet, created in Circle's test
     * environment, came back 404 "not accessible to the caller". Neither half
     * was wrong; the combination was impossible.
     *
     * isMainnet() already decides the chain set, the CCTP host, the contract
     * addresses and which API keys are accepted. Deriving the dashboard's
     * mode from it too means the wallet always matches the key that made it,
     * and the charges beside it. Switching mode is now switching site, which
     * is what the two hostnames are for.
     */
    (req as PortalRequest).isTestMode = !isMainnet();
    next();
  } catch {
    res.status(401).json({ error: { message: "Session expired or invalid", code: "unauthorized" } });
  }
}

/**
 * The filter every portal read of a mode-bearing model must carry.
 *
 * The API's merchantScope() takes the mode from the KEY, which the dashboard
 * does not have — it is session-authed. This is the same idea for the other
 * door: with one database serving both deployments, a dashboard that does not
 * filter shows test and live rows in the same table.
 *
 * Both now answer to the same switch. A key reaches the deployment that can
 * serve it because isMainnet() picks the accepted prefix; a dashboard shows
 * the mode its deployment runs. Neither can disagree with the chain set.
 */
export function portalScope(req: Request): { merchantId: string; isTestMode: boolean } {
  const { merchantDbId, isTestMode } = req as PortalRequest;
  return { merchantId: merchantDbId, isTestMode };
}

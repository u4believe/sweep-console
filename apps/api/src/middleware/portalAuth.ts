import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

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
   * Which mode the dashboard is showing. Optional for the same reason as
   * `onboarded`: a session issued before this existed must keep working, and
   * absent means test — the safe side to default to.
   *
   * In the session rather than on the Merchant row so two people on one
   * account can view different modes, and so switching costs no extra read on
   * every portal request. The toggle re-issues the cookie.
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
    // Absent on a session issued before the toggle existed. Test is the side
    // to be wrong on: a dashboard showing test data is confusing, one showing
    // live data to someone who thought they were testing is worse.
    (req as PortalRequest).isTestMode = payload.testMode !== false;
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
 */
export function portalScope(req: Request): { merchantId: string; isTestMode: boolean } {
  const { merchantDbId, isTestMode } = req as PortalRequest;
  return { merchantId: merchantDbId, isTestMode };
}

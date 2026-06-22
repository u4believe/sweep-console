import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface PortalRequest extends Request {
  merchantDbId: string;
}

export interface SessionPayload {
  dbId: string;
  merchantId: string;
  email: string;
  name: string;
  onboarded?: boolean; // optional: tokens issued before this field default to "onboarded"
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
    next();
  } catch {
    res.status(401).json({ error: { message: "Session expired or invalid", code: "unauthorized" } });
  }
}

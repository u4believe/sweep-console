// The gate on the external payment rail.
//
// Merchant.externalRailEnabled is an entitlement this platform grants, not a
// preference a developer sets — /v1/charges is the first endpoint where a leaked
// API key enriches whoever stole it. Nothing in the API can turn it on; that is
// scripts/external-rail.ts, deliberately.
//
// Mount it AFTER verifyApiKey, which is what puts `merchant` on the request.

import type { Request, Response, NextFunction } from "express";
import { err } from "../lib/response";
import type { AuthedRequest } from "./auth";

export function requireExternalRail(req: Request, res: Response, next: NextFunction) {
  const { merchant } = req as AuthedRequest;
  if (!merchant?.externalRailEnabled) {
    err(
      res,
      "This account is not enabled for the external payment rail. Contact support to request access.",
      403,
      "rail_not_enabled"
    );
    return;
  }
  next();
}

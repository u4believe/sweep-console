// The gate on the external payment rail.
//
// Merchant.externalRailEnabled is an entitlement this platform grants, not a
// preference a developer sets — /v1/charges is the first endpoint where a leaked
// API key can charge a merchant's own payers. Nothing in the API can turn it on; that is
// scripts/external-rail.ts, deliberately.
//
// ON TESTNET THERE IS NOTHING TO GATE. The funds are test funds, the chains are
// Sepolia, and a developer who cannot reach /v1/charges cannot evaluate the
// product at all — so the gate is a support ticket standing between someone and
// the thing they came to try. Mainnet keeps it, because there the first charge
// moves real money belonging to someone else.
//
// This also fixes a carry-over: externalRailEnabled is ONE column and the
// database is shared, so a grant made for testing was silently a grant on
// mainnet too. Ignoring it on testnet means it only ever means "live rail
// access", and nothing a developer was given to try the product becomes an
// entitlement over real payers.
//
// Mount it AFTER verifyApiKey, which is what puts `merchant` on the request.

import type { Request, Response, NextFunction } from "express";
import { err } from "../lib/response";
import { isMainnet } from "../lib/gateway/chains";
import type { AuthedRequest } from "./auth";

export function requireExternalRail(req: Request, res: Response, next: NextFunction) {
  if (!isMainnet()) return next();
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

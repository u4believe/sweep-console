// Account security: authenticator enrolment, recovery codes, and the step-up
// challenge/verify pair that every destructive portal route sits behind.
//
// Mounted under /portal/security by portal.ts, so verifyPortalSession has
// already run and req.merchantDbId is set.

import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import { prisma } from "../lib/prisma";
import { ok, err } from "../lib/response";
import type { PortalRequest } from "../middleware/portalAuth";
import {
  STEP_UP_ACTIONS,
  StepUpError,
  availableMethods,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  regenerateRecoveryCodes,
  requireStepUp,
  startEmailChallenge,
  stepUpEnabled,
  verifyStepUp,
  type StepUpAction,
} from "../lib/portal/stepup";

export const securityRouter = Router();

const ACTIONS = Object.keys(STEP_UP_ACTIONS) as [StepUpAction, ...StepUpAction[]];

function fail(res: Response, e: unknown, context: string) {
  if (e instanceof StepUpError) return err(res, e.message, e.httpStatus);
  console.error(context, e);
  return err(res, "Something went wrong. Try again.", 500);
}

// ─── GET /portal/security ─────────────────────────────────────────────────────
// What the Security panel renders from.

securityRouter.get("/", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: { totpSecret: true, totpConfirmedAt: true, recoveryCodes: true },
    });
    return ok(res, {
      step_up_enabled: stepUpEnabled(),
      totp_enrolled: Boolean(merchant.totpConfirmedAt),
      totp_setup_started: Boolean(merchant.totpSecret) && !merchant.totpConfirmedAt,
      totp_confirmed_at: merchant.totpConfirmedAt?.toISOString() ?? null,
      recovery_codes_remaining: merchant.recoveryCodes.length,
    });
  } catch (e) {
    return fail(res, e, "[portal/security GET]");
  }
});

// ─── Authenticator enrolment ──────────────────────────────────────────────────

securityRouter.post("/totp/setup", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: { email: true, totpConfirmedAt: true },
    });
    // Replacing a working authenticator is a step-up action of its own: disable
    // the current one first, which is guarded.
    if (merchant.totpConfirmedAt) {
      return err(res, "An authenticator is already active. Turn it off before setting up a new one.", 409);
    }

    const { uri, secret } = await beginTotpEnrolment(dbId, merchant.email);
    return ok(res, { uri, secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
  } catch (e) {
    return fail(res, e, "[portal/security/totp/setup]");
  }
});

const codeSchema = z.object({ code: z.string().min(4).max(20) });

securityRouter.post("/totp/confirm", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Enter the 6-digit code from your authenticator.", 422);
  try {
    // Shown once and never again — the response is the only copy the merchant gets.
    return ok(res, { recovery_codes: await confirmTotpEnrolment(dbId, parsed.data.code) });
  } catch (e) {
    return fail(res, e, "[portal/security/totp/confirm]");
  }
});

securityRouter.post("/totp/disable", requireStepUp("totp.disable"), async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: { totpConfirmedAt: true },
    });
    if (!merchant.totpConfirmedAt) return err(res, "No authenticator is set up on this account.", 409);
    await disableTotp(dbId);
    return ok(res, { totp_enrolled: false });
  } catch (e) {
    return fail(res, e, "[portal/security/totp/disable]");
  }
});

securityRouter.post("/recovery-codes", requireStepUp("recovery.regenerate"), async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: { totpConfirmedAt: true },
    });
    if (!merchant.totpConfirmedAt) return err(res, "Recovery codes only exist alongside an authenticator.", 409);
    return ok(res, { recovery_codes: await regenerateRecoveryCodes(dbId) });
  } catch (e) {
    return fail(res, e, "[portal/security/recovery-codes]");
  }
});

// ─── The step-up challenge itself ─────────────────────────────────────────────

const startSchema = z.object({ action: z.enum(ACTIONS) });

/// Sends the emailed code. TOTP needs no start — the app already has the seed.
securityRouter.post("/step-up/start", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Unknown action", 422);
  try {
    const { expiresAt } = await startEmailChallenge(dbId, parsed.data.action);
    return ok(res, { sent: true, expires_at: expiresAt.toISOString() });
  } catch (e) {
    return fail(res, e, "[portal/security/step-up/start]");
  }
});

const verifySchema = z.object({
  action: z.enum(ACTIONS),
  method: z.enum(["email", "totp", "recovery"]),
  code: z.string().min(4).max(40),
});

securityRouter.post("/step-up/verify", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Enter the code you were given.", 422);
  try {
    const { token, expiresAt } = await verifyStepUp({ merchantDbId: dbId, ...parsed.data });
    return ok(res, { token, expires_at: expiresAt.toISOString() });
  } catch (e) {
    return fail(res, e, "[portal/security/step-up/verify]");
  }
});

/// What a client may offer for an action, without attempting it first. The
/// destructive routes also return this on their 401, so this is only for
/// dialogs opened deliberately (e.g. turning the authenticator off).
securityRouter.get("/step-up/methods", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const parsed = startSchema.safeParse({ action: req.query.action });
  if (!parsed.success) return err(res, "Unknown action", 422);
  try {
    const availability = await availableMethods(dbId, parsed.data.action);
    return ok(res, {
      ...availability,
      action_label: STEP_UP_ACTIONS[parsed.data.action].label,
      step_up_enabled: stepUpEnabled(),
    });
  } catch (e) {
    return fail(res, e, "[portal/security/step-up/methods]");
  }
});

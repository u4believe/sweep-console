// Step-up authentication for destructive creator actions.
//
// A portal session cookie is enough to read a dashboard. It is not enough to
// move a payout address, drain a Circle wallet, mint an API key, or close a
// plan that is billing live subscribers. Those actions ask the merchant to
// prove, a second time and within the last few minutes, that they are the
// account owner.
//
// Two factors, and only two:
//   • an emailed 6-digit code, and
//   • TOTP (Google Authenticator), plus its recovery codes.
// Password is deliberately NOT a factor: accounts created through Google have
// `passwordHash: null` and could never satisfy it.
//
// The policy is mixed, by blast radius:
//   • Plan/tier deletion and key rotation accept EITHER factor. They are
//     reversible or self-announcing, and accepting either means each factor
//     recovers the other — so a merchant who never enrols TOTP is not locked
//     out of their own portal.
//   • Anything that moves money — the payout address, the Circle withdrawal —
//     REQUIRES the authenticator once one is enrolled. Email alone is exactly
//     the factor an attacker who has taken the inbox already holds.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { addMinutes } from "date-fns";
import type { Request, Response, NextFunction } from "express";
import { authenticator } from "otplib";
import { prisma } from "../prisma";
import type { PortalRequest } from "../../middleware/portalAuth";

// A code the merchant reads off a screen or an email is worth little if it is
// only good for one tick — allow the neighbouring 30-second windows for clock drift.
authenticator.options = { window: 1 };

// ─── Actions ──────────────────────────────────────────────────────────────────

export type StepUpAction =
  | "plan.delete"
  | "tier.delete"
  | "apikey.regenerate"
  | "webhook.reveal"
  | "webhook.roll"
  | "wallet.change"
  | "wallet.unlink"
  | "payout.withdraw"
  | "totp.disable"
  | "recovery.regenerate";

/// How hard a proof an action demands.
///
/// - "any"            either factor. Each recovers the other, so a merchant who
///                    never enrols an authenticator is not locked out.
/// - "totp-preferred" the authenticator once enrolled; email for merchants who
///                    have not enrolled one. Nothing uses this today — every
///                    action that was on it has been promoted to "totp-only" —
///                    but it is the right level for a future action that is
///                    sensitive without handing over money or a credential.
/// - "totp-only"      the authenticator or a recovery code, always. Email is
///                    never offered, and a merchant without an authenticator
///                    must enrol before the action is available at all.
///
/// "totp-only" exists because an emailed code is not a second factor against
/// the attacker who took the inbox — and the inbox is also where password
/// resets land. For the actions that hand over long-lived credentials, the
/// proof has to be something the mailbox cannot produce.
type FactorPolicy = "any" | "totp-preferred" | "totp-only";

interface ActionPolicy {
  /// Second person, completing "confirm it's you before we …" — shown in the
  /// dialog and in the email, so the merchant can tell a real prompt from one
  /// an attacker triggered.
  label: string;
  factor: FactorPolicy;
}

export const STEP_UP_ACTIONS: Record<StepUpAction, ActionPolicy> = {
  // Reversible and self-announcing: subscribers are emailed, and an archived
  // plan is still in the record.
  "plan.delete": { label: "close a plan", factor: "any" },
  "tier.delete": { label: "remove a tier", factor: "any" },

  // Each of these hands over a credential that outlives the session asking for
  // it — an API key, or a signing secret that lets its holder forge events into
  // the merchant's own systems. Someone sitting in the mailbox must not be able
  // to mint one, so email is not accepted here at any point.
  "apikey.regenerate": { label: "issue a new API key", factor: "totp-only" },
  "webhook.reveal": { label: "show a webhook signing secret", factor: "totp-only" },
  "webhook.roll": { label: "roll a webhook signing secret", factor: "totp-only" },

  // Money movement. Same reasoning as the credentials above, and more so: an
  // emailed code cannot guard the thing an inbox intruder most wants, which is
  // to point settlement at their own address and empty the wallet.
  "wallet.change": { label: "change your payout wallet", factor: "totp-only" },
  "wallet.unlink": { label: "unlink your payout wallet", factor: "totp-only" },
  "payout.withdraw": { label: "withdraw USDC", factor: "totp-only" },

  // Turning the second factor off, or printing a new sheet of codes, is a
  // takeover step. Both are meaningless without an authenticator anyway.
  "totp.disable": { label: "turn off your authenticator", factor: "totp-only" },
  "recovery.regenerate": { label: "issue new recovery codes", factor: "totp-only" },
};

export type StepUpMethod = "email" | "totp" | "recovery";

// ─── Configuration ────────────────────────────────────────────────────────────

// Two minutes. The merchant is looking at the dialog when they ask for this, so
// the code only has to survive the trip from Resend to their inbox — and a
// credential sitting valid in a mailbox for ten minutes is ten minutes of
// exposure for no benefit.
const CODE_TTL_SECONDS = 120;
const CODE_MAX_ATTEMPTS = 5;
const TOKEN_TTL_MINUTES = 5;
const TOTP_LOCKOUT_MINUTES = 15;
const TOTP_MAX_FAILURES = 8;
const RECOVERY_CODE_COUNT = 10;

/// Off by default. The gate changes how every destructive button behaves, so it
/// ships dark and is turned on deliberately, per environment.
export function stepUpEnabled(): boolean {
  return process.env.STEP_UP_ENABLED === "true";
}

function signingSecret(): string {
  const s = process.env.PLATFORM_API_SIGNING_SECRET;
  if (!s) throw new Error("PLATFORM_API_SIGNING_SECRET is not set");
  return s;
}

function hmac(input: string): string {
  return createHmac("sha256", signingSecret()).update(input).digest("hex");
}

function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

// ─── TOTP secret at rest ──────────────────────────────────────────────────────
// The seed is a bearer credential: anything holding it can mint valid codes
// forever. It gets its own key, separate from JWT_SECRET, so that rotating
// session signing does not invalidate every merchant's authenticator — and so
// that a leaked JWT_SECRET does not also hand over the second factor.

function encryptionKey(): Buffer {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOTP_ENCRYPTION_KEY is not set — required to store authenticator secrets. " +
        "Generate one with: openssl rand -hex 32"
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOTP_ENCRYPTION_KEY must decode to 32 bytes (openssl rand -hex 32)");
  return key;
}

function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

function decryptSecret(stored: string): string {
  const [iv, tag, body] = stored.split(".");
  if (!iv || !tag || !body) throw new Error("Stored authenticator secret is malformed");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

// ─── Enrolment ────────────────────────────────────────────────────────────────

export interface TotpEnrolment {
  /// The otpauth:// URI the QR encodes.
  uri: string;
  /// The same seed in base32, for merchants who cannot scan.
  secret: string;
}

/// Begins (or restarts) enrolment. The secret is stored immediately but stays
/// unconfirmed — `totpConfirmedAt` is null — so it is not yet accepted as a
/// factor. A merchant who abandons a scan mid-way is no worse off than before.
export async function beginTotpEnrolment(merchantDbId: string, email: string): Promise<TotpEnrolment> {
  const secret = authenticator.generateSecret();
  await prisma.merchant.update({
    where: { id: merchantDbId },
    // recoveryCodes is cleared with the rest: a fresh enrolment invalidates the
    // old sheet (confirmTotpEnrolment issues a new one), and leaving the old
    // codes behind meant an account mid-re-enrolment carried live proofs for an
    // authenticator that no longer existed.
    data: { totpSecret: encryptSecret(secret), totpConfirmedAt: null, recoveryCodes: [] },
  });
  return { uri: authenticator.keyuri(email, "SweepConsole", secret), secret };
}

/// Finishes enrolment by proving the authenticator produces valid codes, and
/// returns the recovery codes ONCE — they are hashed on the way in and can
/// never be read back.
export async function confirmTotpEnrolment(merchantDbId: string, code: string): Promise<string[]> {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantDbId },
    select: { totpSecret: true, totpConfirmedAt: true },
  });
  if (!merchant.totpSecret) throw new StepUpError("Start authenticator setup first.", 409);
  if (merchant.totpConfirmedAt) throw new StepUpError("An authenticator is already active on this account.", 409);
  if (!authenticator.verify({ token: code.replace(/\s/g, ""), secret: decryptSecret(merchant.totpSecret) })) {
    throw new StepUpError("That code didn't match. Check your authenticator and try the next one.", 401);
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = randomBytes(5).toString("hex"); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await prisma.merchant.update({
    where: { id: merchantDbId },
    data: { totpConfirmedAt: new Date(), recoveryCodes: codes.map((c) => hmac(`recovery:${merchantDbId}:${c}`)) },
  });
  return codes;
}

/// Replaces the recovery codes, returning the new set once. Guarded by a
/// step-up of its own — printing a fresh set is a takeover primitive.
export async function regenerateRecoveryCodes(merchantDbId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = randomBytes(5).toString("hex");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await prisma.merchant.update({
    where: { id: merchantDbId },
    data: { recoveryCodes: codes.map((c) => hmac(`recovery:${merchantDbId}:${c}`)) },
  });
  return codes;
}

export async function disableTotp(merchantDbId: string): Promise<void> {
  await prisma.merchant.update({
    where: { id: merchantDbId },
    data: { totpSecret: null, totpConfirmedAt: null, recoveryCodes: [] },
  });
}

// ─── What this merchant can be asked for ──────────────────────────────────────

export interface MethodAvailability {
  methods: StepUpMethod[];
  /// "totp" when the authenticator is the only accepted factor for this action.
  required: "totp" | "any";
  totpEnrolled: boolean;
  /// True when the action needs an authenticator this merchant hasn't set up.
  /// `methods` is empty in that case: there is nothing to ask them for yet, so
  /// the client sends them to enrol instead of showing an unanswerable prompt.
  enrolmentRequired: boolean;
}

export async function availableMethods(merchantDbId: string, action: StepUpAction): Promise<MethodAvailability> {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantDbId },
    select: { totpConfirmedAt: true, recoveryCodes: true },
  });
  const enrolled = Boolean(merchant.totpConfirmedAt);
  const { factor } = STEP_UP_ACTIONS[action];

  const emailAccepted = factor === "any" || (factor === "totp-preferred" && !enrolled);

  const methods: StepUpMethod[] = [];
  if (enrolled) methods.push("totp");
  if (emailAccepted) methods.push("email");
  if (enrolled && merchant.recoveryCodes.length > 0) methods.push("recovery");

  return {
    methods,
    required: emailAccepted ? "any" : "totp",
    totpEnrolled: enrolled,
    enrolmentRequired: factor === "totp-only" && !enrolled,
  };
}

// ─── Emailed code ─────────────────────────────────────────────────────────────

/// Sends a code for one action. Any outstanding code for the SAME action is
/// superseded; codes for other actions are left alone, so a merchant part-way
/// through one confirmation is not silently broken by another tab.
export async function startEmailChallenge(merchantDbId: string, action: StepUpAction): Promise<{ expiresAt: Date }> {
  const availability = await availableMethods(merchantDbId, action);
  if (!availability.methods.includes("email")) {
    throw new StepUpError(
      "This action requires your authenticator app. Use a code from it, or one of your recovery codes.",
      403
    );
  }

  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantDbId },
    select: { email: true, name: true },
  });
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const purpose = `email:${action}`;
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);

  await prisma.merchantChallenge.deleteMany({ where: { merchantId: merchantDbId, purpose, consumedAt: null } });
  await prisma.merchantChallenge.create({
    data: { merchantId: merchantDbId, purpose, codeHash: hmac(`${merchantDbId}:${purpose}:${code}`), expiresAt },
  });

  // Imported lazily: email.ts pulls in nodemailer and the provider chain, and
  // this module is imported by the portal router on every request.
  const { sendEmail, stepUpEmailHtml } = await import("../email");
  await sendEmail({
    to: merchant.email,
    subject: `SweepConsole confirmation code: ${code}`,
    html: stepUpEmailHtml(code, merchant.name, STEP_UP_ACTIONS[action].label, CODE_TTL_SECONDS),
    text:
      `Your SweepConsole confirmation code is ${code}. It lets you ${STEP_UP_ACTIONS[action].label} ` +
      `and expires in ${CODE_TTL_SECONDS / 60} minutes. If you didn't ask for it, someone may have your password — ` +
      `change it and turn on an authenticator app.`,
  });

  return { expiresAt };
}

// ─── Verification ─────────────────────────────────────────────────────────────

/// Checks one factor and, on success, returns a short-lived single-use token
/// bound to this merchant AND this action. The token is what the destructive
/// route actually accepts.
export async function verifyStepUp(params: {
  merchantDbId: string;
  action: StepUpAction;
  method: StepUpMethod;
  code: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const { merchantDbId, action, method } = params;
  const code = params.code.replace(/\s/g, "");

  const availability = await availableMethods(merchantDbId, action);
  if (!availability.methods.includes(method)) {
    throw new StepUpError("That confirmation method isn't available for this action.", 403);
  }

  if (method === "email") await verifyEmailCode(merchantDbId, action, code);
  else if (method === "totp") await verifyTotpCode(merchantDbId, code);
  else await verifyRecoveryCode(merchantDbId, code);

  return issueStepUpToken(merchantDbId, action);
}

async function verifyEmailCode(merchantDbId: string, action: StepUpAction, code: string): Promise<void> {
  const purpose = `email:${action}`;
  const challenge = await prisma.merchantChallenge.findFirst({
    where: { merchantId: merchantDbId, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) throw new StepUpError("No code was sent for this action. Request one.", 409);
  if (challenge.expiresAt < new Date()) throw new StepUpError("That code has expired. Request a new one.", 410);
  if (challenge.attempts >= CODE_MAX_ATTEMPTS) throw new StepUpError("Too many attempts. Request a new code.", 429);

  if (!equalHex(challenge.codeHash, hmac(`${merchantDbId}:${purpose}:${code}`))) {
    await prisma.merchantChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    throw new StepUpError("Incorrect code.", 401);
  }
  await prisma.merchantChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
}

async function verifyTotpCode(merchantDbId: string, code: string): Promise<void> {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantDbId },
    select: { totpSecret: true, totpConfirmedAt: true },
  });
  if (!merchant.totpSecret || !merchant.totpConfirmedAt) {
    throw new StepUpError("No authenticator is set up on this account.", 409);
  }

  // TOTP has no server-side row to count against, so failures are throttled on
  // a rolling window of their own — otherwise six digits is a short guess.
  const throttle = await currentThrottle(merchantDbId);
  if (throttle && throttle.attempts >= TOTP_MAX_FAILURES) {
    throw new StepUpError("Too many incorrect codes. Try again in a few minutes.", 429);
  }

  if (!authenticator.verify({ token: code, secret: decryptSecret(merchant.totpSecret) })) {
    await recordTotpFailure(merchantDbId, throttle?.id);
    throw new StepUpError("Incorrect code.", 401);
  }

  // A TOTP code stays valid for the rest of its window (and one either side),
  // so burn it: an observer who reads it over a shoulder gets one use, not two.
  const usedPurpose = "totp-used";
  const usedHash = hmac(`${merchantDbId}:totp:${code}`);
  const alreadyUsed = await prisma.merchantChallenge.findFirst({
    where: { merchantId: merchantDbId, purpose: usedPurpose, codeHash: usedHash, expiresAt: { gt: new Date() } },
  });
  if (alreadyUsed) throw new StepUpError("That code was already used. Wait for your app's next code.", 401);
  await prisma.merchantChallenge.create({
    data: {
      merchantId: merchantDbId,
      purpose: usedPurpose,
      codeHash: usedHash,
      expiresAt: new Date(Date.now() + 120_000),
      consumedAt: new Date(),
    },
  });
}

async function verifyRecoveryCode(merchantDbId: string, code: string): Promise<void> {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantDbId },
    select: { recoveryCodes: true, totpConfirmedAt: true },
  });
  // A recovery code is the authenticator's backup, never a factor of its own.
  // availableMethods already declines to OFFER recovery when TOTP is off, but
  // that is advice to the UI — /step-up/verify takes the method from the caller,
  // so the rule has to be enforced here too. Without this, codes left over from
  // a previous enrolment would still satisfy a totp-only action on an account
  // with no authenticator at all.
  if (!merchant.totpConfirmedAt) {
    throw new StepUpError("No authenticator is set up on this account.", 409);
  }
  const wanted = hmac(`recovery:${merchantDbId}:${code.toLowerCase()}`);
  const remaining = merchant.recoveryCodes.filter((stored) => !equalHex(stored, wanted));
  if (remaining.length === merchant.recoveryCodes.length) throw new StepUpError("That recovery code isn't valid.", 401);
  // Single use: consumed by removal, so a printed sheet cannot be replayed.
  await prisma.merchant.update({ where: { id: merchantDbId }, data: { recoveryCodes: remaining } });
}

async function currentThrottle(merchantDbId: string) {
  return prisma.merchantChallenge.findFirst({
    where: { merchantId: merchantDbId, purpose: "throttle:totp", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
}

async function recordTotpFailure(merchantDbId: string, existingId?: string): Promise<void> {
  if (existingId) {
    await prisma.merchantChallenge.update({ where: { id: existingId }, data: { attempts: { increment: 1 } } });
    return;
  }
  await prisma.merchantChallenge.create({
    data: {
      merchantId: merchantDbId,
      purpose: "throttle:totp",
      codeHash: "-",
      attempts: 1,
      expiresAt: addMinutes(new Date(), TOTP_LOCKOUT_MINUTES),
    },
  });
}

// ─── The token the destructive routes accept ──────────────────────────────────

/// `<jti>.<hmac>`. The signature makes it unforgeable; the row makes it
/// single-use and revocable; the action in both makes a token minted to delete
/// a tier useless for moving the payout wallet.
async function issueStepUpToken(merchantDbId: string, action: StepUpAction): Promise<{ token: string; expiresAt: Date }> {
  const jti = randomBytes(18).toString("hex");
  const expiresAt = addMinutes(new Date(), TOKEN_TTL_MINUTES);
  await prisma.merchantChallenge.create({
    data: {
      merchantId: merchantDbId,
      purpose: `token:${action}`,
      codeHash: hmac(`token:${merchantDbId}:${action}:${jti}`),
      expiresAt,
    },
  });
  return { token: `${jti}.${hmac(`token:${merchantDbId}:${action}:${jti}`)}`, expiresAt };
}

/// Verifies and burns a token. Returns false for anything that is missing,
/// forged, expired, already spent, or minted for a different action.
export async function consumeStepUpToken(
  merchantDbId: string,
  action: StepUpAction,
  token: string | undefined
): Promise<boolean> {
  if (!token) return false;
  const [jti, signature] = token.split(".");
  if (!jti || !signature) return false;

  const expected = hmac(`token:${merchantDbId}:${action}:${jti}`);
  if (!/^[0-9a-f]+$/.test(signature) || !equalHex(expected, signature)) return false;

  // A conditional update is the burn: whoever flips consumedAt from null wins,
  // so two tabs replaying the same token cannot both get through.
  const burned = await prisma.merchantChallenge.updateMany({
    where: {
      merchantId: merchantDbId,
      purpose: `token:${action}`,
      codeHash: expected,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });
  return burned.count === 1;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/// Guards one route. Mount AFTER verifyPortalSession — it reads merchantDbId.
///
/// On a missing or spent token it answers 401 `step_up_required` and names the
/// methods this merchant may use, so the client can open the right dialog
/// without a pre-flight round trip.
export function requireStepUp(action: StepUpAction) {
  return async function stepUpGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!stepUpEnabled()) {
      next();
      return;
    }
    const merchantDbId = (req as unknown as PortalRequest).merchantDbId;
    const header = req.header("x-step-up-token") ?? undefined;

    try {
      if (await consumeStepUpToken(merchantDbId, action, header)) {
        next();
        return;
      }
      const availability = await availableMethods(merchantDbId, action);
      res.status(401).json({
        error: {
          message: `Confirm it's you before we ${STEP_UP_ACTIONS[action].label}.`,
          code: "step_up_required",
          action,
          action_label: STEP_UP_ACTIONS[action].label,
          methods: availability.methods,
          required: availability.required,
          enrolment_required: availability.enrolmentRequired,
        },
      });
    } catch (e) {
      console.error("[stepup]", action, e);
      res.status(500).json({ error: { message: "Could not verify this action", code: "step_up_failed" } });
    }
  };
}

export class StepUpError extends Error {
  constructor(message: string, public httpStatus: number) {
    super(message);
  }
}

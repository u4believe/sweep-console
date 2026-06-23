import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { addHours } from "date-fns";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { prisma } from "../lib/prisma";
import { ok, err, validationError } from "../lib/response";
import { ids } from "../lib/ids";
import { hashPassword, verifyPassword } from "../lib/password";
import { sendEmail, verificationEmailHtml, passwordResetEmailHtml } from "../lib/email";
import { getJwtSecret, verifyPortalSession, type SessionPayload, type PortalRequest } from "../middleware/portalAuth";

export const authRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_DEFAULT_DAYS = 7;
const SESSION_REMEMBER_DAYS = 30;

// Issue the portal session cookie. `remember` extends the lifetime so the
// merchant stays signed in across browser restarts.
function issueSession(
  res: Response,
  merchant: { id: string; merchantId: string; email: string; name: string; onboarded: boolean },
  remember = false
): void {
  const days = remember ? SESSION_REMEMBER_DAYS : SESSION_DEFAULT_DAYS;
  const payload: SessionPayload = {
    dbId: merchant.id,
    merchantId: merchant.merchantId,
    email: merchant.email,
    name: merchant.name,
    onboarded: merchant.onboarded,
  };
  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: `${days}d` });
  res.cookie("sweep_session", token, { ...sessionCookieOptions(), maxAge: days * DAY_MS });
}

// In production the frontend (Vercel) and API (Railway) live on different
// domains, so the session cookie must be SameSite=None + Secure to be sent on
// cross-site fetches; in dev we keep Lax over http.
function sessionCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? "none" : "lax") as "none" | "lax",
    path: "/",
  };
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  return Object.fromEntries(
    Object.entries(error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
  );
}

// ─── POST /auth/signup ────────────────────────────────────────────────────────
// Email-only: we send a verification link; name + password are set when the
// link is opened (POST /auth/verify-email).

const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional(),
});

authRouter.post("/signup", async (req, res) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, fieldErrors(parsed.error));

    const { name } = parsed.data;
    const email = parsed.data.email.toLowerCase();

    // Only block if the account is fully created (email verified + password set).
    // A pending EmailVerification is NOT a completed account — re-signup is allowed.
    const existing = await prisma.merchant.findUnique({ where: { email } });
    if (existing) {
      return err(res, "An account with this email already exists. Please sign in.", 409);
    }

    // Clear any stale pending verification for this email, then create a fresh one.
    await prisma.emailVerification.deleteMany({ where: { email } });

    const token = randomBytes(32).toString("hex");
    await prisma.emailVerification.create({
      data: { token, email, name: name ?? null, expiresAt: addHours(new Date(), 24) },
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const verifyUrl = `${appUrl}/verify-email?token=${token}`;

    try {
      await sendEmail({
        to: email,
        subject: "Verify your Sweep Console account",
        text: `Verify your email and finish creating your account:\n${verifyUrl}\n\nThis link expires in 24 hours.`,
        html: verificationEmailHtml(name ?? "there", verifyUrl),
      });
      console.log(`[auth/signup] Verification email sent to ${email}`);
    } catch (e) {
      // SMTP failure — log the link so the developer can verify manually
      console.error("[auth/signup] SMTP failed (non-fatal):", (e as Error).message);
      console.log("─────────────────────────────────────────");
      console.log("[auth/signup] VERIFY URL (click to complete signup):");
      console.log(verifyUrl);
      console.log("─────────────────────────────────────────");
    }
    return ok(res, { message: "Verification email sent. Check your inbox." });
  } catch (e) {
    console.error("[auth/signup] Unhandled error:", e);
    return err(res, "An unexpected error occurred. Please try again.", 500);
  }
});

// ─── POST /auth/verify-email ──────────────────────────────────────────────────
// Opens the verification link: sets the merchant's name + password and creates
// the account.

const verifySchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  name: z.string().min(1).max(100).optional(),
});

authRouter.post("/verify-email", async (req, res) => {
  try {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, fieldErrors(parsed.error));

    const { token, password } = parsed.data;

    const record = await prisma.emailVerification.findUnique({ where: { token } });
    if (!record) {
      return err(res, "Invalid or expired verification link.", 400);
    }

    if (record.expiresAt < new Date()) {
      await prisma.emailVerification.delete({ where: { token } });
      return err(res, "Verification link has expired. Please sign up again.", 400);
    }

    // Guard against double-submit (race condition)
    const existing = await prisma.merchant.findUnique({ where: { email: record.email } });
    if (existing) {
      await prisma.emailVerification.delete({ where: { token } });
      return err(res, "Account already created. Please sign in.", 409);
    }

    const email = record.email;
    const name =
      parsed.data.name?.trim() || record.name?.trim() || email.split("@")[0];
    const passwordHash = await hashPassword(password);
    const merchantId = ids.merchant();
    const webhookSecret = randomBytes(32).toString("hex");

    await prisma.merchant.create({
      data: {
        merchantId,
        email,
        name,
        passwordHash,
        walletType: "external",
        webhookSecret,
        // Keys are null until the merchant creates one from the API Keys page
      },
    });

    // Consume the token — account is now fully created
    await prisma.emailVerification.delete({ where: { token } });

    console.log(`[auth/verify-email] Account created for ${email} (${merchantId})`);
    return ok(res, { message: "Account created. You can now log in." });
  } catch (e) {
    console.error("[auth/verify-email] Unhandled error:", e);
    return err(res, "An unexpected error occurred. Please try again.", 500);
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  remember: z.boolean().optional(),
});

authRouter.post("/login", async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, fieldErrors(parsed.error));

    const { password, remember } = parsed.data;
    const email = parsed.data.email.toLowerCase();

    const merchant = await prisma.merchant.findUnique({ where: { email } });
    if (!merchant) return err(res, "Invalid email or password.", 401);

    // Google-only account (no password set) — steer them to the Google button.
    if (!merchant.passwordHash) {
      return err(res, "This account uses Google sign-in. Please continue with Google.", 401);
    }

    const valid = await verifyPassword(password, merchant.passwordHash);
    if (!valid) return err(res, "Invalid email or password.", 401);

    issueSession(res, merchant, remember);
    return ok(res, { ok: true });
  } catch (e) {
    console.error("[auth/login] Unhandled error:", e);
    return err(res, "An unexpected error occurred. Please try again.", 500);
  }
});

// ─── POST /auth/google ────────────────────────────────────────────────────────
// Google sign-in / sign-up. The frontend obtains an OAuth access token via
// Google Identity Services and posts it here. Google has already verified the
// email, so we create/link the account and sign in WITHOUT any verification email.

const googleSchema = z.object({
  access_token: z.string().min(1),
  remember: z.boolean().optional(),
});

interface GoogleProfile {
  email: string;
  name: string;
  sub: string;
}

async function verifyGoogleAccessToken(accessToken: string): Promise<GoogleProfile> {
  const expectedAud = process.env.GOOGLE_CLIENT_ID;

  // 1 — tokeninfo: confirm the token was minted for OUR client (anti-replay) + read email.
  const tiRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );
  const ti = (await tiRes.json().catch(() => ({}))) as {
    aud?: string; azp?: string; email?: string; email_verified?: string; error?: string;
  };
  if (!tiRes.ok || ti.error) throw new Error("Invalid Google token");
  if (expectedAud && ti.aud !== expectedAud && ti.azp !== expectedAud) {
    throw new Error("Google token was issued for a different application");
  }

  // 2 — userinfo: the display name (tokeninfo doesn't carry it).
  const uiRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ui = (await uiRes.json().catch(() => ({}))) as {
    sub?: string; email?: string; name?: string; given_name?: string;
  };
  if (!uiRes.ok) throw new Error("Could not read your Google profile");

  const email = (ui.email ?? ti.email ?? "").toLowerCase();
  const sub = ui.sub ?? "";
  if (!email || !sub) throw new Error("Your Google account did not share an email");

  return { email, sub, name: ui.name ?? ui.given_name ?? email.split("@")[0] };
}

authRouter.post("/google", async (req, res) => {
  try {
    const parsed = googleSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, fieldErrors(parsed.error));

    let profile: GoogleProfile;
    try {
      profile = await verifyGoogleAccessToken(parsed.data.access_token);
    } catch (e) {
      return err(res, (e as Error).message || "Google sign-in failed.", 401);
    }

    // Match on the Google subject first, then fall back to email (case-insensitive)
    // so an existing email/password account is LINKED to Google rather than
    // duplicated — never matched by exact case only.
    const findExisting = async () =>
      (await prisma.merchant.findUnique({ where: { googleId: profile.sub } })) ??
      (await prisma.merchant.findFirst({
        where: { email: { equals: profile.email, mode: "insensitive" } },
      }));

    let merchant = await findExisting();
    let created = false;

    if (merchant) {
      // Link the Google identity if this account doesn't have it yet.
      if (!merchant.googleId) {
        merchant = await prisma.merchant.update({
          where: { id: merchant.id },
          data: { googleId: profile.sub },
        });
      }
    } else {
      // New account — email is already verified by Google, so no email is sent.
      try {
        merchant = await prisma.merchant.create({
          data: {
            merchantId: ids.merchant(),
            email: profile.email,
            name: profile.name,
            googleId: profile.sub,
            walletType: "external",
            webhookSecret: randomBytes(32).toString("hex"),
            onboarded: false, // owes a company name — routed to /welcome
            // passwordHash stays null — this account signs in with Google
          },
        });
        created = true;
        console.log(`[auth/google] Account created for ${profile.email} (${merchant.merchantId})`);
      } catch {
        // Race / unique conflict (a concurrent request, or an account that exists
        // under a different email case) — re-fetch and link instead of failing.
        const existing = await findExisting();
        if (!existing) throw new Error("Could not create or link the Google account");
        merchant = existing.googleId
          ? existing
          : await prisma.merchant.update({
              where: { id: existing.id },
              data: { googleId: profile.sub },
            });
      }
    }

    issueSession(res, merchant, parsed.data.remember);
    return ok(res, { ok: true, created });
  } catch (e) {
    console.error("[auth/google] Unhandled error:", e);
    return err(res, "An unexpected error occurred. Please try again.", 500);
  }
});

// ─── POST /auth/complete-profile ──────────────────────────────────────────────
// Set the merchant's company/display name (used by Google onboarding, where no
// name is collected up front). Session-gated; re-issues the session so the new
// name is reflected immediately.

const completeProfileSchema = z.object({ name: z.string().min(1).max(100) });

authRouter.post("/complete-profile", verifyPortalSession, async (req, res) => {
  try {
    const parsed = completeProfileSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, fieldErrors(parsed.error));

    const dbId = (req as PortalRequest).merchantDbId;
    const merchant = await prisma.merchant.update({
      where: { id: dbId },
      data: { name: parsed.data.name.trim(), onboarded: true },
    });

    issueSession(res, merchant, true); // refresh the cookie with the updated name + onboarded
    return ok(res, { ok: true, name: merchant.name });
  } catch (e) {
    console.error("[auth/complete-profile] Unhandled error:", e);
    return err(res, "Could not save your profile. Please try again.", 500);
  }
});

// ─── POST /auth/forgot-password ───────────────────────────────────────────────
// Always returns a generic success (don't leak which emails are registered).

const forgotSchema = z.object({ email: z.string().email() });

authRouter.post("/forgot-password", async (req, res) => {
  const generic = { message: "If that email is registered, we've sent a reset link." };
  try {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, fieldErrors(parsed.error));

    const email = parsed.data.email.toLowerCase();
    const merchant = await prisma.merchant.findUnique({ where: { email } });
    if (!merchant) return ok(res, generic);

    // Single active token per email.
    await prisma.passwordReset.deleteMany({ where: { email } });
    const token = randomBytes(32).toString("hex");
    await prisma.passwordReset.create({
      data: { token, email, expiresAt: addHours(new Date(), 1) },
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const resetUrl = `${appUrl}/reset-password?token=${token}`;

    try {
      await sendEmail({
        to: email,
        subject: "Reset your Sweep Console password",
        text: `Reset your password:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
        html: passwordResetEmailHtml(merchant.name, resetUrl),
      });
      console.log(`[auth/forgot-password] Reset email sent to ${email}`);
    } catch (e) {
      console.error("[auth/forgot-password] SMTP failed (non-fatal):", (e as Error).message);
      console.log("─────────────────────────────────────────");
      console.log("[auth/forgot-password] RESET URL:");
      console.log(resetUrl);
      console.log("─────────────────────────────────────────");
    }
    return ok(res, generic);
  } catch (e) {
    console.error("[auth/forgot-password] Unhandled error:", e);
    return ok(res, generic); // still generic — never reveal internals here
  }
});

// ─── POST /auth/reset-password ────────────────────────────────────────────────

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

authRouter.post("/reset-password", async (req, res) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, fieldErrors(parsed.error));

    const { token, password } = parsed.data;
    const record = await prisma.passwordReset.findUnique({ where: { token } });
    if (!record || record.expiresAt < new Date()) {
      if (record) await prisma.passwordReset.delete({ where: { token } }).catch(() => {});
      return err(res, "This reset link is invalid or has expired. Please request a new one.", 400);
    }

    const merchant = await prisma.merchant.findUnique({ where: { email: record.email } });
    if (!merchant) {
      await prisma.passwordReset.delete({ where: { token } }).catch(() => {});
      return err(res, "This reset link is invalid or has expired. Please request a new one.", 400);
    }

    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { passwordHash: await hashPassword(password) },
    });
    await prisma.passwordReset.deleteMany({ where: { email: record.email } });

    console.log(`[auth/reset-password] Password reset for ${record.email}`);
    return ok(res, { message: "Password updated. You can now sign in." });
  } catch (e) {
    console.error("[auth/reset-password] Unhandled error:", e);
    return err(res, "An unexpected error occurred. Please try again.", 500);
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

authRouter.post("/logout", (_req, res) => {
  res.clearCookie("sweep_session", sessionCookieOptions());
  return ok(res, { ok: true });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

authRouter.get("/me", (req, res) => {
  const token = req.cookies?.["sweep_session"] as string | undefined;
  if (!token) return err(res, "Not authenticated", 401);

  try {
    const payload = jwt.verify(token, getJwtSecret()) as SessionPayload;
    return ok(res, {
      id: payload.dbId,
      merchantId: payload.merchantId,
      email: payload.email,
      name: payload.name,
      onboarded: payload.onboarded ?? true,
    });
  } catch {
    return err(res, "Session expired", 401);
  }
});

// Email-anchored customer identity + OTP-on-first-link.
//
// The platform's identity anchor is the EMAIL. A customer can connect different
// wallets over time; the verified email is what persists, so developer webhooks
// carry a stable customerId across wallet changes. Email ownership is proven
// once with a 6-digit OTP; returning wallets are recognized without re-proving.

import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { addMinutes } from "date-fns";
import { prisma } from "../prisma";
import { ids } from "../ids";
import { sendEmail, otpEmailHtml } from "../email";

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const EMAIL_TOKEN_TTL_MS = 30 * 60_000; // a verified-email proof is good for 30 min

function secret(): string {
  const s = process.env.PLATFORM_API_SIGNING_SECRET;
  if (!s) throw new Error("PLATFORM_API_SIGNING_SECRET is not set");
  return s;
}

function hmac(input: string): string {
  return createHmac("sha256", secret()).update(input).digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ─── OTP request / verify ───────────────────────────────────────────────────

export async function requestEmailOtp(emailRaw: string, merchantName: string): Promise<void> {
  const email = normalizeEmail(emailRaw);
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");

  // Supersede any outstanding codes for this email
  await prisma.checkoutOtp.deleteMany({ where: { email, consumedAt: null } });
  await prisma.checkoutOtp.create({
    data: { email, codeHash: hmac(`${email}:${code}`), expiresAt: addMinutes(new Date(), OTP_TTL_MINUTES) },
  });

  await sendEmail({
    to: email,
    subject: `Your ${merchantName} confirmation code: ${code}`,
    html: otpEmailHtml(code, merchantName),
    text: `Your confirmation code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
  });
}

/// Verifies a code. On success returns a short-lived signed token proving this
/// email was verified, which the activation endpoints accept when linking a new
/// wallet. Throws on invalid/expired/too-many-attempts.
export async function verifyEmailOtp(emailRaw: string, code: string): Promise<string> {
  const email = normalizeEmail(emailRaw);
  const otp = await prisma.checkoutOtp.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) throw new OtpError("No code was requested for this email.", 409);
  if (otp.expiresAt < new Date()) throw new OtpError("This code has expired. Request a new one.", 410);
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new OtpError("Too many attempts. Request a new code.", 429);

  const expected = Buffer.from(otp.codeHash, "hex");
  const provided = Buffer.from(hmac(`${email}:${code.trim()}`), "hex");
  const ok = expected.length === provided.length && timingSafeEqual(expected, provided);

  if (!ok) {
    await prisma.checkoutOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw new OtpError("Incorrect code.", 401);
  }

  await prisma.checkoutOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

  // The per-merchant customer is created at checkout completion (resolveCheckoutCustomer),
  // which has the merchant context. The token below proves email ownership.
  return issueEmailToken(email);
}

export class OtpError extends Error {
  constructor(message: string, public httpStatus: number) {
    super(message);
  }
}

// ─── Signed email-verification token ──────────────────────────────────────────

export function issueEmailToken(emailRaw: string): string {
  const email = normalizeEmail(emailRaw);
  const exp = Date.now() + EMAIL_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ email, exp })).toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

export function verifyEmailToken(token: string | undefined, emailRaw: string): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  if (hmac(payload) !== sig) return false;
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      email: string; exp: number;
    };
    return email === normalizeEmail(emailRaw) && Date.now() < exp;
  } catch {
    return false;
  }
}

// ─── Customer resolution ──────────────────────────────────────────────────────

async function upsertVerifiedCustomer(merchantId: string, email: string) {
  return prisma.customer.upsert({
    where: { merchantId_email: { merchantId, email } },
    create: { customerId: ids.customer(), merchantId, email, emailVerifiedAt: new Date() },
    update: { emailVerifiedAt: new Date() },
  });
}

export interface CustomerLookup {
  linked: boolean;
  verified: boolean;
  emailMasked: string | null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const maskedLocal = local.length <= 2 ? `${local[0] ?? "*"}***` : `${local.slice(0, 2)}***`;
  const dot = domain.lastIndexOf(".");
  return `${maskedLocal}@${domain[0] ?? "*"}***${dot >= 0 ? domain.slice(dot) : ""}`;
}

export function maskWallet(address: string): string {
  return address.length >= 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : "0x…";
}

export interface CustomerEmailRecall {
  known: boolean;
  verified: boolean;
  walletMasked: string | null; // most-recently-used wallet on file (masked)
}

/// Email-anchored recall (per merchant): the EMAIL is the identity, so the
/// checkout recognises a returning customer by the email they enter and recalls
/// the wallet they last paid with here. Returns only a masked wallet.
export async function lookupCustomerByEmail(
  merchantId: string,
  emailRaw: string
): Promise<CustomerEmailRecall> {
  const email = normalizeEmail(emailRaw);
  const customer = await prisma.customer.findUnique({
    where: { merchantId_email: { merchantId, email } },
    include: { wallets: { orderBy: { lastUsedAt: "desc" }, take: 1 } },
  });
  if (!customer) return { known: false, verified: false, walletMasked: null };
  const wallet = customer.wallets[0]?.address ?? null;
  return {
    known: true,
    verified: !!customer.emailVerifiedAt,
    walletMasked: wallet ? maskWallet(wallet) : null,
  };
}

export interface ProvenCustomer {
  customerDbId: string;
  customerId: string;
  email: string;
  wallets: { address: string; lastUsedAt: Date }[];
}

/// Gate for revealing a customer's UN-masked identity (full email + linked
/// wallets + active subscriptions) at checkout. Returns the customer ONLY when
/// email ownership is proven by a valid email-verification token (the OTP proof
/// from verifyEmailOtp). A bare email OR a wallet address in the request body is
/// NOT proof — both are attacker-suppliable — so neither can unmask a customer's
/// wallets here. (A wallet-signature proof could be added later for returning
/// wallets, but mere connection is not cryptographic proof of control.)
export async function resolveProvenCustomer(params: {
  merchantId: string;
  email: string;
  emailToken?: string | null;
}): Promise<ProvenCustomer | null> {
  const email = normalizeEmail(params.email);
  if (!params.emailToken || !verifyEmailToken(params.emailToken, email)) return null;

  const customer = await prisma.customer.findUnique({
    where: { merchantId_email: { merchantId: params.merchantId, email } },
    include: { wallets: { orderBy: { lastUsedAt: "desc" } } },
  });
  if (!customer) return null;

  return {
    customerDbId: customer.id,
    customerId: customer.customerId,
    email: customer.email,
    wallets: customer.wallets.map((w) => ({ address: w.address, lastUsedAt: w.lastUsedAt })),
  };
}

/// What the checkout asks on wallet connect: does this wallet already belong to
/// a known (verified) customer OF THIS MERCHANT? Returns only a masked email.
/// A wallet linked at another merchant is NOT recognised here.
export async function lookupCustomerByWallet(
  merchantId: string,
  address: string
): Promise<CustomerLookup> {
  const link = await prisma.customerWallet.findUnique({
    where: { merchantId_address: { merchantId, address: address.toLowerCase() } },
    include: { customer: true },
  });
  if (!link?.customer.email) return { linked: false, verified: false, emailMasked: null };
  return {
    linked: true,
    verified: !!link.customer.emailVerifiedAt,
    emailMasked: maskEmail(link.customer.email),
  };
}

/// Resolves the email-anchored customer for a completing checkout and links the
/// wallet to it. A known wallet recalls its customer with no token; a new wallet
/// requires a verified-email token (OTP proof) before it can be linked.
export async function resolveCheckoutCustomer(params: {
  merchantId: string;
  walletAddress: string;
  email?: string | null;
  emailToken?: string | null;
}): Promise<{ customerDbId: string; customerId: string; email: string } | null> {
  const { merchantId } = params;
  const address = params.walletAddress.toLowerCase();

  // Recall is scoped to this merchant: a wallet known at another merchant still
  // links fresh here.
  const existing = await prisma.customerWallet.findUnique({
    where: { merchantId_address: { merchantId, address } },
    include: { customer: true },
  });
  if (existing) {
    await prisma.customerWallet.update({ where: { id: existing.id }, data: { lastUsedAt: new Date() } });
    return {
      customerDbId: existing.customerId,
      customerId: existing.customer.customerId,
      email: existing.customer.email,
    };
  }

  // New wallet for this merchant — must come with a verified-email token (OTP proof)
  if (!params.email || !verifyEmailToken(params.emailToken ?? undefined, params.email)) {
    return null;
  }
  const email = normalizeEmail(params.email);
  const customer = await upsertVerifiedCustomer(merchantId, email);
  await prisma.customerWallet.create({ data: { merchantId, customerId: customer.id, address } });
  return { customerDbId: customer.id, customerId: customer.customerId, email };
}

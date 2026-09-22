// Who may operate this platform, as opposed to sell on it.
//
// An operator is a normal portal account whose email appears in
// PLATFORM_ADMIN_EMAILS. Identity rather than a shared secret, deliberately: two
// people granting money-moving entitlements need "who did this" to have an
// answer, and a bearer token pasted between machines cannot give one.
//
// SET IT PER SERVICE, NEVER IN A COMMITTED FILE. Every environment here points
// at the same database, so an admin list that travels with the code would make
// any laptop running the app an operator over production data.

import type { Request } from "express";
import { prisma } from "../prisma";
import type { PortalRequest } from "../../middleware/portalAuth";

function adminEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = adminEmails();
  // An empty list means nobody, never everybody — a missing variable must fail
  // closed, or forgetting to set it on one service hands the panel to the world.
  return list.length > 0 && list.includes(email.toLowerCase());
}

/// The signed-in account's email, or null. Read from the database rather than
/// the session so removing an operator takes effect on their next request
/// instead of whenever their cookie happens to expire.
export async function sessionEmail(req: Request): Promise<string | null> {
  const dbId = (req as PortalRequest).merchantDbId;
  if (!dbId) return null;
  const m = await prisma.merchant.findUnique({ where: { id: dbId }, select: { email: true } });
  return m?.email ?? null;
}

export async function isAdminRequest(req: Request): Promise<boolean> {
  return isAdminEmail(await sessionEmail(req));
}

/// Everyone who should hear about an access request. Falls back to SUPPORT_EMAIL
/// so a deploy that has not set the admin list still reaches someone.
export function adminNotificationRecipients(): string[] {
  const admins = adminEmails();
  if (admins.length > 0) return admins;
  const support = process.env.SUPPORT_EMAIL;
  return support ? [support] : [];
}

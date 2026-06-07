import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err } from "@/lib/api/response";

// GET /v1/passport/status?wallet_address=0x...
export async function GET(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { searchParams } = new URL(req.url);
  const walletAddress = searchParams.get("wallet_address");

  if (!walletAddress) return err("wallet_address query parameter is required", 400);

  const passport = await prisma.passport.findUnique({
    where: { walletAddress: walletAddress.toLowerCase() },
  });

  if (!passport || !passport.isValid) {
    return ok({ has_passport: false, passport: null });
  }

  return ok({
    has_passport: true,
    passport: {
      id: passport.passportId,
      wallet_address: passport.walletAddress,
      issued_at: passport.issuedAt.toISOString(),
    },
  });
}

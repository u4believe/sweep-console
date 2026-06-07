import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { CheckoutShell } from "@/components/checkout/CheckoutShell";

interface Props {
  params: Promise<{ session_id: string }>;
}

export default async function CheckoutPage({ params }: Props) {
  const { session_id } = await params;

  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId: session_id },
    include: {
      plan: true,
      merchant: { select: { name: true, merchantId: true } },
    },
  });

  if (!session) notFound();

  if (session.status === "complete") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="card w-full max-w-md p-8 text-center">
          <div className="mb-4 text-5xl">&#10003;</div>
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Already activated</h1>
          <p className="text-gray-500">This subscription is already active.</p>
        </div>
      </div>
    );
  }

  if (session.status === "expired" || new Date() > session.expiresAt) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="card w-full max-w-md p-8 text-center">
          <div className="mb-4 text-5xl">&#9203;</div>
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Session expired</h1>
          <p className="text-gray-500">This checkout link has expired. Please request a new one.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <CheckoutShell
        sessionId={session.sessionId}
        sessionToken={session.sessionToken}
        plan={{
          name: session.plan.name,
          description: session.plan.description ?? "",
          amount: Number(session.plan.amount),
          currency: session.plan.currency,
          interval: session.plan.interval,
          trialDays: session.plan.trialDays,
        }}
        merchant={{ name: session.merchant.name }}
        isTestMode={session.isTestMode}
        cancelUrl={session.cancelUrl}
      />
    </div>
  );
}

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckoutShell, type OnChainParams } from "@/components/checkout/CheckoutShell";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface SessionData {
  status: "open" | "complete" | "expired";
  sessionId: string;
  sessionToken: string;
  plan: {
    name: string;
    description: string;
    amount: number;
    currency: string;
    interval: string;
    trialDays: number;
    defaultTierName?: string | null;
    defaultFeatures?: string[] | null;
  };
  tiers?: {
    id: string;
    name: string;
    amount: number;
    interval: string;
    trialDays: number;
    features: string[] | null;
  }[];
  merchant: { name: string };
  isTestMode: boolean;
  cancelUrl: string;
  onchain: OnChainParams;
}

export function CheckoutPage() {
  const { session_id } = useParams<{ session_id: string }>();
  const [session, setSession] = useState<SessionData | null>(null);
  const [status, setStatus] = useState<"loading" | "open" | "complete" | "expired" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!session_id) { setStatus("error"); return; }

    fetch(`${API_URL}/checkout/${session_id}`)
      .then((r) => r.json())
      .then((data: SessionData & { error?: { message?: string } }) => {
        if (data.error) {
          setErrorMsg(data.error.message ?? "");
          setStatus("error");
        } else if (data.status === "open") {
          setSession(data);
          setStatus("open");
        } else {
          setStatus(data.status);
        }
      })
      .catch(() => setStatus("error"));
  }, [session_id]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-400">Loading checkout…</div>
      </div>
    );
  }

  if (status === "complete") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="card w-full max-w-md p-8 text-center">
          <div className="mb-4 text-5xl">✓</div>
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Already activated</h1>
          <p className="text-gray-500">This subscription is already active.</p>
        </div>
      </div>
    );
  }

  if (status === "expired") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="card w-full max-w-md p-8 text-center">
          <div className="mb-4 text-5xl">⏳</div>
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Session expired</h1>
          <p className="text-gray-500">This checkout link has expired. Please request a new one.</p>
        </div>
      </div>
    );
  }

  if (status === "error" || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="card w-full max-w-md p-8 text-center">
          <h1 className="mb-2 text-2xl font-bold text-gray-900">
            {errorMsg ? "Checkout unavailable" : "Not found"}
          </h1>
          <p className="text-gray-500">{errorMsg || "This checkout session does not exist."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <CheckoutShell
        sessionId={session.sessionId}
        sessionToken={session.sessionToken}
        plan={session.plan}
        tiers={session.tiers ?? []}
        merchant={session.merchant}
        isTestMode={session.isTestMode}
        cancelUrl={session.cancelUrl}
        onchain={session.onchain}
      />
    </div>
  );
}

import { TestModeBanner } from "@/components/checkout/TestModeBanner";
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
    recommendedTierId?: string | null;
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

/**
 * A status screen — a card on the ground, matching the checkout it stands in
 * for. It was a headline under a rule, which is the shape the rest of this
 * flow no longer has.
 */
function CheckoutStatus({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: "var(--color-neutral-200)", padding: "24px clamp(16px,3vw,32px)" }}
    >
      <div
        className="swp-in"
        style={{
          maxWidth: 480,
          width: "100%",
          background: "var(--color-bg)",
          borderRadius: "var(--radius-lg)",
          padding: "30px 28px",
          boxShadow: "0 0 0 1px var(--color-neutral-400), var(--shadow-lg)",
        }}
      >
        <h1 className="m-0" style={{ fontSize: "clamp(22px, 3vw, 28px)", letterSpacing: "-0.03em", marginBottom: 10 }}>
          {title}
        </h1>
        <p className="m-0" style={{ fontSize: 15, lineHeight: 1.6, color: "var(--color-neutral-800)" }}>{body}</p>
      </div>
    </div>
  );
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
    return <CheckoutStatus title="Loading checkout…" body="One moment while we fetch this session." />;
  }

  if (status === "complete") {
    return <CheckoutStatus title="Already activated" body="This subscription is already active." />;
  }

  if (status === "expired") {
    return <CheckoutStatus title="Session expired" body="This checkout link has expired. Please request a new one." />;
  }

  if (status === "error" || !session) {
    return (
      <CheckoutStatus
        title={errorMsg ? "Checkout unavailable" : "Not found"}
        body={errorMsg || "This checkout session does not exist."}
      />
    );
  }

  // CheckoutShell renders its own full-height frame (header, step rail, ground),
  // so it is mounted bare rather than centred inside a wrapper.
  return (
    <>
      <TestModeBanner />
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
    </>
  );
}

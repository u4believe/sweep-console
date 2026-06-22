import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

// A payment link goes straight to the pricing/checkout — no intermediate
// single-plan page. On load we mint a checkout session and redirect.
export function PaymentLinkPage() {
  const { link_id } = useParams<{ link_id: string }>();
  const [searchParams] = useSearchParams();
  const [errorMsg, setErrorMsg] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (!link_id || started.current) return;
    started.current = true;
    (async () => {
      try {
        // The sharer may append ?ref=<their user id>; otherwise the server
        // generates a stable external_ref for this subscription.
        const ref = searchParams.get("ref");
        const res = await fetch(`${API_URL}/pay/${link_id}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ref ? { external_ref: ref } : {}),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error((data as { error?: { message?: string } }).error?.message ?? "This payment link is unavailable.");
        }
        window.location.assign((data as { checkout_url: string }).checkout_url);
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : "This payment link is unavailable.");
      }
    })();
  }, [link_id, searchParams]);

  if (errorMsg) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-xl">
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Link unavailable</h1>
          <p className="text-gray-500">{errorMsg}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        Preparing your checkout…
      </div>
    </div>
  );
}

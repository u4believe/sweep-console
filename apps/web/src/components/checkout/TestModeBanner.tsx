import { useEffect, useState } from "react";
import { fetchConfig } from "@/lib/gateway";

/**
 * Says so when a payer-facing page is NOT handling real money.
 *
 * It marks the exception rather than the norm. A banner on every live payment
 * page would be noise a payer learns to skip, and then the one that matters
 * goes unread; a banner that appears only on testnet keeps its meaning, and
 * its absence comes to mean something too.
 *
 * The risk it answers runs in the direction people expect least. A payer on
 * the sandbox mistaking it for real is merely confused. A developer opening
 * the LIVE checkout believing it is test and granting a real USDC spending
 * permission over their own wallet has signed an on-chain authorization, and
 * nothing on the page contradicted them — the chain names are the same, the
 * flow is the same, and sweepconsole.xyz now serves mainnet.
 *
 * The mode comes from the API, never the hostname: the deployment decides it,
 * and a hostname can point anywhere.
 */
export function TestModeBanner() {
  const [isTest, setIsTest] = useState(false);

  useEffect(() => {
    let alive = true;
    // A failed read shows nothing rather than guessing. Claiming "test" on a
    // live page is the one wrong answer that could cost someone money.
    fetchConfig()
      .then((c) => { if (alive) setIsTest(c.mode === "test"); })
      .catch(() => { /* leave it off */ });
    return () => { alive = false; };
  }, []);

  if (!isTest) return null;

  return (
    <div
      role="status"
      style={{
        background: "var(--color-accent-100, #FFF4E5)",
        borderBottom: "1px solid var(--color-divider)",
        padding: "8px 16px",
        fontSize: 12.5,
        lineHeight: 1.45,
        textAlign: "center",
        color: "var(--color-neutral-800)",
      }}
    >
      <strong style={{ fontWeight: 600 }}>Test mode</strong> — this is a sandbox. No real funds
      move, and any permission you grant is on a test network.
    </div>
  );
}

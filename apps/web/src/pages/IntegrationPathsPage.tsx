/**
 * Hosted checkout, or the payment rail — the two ways in, side by side.
 *
 * It exists because the choice is the first thing a developer has to make and
 * the hardest thing to undo: the two paths differ in who builds the UI, who
 * decides when money moves, and how long it takes to ship. A plan page
 * explains pricing; nothing explained this.
 *
 * THE CODE SAMPLES ARE THE REAL API. The design's mockup showed
 * `@sweep/react`, `POST /v1/rail/mandate_links` and a `rail.charge.settled`
 * event — none of which exist. A sample a developer can paste and watch fail
 * is worse than no sample, so these are checked against routes/mandates.ts,
 * routes/charges.ts and the event names the webhook actually sends.
 */

import { useState } from "react";
import { Link } from "react-router-dom";

type Tab = "client" | "server" | "webhook";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "client", label: "Client" },
  { id: "server", label: "Server" },
  { id: "webhook", label: "Webhook" },
];

const SAMPLES: Record<Tab, string> = {
  client: `// 1. Drop the authorize button into your own page.
//    It opens the checkout over your page, not instead of it.
import { SweepAuthorize } from "@sweepconsole/react";

<SweepAuthorize
  session="/api/sweep/mandate-link"
  onAuthorized={(m) => saveMandate(m.mandate_id)}
>
  Authorize with wallet
</SweepAuthorize>`,

  server: `// 2. Your endpoint creates the mandate. The payer's id comes from
//    YOUR session — never from the page, or the customer picks it.
app.post("/api/sweep/mandate-link", requireLogin, async (req, res) => {
  const mandate = await sweep.mandates.create({
    externalRef: req.user.id,
    maxAmount: usdc("35.00"),   // the ceiling, with headroom — not the price
    interval: "monthly",
    chains: ["base", "arbitrum", "optimism"],
    expiresAt: addYears(new Date(), 1),
  });
  res.json({ url: mandate.authorizationUrl });
});

// 3. Charge against it whenever your app decides.
await sweep.charges.create({
  mandate: mandate.id,
  amount: usdc("2.00"),
  description: "usage overage",
});`,

  webhook: `// 4. Listen for the results.
switch (event.type) {
  case "mandate.authorized":
    activateAccount(event.data.external_ref);
    break;
  case "charge.succeeded":
    markInvoicePaid(event.data.charge_id);
    break;
  case "charge.failed":
    retryOrDunning(event.data.charge_id);
    break;
  case "mandate.revoked":
    pauseAccount(event.data.external_ref);
    break;
}`,
};

interface Path {
  tag: string;
  who: string;
  title: string;
  body: string;
  steps: Array<{ t: string; owner: string }>;
  best: string[];
  cta: { label: string; to: string };
  dark?: boolean;
}

const PATHS: Path[] = [
  {
    tag: "Hosted checkout",
    who: "No code · for any business",
    title: "We host the checkout",
    body:
      "Create plans and tiers in the console, then share a link or redirect to it. " +
      "Subscribers verify their email, connect a wallet and pay. Renewals run on their own.",
    steps: [
      { t: "Create a plan with tiers", owner: "You, in the console" },
      { t: "Share the checkout link", owner: "You — email, site, or redirect" },
      { t: "Subscriber pays with one signature", owner: "Sweep-hosted page" },
      { t: "Renewals charge automatically", owner: "Sweep Console" },
    ],
    best: [
      "Fixed-price subscriptions",
      "Launch today, with no frontend work",
      "Tiers, trials and receipts built in",
    ],
    cta: { label: "Create a plan", to: "/plans/new" },
  },
  {
    tag: "Payment rail",
    who: "For developers",
    title: "You build the checkout",
    body:
      "The payer signs a spending ceiling once. Your backend decides when and how much " +
      "to charge — which is what usage-based and variable billing need.",
    steps: [
      { t: "Create a mandate via the API", owner: "Your backend" },
      { t: "Payer authorizes on your page", owner: "Your UI + the authorize button" },
      { t: "Charge against the ceiling", owner: "Your backend, any time" },
      { t: "Get a webhook for every result", owner: "Your handler" },
    ],
    best: [
      "Usage, metered or variable pricing",
      "Full control over the checkout design",
      "Charge only when your app decides",
    ],
    cta: { label: "Set up the rail", to: "/rail" },
    dark: true,
  },
];

/**
 * What actually differs. Only rows where the two answers are NOT the same —
 * a comparison table whose rows all read "both" teaches nothing and buries
 * the three that decide it.
 *
 * Gas and settlement are identical on both paths, and that is worth one line
 * underneath rather than a row implying it might not be.
 */
const COMPARE: Array<{ k: string; hosted: string; rail: string }> = [
  { k: "Who builds the UI", hosted: "Sweep Console", rail: "You" },
  { k: "Pricing", hosted: "Fixed plans and tiers", rail: "Any amount up to the ceiling" },
  { k: "When charges happen", hosted: "On the plan's schedule", rail: "When your backend calls the API" },
  { k: "The payer signs", hosted: "Once, at checkout", rail: "Once, for the mandate" },
  { k: "Time to ship", hosted: "Minutes", rail: "A day or two of work" },
];

export function IntegrationPathsPage() {
  const [tab, setTab] = useState<Tab>("client");

  return (
    <div style={{ background: "var(--color-bg)", minHeight: "100vh" }}>
      <div className="mx-auto w-full max-w-5xl px-5 py-14">
        <p
          className="m-0"
          style={{
            fontSize: 11, fontWeight: 600, letterSpacing: "0.1em",
            textTransform: "uppercase", color: "var(--color-accent)",
          }}
        >
          Integration paths
        </p>
        <h1 className="mt-3" style={{ fontSize: 38, letterSpacing: "-0.025em", margin: 0 }}>
          Use our checkout, or build your own.
        </h1>
        <p className="mt-3" style={{ fontSize: 16, color: "var(--color-neutral-800)", maxWidth: 620 }}>
          Both settle in USDC on Arc, and on both the network fee is ours. What differs is who
          builds the page the payer sees, and who decides when money moves.
        </p>

        {/* The two paths */}
        <div className="mt-10 grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
          {PATHS.map((p) => (
            <section
              key={p.tag}
              style={{
                background: p.dark ? "var(--color-neutral-100)" : "var(--color-bg)",
                border: "1px solid var(--color-neutral-400)",
                borderRadius: "var(--radius-lg)",
                padding: 26,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div className="flex items-center gap-2.5" style={{ flexWrap: "wrap" }}>
                <span
                  style={{
                    fontSize: 11, fontWeight: 600, padding: "4px 9px",
                    borderRadius: "var(--radius-sm)",
                    background: p.dark ? "var(--color-text)" : "var(--color-accent-200)",
                    color: p.dark ? "var(--color-bg)" : "var(--color-accent)",
                  }}
                >
                  {p.tag}
                </span>
                <span style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>{p.who}</span>
              </div>

              <h2 className="mt-4" style={{ fontSize: 22, margin: 0, letterSpacing: "-0.02em" }}>{p.title}</h2>
              <p className="mt-2" style={{ fontSize: 14, color: "var(--color-neutral-800)", lineHeight: 1.6 }}>
                {p.body}
              </p>

              <ol className="mt-5" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {p.steps.map((s, i) => (
                  <li
                    key={s.t}
                    className="flex gap-3"
                    style={{ padding: "10px 0", borderTop: i === 0 ? "none" : "1px solid var(--color-divider)" }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)", fontSize: 11,
                        color: "var(--color-neutral-600)", paddingTop: 2, flex: "none",
                      }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span>
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{s.t}</span>
                      <br />
                      <span style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>{s.owner}</span>
                    </span>
                  </li>
                ))}
              </ol>

              <ul className="mt-5" style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {p.best.map((b) => (
                  <li key={b} className="flex gap-2" style={{ fontSize: 13, color: "var(--color-neutral-800)", padding: "3px 0" }}>
                    <span style={{ color: "var(--color-accent)" }} aria-hidden="true">·</span>
                    {b}
                  </li>
                ))}
              </ul>

              <Link
                to={p.cta.to}
                className="mt-6 block"
                style={{
                  textAlign: "center", padding: "11px 18px",
                  borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: 14,
                  background: p.dark ? "var(--color-text)" : "var(--color-accent)",
                  color: "var(--color-bg)", textDecoration: "none",
                  marginTop: "auto",
                }}
              >
                {p.cta.label}
              </Link>
            </section>
          ))}
        </div>

        {/* The rail, in code */}
        <h2 className="mt-14" style={{ fontSize: 24, letterSpacing: "-0.02em", margin: 0 }}>
          The rail, end to end
        </h2>
        <p className="mt-2" style={{ fontSize: 14, color: "var(--color-neutral-800)" }}>
          Four steps. The payer signs once; everything after that is your backend deciding.
        </p>

        <div
          className="mt-5"
          style={{
            border: "1px solid var(--color-neutral-400)",
            borderRadius: "var(--radius-lg)",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", borderBottom: "1px solid var(--color-divider)", padding: "0 8px" }}>
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? "true" : undefined}
                style={{
                  padding: "11px 14px", fontSize: 13, fontWeight: 600,
                  background: "transparent", border: "none", cursor: "pointer",
                  color: tab === t.id ? "var(--color-accent)" : "var(--color-neutral-700)",
                  borderBottom: `2px solid ${tab === t.id ? "var(--color-accent)" : "transparent"}`,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <pre
            style={{
              margin: 0, padding: "20px 22px", overflowX: "auto",
              background: "var(--color-neutral-100)",
              fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.7,
              color: "var(--color-neutral-900)",
            }}
          >
            <code>{SAMPLES[tab]}</code>
          </pre>
        </div>

        {/* Side by side */}
        <h2 className="mt-14" style={{ fontSize: 24, letterSpacing: "-0.02em", margin: 0 }}>Side by side</h2>
        <table className="table mt-4" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: "34%" }} />
              <th>Hosted checkout</th>
              <th>Payment rail</th>
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((r) => (
              <tr key={r.k}>
                <td style={{ color: "var(--color-neutral-700)" }}>{r.k}</td>
                <td>{r.hosted}</td>
                <td>{r.rail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
          Gas and settlement are the same on both: the network fee is covered, and the money
          lands as USDC on Arc.
        </p>

        <p className="mt-10" style={{ fontSize: 14 }}>
          <Link to="/docs" style={{ color: "var(--color-accent)", fontWeight: 600 }}>
            Read the full documentation →
          </Link>
        </p>
      </div>
    </div>
  );
}

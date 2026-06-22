import { useState } from "react";
import { Link } from "react-router-dom";
import { clsx } from "clsx";

type Billing = "monthly" | "yearly";

interface Tier {
  name: string;
  monthly: number | null; // null = custom
  blurb: string;
  features: string[];
  cta: string;
  to: string;
  highlight?: boolean;
  unit?: string; // e.g. "/seat/mo"
}

const individual: Tier[] = [
  {
    name: "Starter",
    monthly: 0,
    blurb: "Includes",
    cta: "Start free",
    to: "/signup",
    features: [
      "Accept USDC subscriptions",
      "1 active plan with free trials",
      "Hosted, shareable checkout",
      "Basic dashboard & email receipts",
    ],
  },
  {
    name: "Pro",
    monthly: 29,
    blurb: "Everything in Starter, plus",
    cta: "Get Pro",
    to: "/signup",
    highlight: true,
    features: [
      "Cross-chain payments — Base, Arbitrum & Optimism",
      "Tiered plans & coupons",
      "Webhooks, API keys & test mode",
      "Gasless renewals (gas on us)",
      "Priority settlement on Arc",
    ],
  },
  {
    name: "Scale",
    monthly: 99,
    blurb: "Everything in Pro, plus",
    cta: "Get Scale",
    to: "/signup",
    features: [
      "Higher volume limits",
      "Advanced revenue analytics",
      "Custom checkout branding",
      "Priority email & chat support",
    ],
  },
];

const team: Tier[] = [
  {
    name: "Team",
    monthly: 199,
    unit: "/mo",
    blurb: "Everything in Pro, plus",
    cta: "Get Team",
    to: "/signup",
    features: [
      "Up to 10 team seats",
      "Role-based access control",
      "Centralized team billing",
      "SAML / OIDC SSO",
      "Shared webhooks & API keys",
    ],
  },
  {
    name: "Enterprise",
    monthly: null,
    blurb: "Everything in Team, plus",
    cta: "Contact sales",
    to: "/signup",
    features: [
      "Unlimited seats",
      "Dedicated settlement infrastructure",
      "Custom platform fees & limits",
      "SLA & priority support",
      "Dedicated account manager",
    ],
  },
];

function priceFor(monthly: number | null, billing: Billing): { value: string; suffix: string } {
  if (monthly === null) return { value: "Custom", suffix: "" };
  if (monthly === 0) return { value: "Free", suffix: "" };
  const value = billing === "yearly" ? Math.round(monthly * 0.8) : monthly;
  return { value: `$${value}`, suffix: "/mo" };
}

function Check() {
  return (
    <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
      <svg className="h-2.5 w-2.5" viewBox="0 0 20 20" fill="none">
        <path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function PlanCard({ tier, billing, wide }: { tier: Tier; billing: Billing; wide?: boolean }) {
  const { value, suffix } = priceFor(tier.monthly, billing);
  return (
    <div
      className={clsx(
        "group relative flex flex-col overflow-hidden rounded-3xl border bg-white p-8 transition-all duration-200 hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl",
        tier.highlight
          ? "border-brand-200 shadow-2xl shadow-brand-500/20"
          : "border-gray-200 shadow-sm",
        wide && "lg:p-10"
      )}
    >
      {/* Emerald "lighting" glow on the highlighted card */}
      {tier.highlight && (
        <>
          <div className="pointer-events-none absolute -bottom-24 right-0 h-64 w-64 rounded-full bg-gradient-to-tr from-brand-500 via-brand-400 to-blue-300 opacity-50 blur-3xl" />
          <span className="absolute right-6 top-6 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> Most popular
          </span>
        </>
      )}

      <div className="relative">
        <h3 className="text-lg font-semibold text-gray-900">{tier.name}</h3>
        <div className="mt-3 flex items-baseline gap-1">
          <span className="text-5xl font-bold tracking-tight text-gray-900">{value}</span>
          {suffix && <span className="text-sm text-gray-400">{tier.unit ?? suffix}</span>}
        </div>
        <div className="mt-6 h-px w-full bg-gray-100" />

        <p className="mt-6 text-sm font-medium text-gray-400">{tier.blurb}</p>
        <ul className="mt-4 space-y-3">
          {tier.features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
              <Check />
              <span>{f}</span>
            </li>
          ))}
        </ul>

        <Link
          to={tier.to}
          className="mt-8 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-gray-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-black"
        >
          {tier.cta}
          <svg className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" viewBox="0 0 20 20" fill="none">
            <path d="M4 10h11M11 5l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>
    </div>
  );
}

export function Pricing() {
  const [billing, setBilling] = useState<Billing>("monthly");

  return (
    <section id="pricing" className="relative mx-auto max-w-7xl px-6 py-24">
      {/* Ambient lighting */}
      <div className="pointer-events-none absolute left-1/2 top-10 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-brand-200/40 blur-3xl" />

      <div className="relative">
        <h2 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">Pricing</h2>
        <p className="mt-3 text-lg text-gray-500">Choose the plan that works for you.</p>

        {/* Monthly / Yearly toggle */}
        <div className="mt-8 inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white p-1 text-xs font-semibold uppercase tracking-wide">
          <button
            onClick={() => setBilling("monthly")}
            className={clsx(
              "rounded-full px-4 py-2 transition",
              billing === "monthly" ? "bg-gray-900 text-white" : "text-gray-500 hover:text-gray-900"
            )}
          >
            Monthly
          </button>
          <button
            onClick={() => setBilling("yearly")}
            className={clsx(
              "rounded-full px-4 py-2 transition",
              billing === "yearly" ? "bg-gray-900 text-white" : "text-gray-500 hover:text-gray-900"
            )}
          >
            Yearly · save 20%
          </button>
        </div>
      </div>

      {/* Individual plans */}
      <div className="relative mt-12">
        <h3 className="text-lg font-semibold text-gray-900">Individual plans</h3>
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {individual.map((t) => (
            <PlanCard key={t.name} tier={t} billing={billing} />
          ))}
        </div>
      </div>

      {/* Team plans */}
      <div className="relative mt-14">
        <h3 className="text-lg font-semibold text-gray-900">Team plans</h3>
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {team.map((t) => (
            <PlanCard key={t.name} tier={t} billing={billing} wide />
          ))}
        </div>
      </div>
    </section>
  );
}

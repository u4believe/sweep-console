import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui/Logo";

/* ── small building blocks ─────────────────────────────────────────────── */

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[0.85em] text-gray-800">{children}</code>;
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl bg-gray-900 p-4 text-sm leading-relaxed text-gray-100">
      <code className="font-mono">{children}</code>
    </pre>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-gray-100 pt-10">
      <h2 className="text-2xl font-bold tracking-tight text-gray-900">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-gray-600">{children}</div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[260px_1fr] sm:gap-4">
      <div className="font-mono text-xs text-brand-700">{k}</div>
      <div className="text-sm text-gray-600">{v}</div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">{n}</span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

// Simple visual of the webhook lifecycle (no external image needed).
function WebhookFlow() {
  const box = "flex-1 rounded-xl border border-gray-200 bg-white p-4 text-center shadow-sm";
  const arrow = "shrink-0 self-center text-lg text-gray-300";
  return (
    <div className="my-6 rounded-2xl border border-gray-100 bg-gray-50 p-5">
      <div className="flex flex-col items-stretch gap-3 sm:flex-row">
        <div className={box}>
          <p className="text-sm font-semibold text-gray-900">1 · Event occurs</p>
          <p className="mt-1 text-xs text-gray-500">A payment succeeds, a renewal runs, a mandate is authorized…</p>
        </div>
        <span className={arrow}>→</span>
        <div className={box}>
          <p className="text-sm font-semibold text-gray-900">2 · Sweep POSTs to your URL</p>
          <p className="mt-1 text-xs text-gray-500">A JSON body plus an <Code>X-Sweep-Signature</Code> header (HMAC-SHA256)</p>
        </div>
        <span className={arrow}>→</span>
        <div className={box}>
          <p className="text-sm font-semibold text-gray-900">3 · You verify &amp; ack</p>
          <p className="mt-1 text-xs text-gray-500">Check the signature, do your work, return <Code>2xx</Code></p>
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-gray-400">
        No <Code>2xx</Code>? Sweep retries automatically — after 5 min, 30 min, 2 h, 5 h, then 10 h.
      </p>
    </div>
  );
}

/**
 * Hosted versus rail, side by side.
 *
 * This used to be a list of rows reading "Hosted: x · Rail: y", which asks the
 * reader to parse two answers out of one sentence on every line. The whole
 * point of the section is that these are two different products, so they get
 * two different columns and the comparison is done by the eye rather than by
 * the reader.
 *
 * Rendered twice: a real table where there is room for three columns, and a
 * stack of labelled pairs where there is not. A three-column table at phone
 * width is either a horizontal scroll or four words per line, and both are
 * worse than repeating the markup.
 */
function Compare({ rows }: { rows: { aspect: string; hosted: ReactNode; rail: ReactNode }[] }) {
  return (
    <div className="my-6">
      {/* sm and up */}
      <table className="hidden w-full border-collapse text-sm sm:table">
        <thead>
          <tr>
            <th className="w-[26%] border-b-2 border-gray-900 pb-2 pr-4 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400">
              &nbsp;
            </th>
            <th className="w-[37%] border-b-2 border-gray-900 px-4 pb-2 text-left font-bold text-gray-900">
              Hosted checkout
            </th>
            <th className="w-[37%] border-b-2 border-brand-600 px-4 pb-2 text-left font-bold text-brand-700">
              The rail
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.aspect} className="align-top">
              <td className="border-b border-gray-100 py-3 pr-4 font-medium text-gray-900">{r.aspect}</td>
              <td className="border-b border-gray-100 px-4 py-3 text-gray-600">{r.hosted}</td>
              <td className="border-b border-gray-100 bg-brand-50/40 px-4 py-3 text-gray-600">{r.rail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* below sm */}
      <div className="space-y-4 sm:hidden">
        {rows.map((r) => (
          <div key={r.aspect} className="border-t border-gray-200 pt-3">
            <p className="m-0 text-sm font-semibold text-gray-900">{r.aspect}</p>
            <p className="m-0 mt-1.5 text-sm text-gray-600">
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400">Hosted </span>
              {r.hosted}
            </p>
            <p className="m-0 mt-1 text-sm text-gray-600">
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand-700">Rail </span>
              {r.rail}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

const toc = [
  {
    group: "Using Sweep Console",
    items: [
      { id: "two-ways", label: "Which one do I want?" },
      { id: "creator-account", label: "Create a creator account" },
      { id: "subscribing", label: "Subscribe to a plan" },
      { id: "email-verification", label: "Email verification" },
      { id: "wallets", label: "Connecting & switching wallets" },
      { id: "upgrading", label: "Upgrading a plan" },
      { id: "pricing-changes", label: "Changing a price" },
      { id: "revenue-split", label: "Revenue & settlement" },
      { id: "challenges", label: "Common challenges" },
    ],
  },
  {
    group: "Payment rail (API)",
    items: [
      { id: "rail-quickstart", label: "Quickstart" },
      { id: "rail-overview", label: "What the rail is" },
      { id: "rail-getting-started", label: "Getting started" },
      { id: "rail-example", label: "A working integration" },
      { id: "rail-mandates", label: "Create a mandate" },
      { id: "rail-authorize", label: "The authorization page" },
      { id: "rail-charges", label: "Collect a charge" },
      { id: "rail-limits", label: "Limits & refusals" },
      { id: "rail-idempotency", label: "Idempotency" },
      { id: "rail-notifications", label: "What the payer is told" },
    ],
  },
  {
    group: "Webhooks",
    items: [
      { id: "webhooks", label: "Set up an endpoint" },
      { id: "webhooks-events", label: "Events" },
      { id: "webhooks-payload", label: "Payload & headers" },
      { id: "webhooks-verify", label: "Verify & respond" },
    ],
  },
];

const ALL_IDS = toc.flatMap((g) => g.items.map((i) => i.id));

/**
 * Which section the reader is currently in.
 *
 * Measured from scroll position rather than IntersectionObserver: the question
 * is "which heading did I last pass", and that has one answer at every scroll
 * offset. An observer instead reports a set of things that happen to be on
 * screen, which on a page with short sections is several at once and needs
 * tie-breaking anyway.
 *
 * The last section is special-cased. It is shorter than the viewport, so its
 * heading never reaches the line and it could otherwise never become active no
 * matter how far you scroll.
 */
function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const LINE = 140; // the sticky header, plus enough that a heading reads as "arrived"
        let current = ids[0] ?? "";
        for (const id of ids) {
          const el = document.getElementById(id);
          if (el && el.getBoundingClientRect().top <= LINE) current = id;
        }
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
        if (atBottom) current = ids[ids.length - 1] ?? current;
        setActive(current);
      });
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [ids]);

  return active;
}

/* ── page ──────────────────────────────────────────────────────────────── */

export function DocsPage() {
  const ids = useMemo(() => ALL_IDS, []);
  const active = useActiveSection(ids);
  const activeGroup = toc.find((g) => g.items.some((i) => i.id === active));
  const activeLabel = activeGroup?.items.find((i) => i.id === active)?.label;

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-gray-100 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2.5">
            <Logo height={28} />
            <span className="text-lg font-bold tracking-tight text-gray-900">Sweep Console</span>
            <span className="ml-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">Docs</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/" className="hidden text-sm font-medium text-gray-600 transition hover:text-gray-900 sm:block">Home</Link>
            <Link to="/login" className="text-sm font-medium text-gray-600 transition hover:text-gray-900">Login</Link>
            <Link to="/signup" className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-black">
              Get started
            </Link>
          </div>
        </div>
      </header>

      {/* The sidebar is desktop-only, so on a phone this is the only thing that
          answers "where am I". It sits under the header and says the same two
          things the sidebar shows: which group, and which section within it. */}
      <div className="sticky top-[57px] z-40 border-b border-gray-100 bg-white/90 px-6 py-2.5 backdrop-blur-md lg:hidden">
        <p className="m-0 truncate text-xs text-gray-400">
          {activeGroup ? (
            <>
              <span className="font-semibold uppercase tracking-[0.12em]">{activeGroup.group}</span>
              {activeLabel ? <span className="text-gray-600"> · {activeLabel}</span> : null}
            </>
          ) : (
            "Documentation"
          )}
        </p>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-6 py-12 lg:grid-cols-[230px_1fr]">
        {/* TOC. The rule runs the full height and each entry owns the slice of
            it beside them, so the marker reads as a position on the page rather
            than as a decoration next to a link. */}
        <aside className="hidden lg:block">
          <nav aria-label="On this page" className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto text-sm">
            {toc.map((grp) => {
              const isCurrentGroup = grp.group === activeGroup?.group;
              return (
                <div key={grp.group} className="mb-6 last:mb-0">
                  <p
                    className={`mb-2 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors ${
                      isCurrentGroup ? "text-gray-900" : "text-gray-400"
                    }`}
                  >
                    {grp.group}
                  </p>
                  {grp.items.map((t) => {
                    const isActive = t.id === active;
                    return (
                      <a
                        key={t.id}
                        href={`#${t.id}`}
                        aria-current={isActive ? "true" : undefined}
                        className={`-ml-px block border-l-2 py-1.5 pl-4 transition-colors ${
                          isActive
                            ? "border-brand-600 font-semibold text-brand-700"
                            : "border-gray-100 text-gray-500 hover:border-gray-300 hover:text-gray-900"
                        }`}
                      >
                        {t.label}
                      </a>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">Documentation</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-gray-900">How Sweep Console works</h1>
          <p className="mt-3 text-lg text-gray-500">
            A guide to creating an account, accepting and paying for subscriptions, how fees and settlement work,
            and how to charge a wallet from your own app.
          </p>

          {/* ── Using Sweep Console ─────────────────────────────────────── */}
          <div className="mt-12 space-y-10">
            <Section id="two-ways" title="Which one do I want?">
              <p>
                There are two ways to take money with Sweep, and the rest of these docs make more sense once you know
                which one you are reading about. The difference is <strong>who owns the billing clock</strong>.
              </p>
              <p>
                <strong>Hosted checkout.</strong> You create a plan, share a link, and Sweep runs everything after
                that — the checkout page, the schedule, renewals, trials, retries when a payment fails, and a portal
                where subscribers manage what they are paying for. You write no billing code. Start here unless you
                already have a billing system.
              </p>
              <p>
                <strong>The rail.</strong> Your app already knows what to charge and when — Sweep is only the thing
                that moves USDC out of a wallet. You create a mandate, the payer signs it once, and from then on your
                code calls <Code>POST /v1/charges</Code> whenever your own logic says it is time. No plans, no
                schedule, no renewal engine. Choose this when you have your own pricing, usage-based billing, or a
                billing system you are not replacing.
              </p>
              <Compare
                rows={[
                  {
                    aspect: "Who owns the billing clock",
                    hosted: "Sweep. It decides when a subscription is due and collects it.",
                    rail: "You. Nothing here has a schedule of its own.",
                  },
                  {
                    aspect: "Who sets the price",
                    hosted: <>A plan you create in the portal, with optional tiers.</>,
                    rail: <>Your app, on every call. Each <Code>POST /v1/charges</Code> names its own amount.</>,
                  },
                  {
                    aspect: "How a charge happens",
                    hosted: "Automatically, once per period, until cancelled.",
                    rail: <>You call <Code>POST /v1/charges</Code>. As often as you like, up to the ceiling.</>,
                  },
                  {
                    aspect: "Trials",
                    hosted: <><Code>trial_days</Code> on the plan. Sweep starts billing when it ends.</>,
                    rail: "Don't charge yet. A mandate costs the payer nothing until you do.",
                  },
                  {
                    aspect: "When a payment fails",
                    hosted: "Retried daily for ~7 attempts, then the subscription is cancelled.",
                    rail: <><Code>charge.failed</Code> with a reason. What happens next is your policy.</>,
                  },
                  {
                    aspect: "What the payer sees",
                    hosted: <>Sweep's checkout, then a portal at <Code>/manage</Code> to cancel or re-authorize.</>,
                    rail: "One authorization page, then your app. Sweep emails a receipt per charge.",
                  },
                  {
                    aspect: "Objects you work with",
                    hosted: <>Plan → Subscription → Payment</>,
                    rail: <>Mandate → Charge</>,
                  },
                  {
                    aspect: "Code you write",
                    hosted: "None for billing. Create a plan, share the link.",
                    rail: "Two server routes and a webhook handler.",
                  },
                  {
                    aspect: "Getting access",
                    hosted: "Sign up and go.",
                    rail: <>Request it in the portal; Sweep enables it per account. Until then, <Code>403 rail_not_enabled</Code>.</>,
                  },
                ]}
              />
              <p>
                Everything else is the same: the same payout wallet on Arc, the same <strong>3%</strong>, gasless for
                the payer, funded from Base / Arbitrum / Optimism, and an ERC-7715 wallet (MetaMask today) either way.
                One account can run both — mandates are invisible to the renewal engine, so the two never collide.
              </p>
              <p>
                Two things to know before you build on either: <strong>live API keys are not issued yet</strong>, so
                both are test-mode today, and <strong>neither has refunds</strong> — every charge settles straight to
                your payout wallet, so refunding is a transfer you make yourself.
              </p>
            </Section>

            <Section id="creator-account" title="Create a creator account">
              <ol className="space-y-3">
                <Step n={1}>
                  Go to <Link to="/signup" className="font-medium text-brand-700 hover:underline">Sign up</Link> and choose{" "}
                  <strong>Continue with Google</strong> or <strong>email</strong>.
                </Step>
                <Step n={2}>
                  <strong>Email:</strong> enter your email → we send a verification link → open it → set your name + a
                  password. <strong>Google:</strong> you're signed in straight away — no link to open.
                </Step>
                <Step n={3}>
                  In the dashboard, <strong>create your plan</strong>. Each creator has <strong>one plan</strong> with optional
                  tiers (name, price, interval, trial, features). You can add tiers later, and you can{" "}
                  <a href="#pricing-changes" className="font-medium text-brand-700 hover:underline">change a tier&apos;s price</a>.
                  The <strong>interval is fixed</strong> — a monthly tier cannot become yearly, because the billing period is
                  baked into every subscriber&apos;s signed permission. To change that, create a new tier.
                </Step>
                <Step n={4}>
                  <strong>Link a payout wallet</strong>: bring your own (an external Arc address, verified by signing a nonce)
                  or <strong>Create a wallet</strong> — a Circle user-controlled Programmable Wallet. USDC settles here.
                </Step>
                <Step n={5}>
                  Share your hosted <strong>payment link</strong> (<Code>/pay/&lt;id&gt;</Code>). Optionally generate API keys and
                  webhooks from the portal.
                </Step>
              </ol>
            </Section>

            <Section id="subscribing" title="Subscribe to a plan">
              <p>From a creator's payment link, a subscriber:</p>
              <ol className="space-y-3">
                <Step n={1}>Opens the link and lands on the checkout (picks a tier if the plan has more than one).</Step>
                <Step n={2}>
                  <strong>Verifies their email</strong> with a 6-digit code — this links them to that merchant.
                </Step>
                <Step n={3}>
                  <strong>Connects a wallet</strong> (intentional — wallets never auto-connect; returning customers see the wallet
                  they used before).
                </Step>
                <Step n={4}>
                  Pays with <strong>USDC on Base, Arbitrum or Optimism</strong> — gasless. One signature authorizes the
                  recurring charge; the platform submits the transaction, pays the gas and bridges to Arc via CCTP.
                </Step>
                <Step n={5}>
                  The first charge settles to the creator immediately (trials start free and take nothing). After that,
                  <strong>renewals are automatic and gasless</strong> — no further signatures.
                </Step>
              </ol>
            </Section>

            <Section id="email-verification" title="Email verification">
              <p>
                Email is the <strong>identity anchor</strong> for a subscriber on each merchant; the wallet is the payment method
                attached to it.
              </p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li><strong>Subscribers</strong> verify with a 6-digit one-time code before paying. Returning subscribers may not be asked to verify again.</li>
                <li><strong>Creators</strong> verify via a link emailed at sign-up, where they set their password. Signing up with Google skips that step.</li>
              </ul>
            </Section>

            <Section id="wallets" title="Connecting & switching wallets">
              <ul className="list-disc space-y-1.5 pl-5">
                <li><strong>No auto-connect.</strong> Connecting a wallet is always an explicit action.</li>
                <li><strong>New subscriber</strong> → a <strong>Connect Wallet</strong> button appears after email verification.</li>
                <li><strong>Returning subscriber</strong> → the wallet you used here before is recognized after you verify your email.</li>
                <li><strong>Use a different wallet</strong> → disconnect and pick another. Connecting a <em>new</em> wallet to a merchant you already subscribe to <strong>auto-revokes the old wallet's renewal delegation</strong>, so only one wallet ever bills you.</li>
                <li><strong>Recurring charges</strong> need an ERC-7715-capable wallet (e.g. MetaMask) — the grant is what authorizes every renewal after the first.</li>
              </ul>
            </Section>

            <Section id="upgrading" title="Upgrading a plan">
              <p>
                A creator has one plan with tiers, so an upgrade means <strong>moving to a higher tier</strong>. Mechanically that
                is a <strong>cancel + resubscribe</strong>: the chosen tier's amount and interval are snapshotted onto the new
                subscription, so it keeps billing those terms even if the tier is repriced later — unless the creator
                explicitly reprices existing subscribers.
              </p>
              <p>
                Completing the new subscription <strong>auto-replaces the old one</strong> (or you can revoke the old one first from
                the checkout). If you upgrade with the <strong>same wallet</strong> that already enabled cross-chain renewals, the
                grant carries over — no re-authorizing while that grant is still active.
              </p>
            </Section>

            <Section id="pricing-changes" title="Changing a price">
              <p>
                A tier&apos;s <strong>price is editable</strong>; its <strong>interval is not</strong>. The interval is
                part of what every subscriber&apos;s wallet signed, so changing it would mean re-collecting consent from
                all of them — a new tier is the honest way to do that. You will be asked to confirm it is you before a
                price change is saved.
              </p>
              <p>
                When you change one, you choose <strong>who it applies to</strong>:
              </p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="New subscribers only" v="The listed price changes. Everyone already subscribed keeps the price they signed up at." />
                <Row k="Existing subscribers only" v="People already paying move to the new price; the listing is unchanged." />
                <Row k="Everyone" v="Both — the listing and every live subscription on that tier." />
              </div>
              <p>
                <strong>Every active subscriber on that tier is emailed</strong> whenever the price they pay changes,
                whichever scope you pick. That is not optional: a recurring charge that quietly changes size is the
                thing a standing payment authorization is most often abused for.
              </p>
              <p>
                <strong>Raising a price is allowed</strong>, with one consequence worth understanding. A subscriber&apos;s
                renewal permission has a signed ceiling. If the new price is above it, Sweep does <em>not</em> charge them
                and does <em>not</em> count it as a failed payment — they are asked to re-authorize at the new amount
                instead, and keep their subscription in the meantime. Lowering a price needs nothing from anyone.
              </p>
            </Section>

            <Section id="revenue-split" title="Creator revenue & settlement">
              <p>
                <strong>Revenue allocation.</strong> The platform fee is <strong>3%</strong> — so{" "}
                <strong>creators keep 97%</strong> of every charge. The split
                is <Code>fee = amount × platformFeeBps / 10000</Code>: the creator receives <Code>amount − fee</Code> to their payout
                wallet on Arc, and the fee goes to the platform treasury. The split is computed off-chain when the charge settles
                and paid out in the same bridge, so the creator's share never sits in a contract. The platform absorbs gas and
                bridge costs out of its share, which is why a cross-chain charge nets the creator the <em>same</em> amount.
              </p>
              <p>
                <strong>No escrow, no refund window.</strong> Every charge — the first one included — is pushed to the creator's
                payout wallet as it settles. Nothing is held back, so there is <strong>no automatic refund path</strong>: once a
                charge has settled, refunding it is a transfer the creator makes from their own wallet. Cancelling stops future
                charges; it does not reverse past ones.
              </p>
              <p>
                <strong>Renewals.</strong> Each cycle the relayer redeems one period of the subscriber's grant on the source
                chain, splits it and bridges the creator's share to Arc. A failed renewal is retried daily for ~7 days before the
                subscription is cancelled.
              </p>
            </Section>

            <Section id="challenges" title="Common challenges (and fixes)">
              <ul className="list-disc space-y-2 pl-5">
                <li><strong>Not enough USDC.</strong> Checkout checks the balance on the chain you picked before asking for a signature — top up, or switch to another of Base / Arbitrum / Optimism.</li>
                <li><strong>Wallet can't authorize renewals.</strong> Recurring charges need an ERC-7715-capable wallet (MetaMask). Wallets without it cannot subscribe yet.</li>
                <li><strong>MetaMask "couldn't reach permission storage".</strong> Turn on MetaMask → Settings → <strong>Backup and sync</strong>, make sure you're signed in and online, then retry.</li>
                <li><strong>Email not verified.</strong> Payment is blocked until you enter the 6-digit code sent to your email.</li>
                <li><strong>Chain switching.</strong> To sign, your wallet must be on the chain you are paying from — the app switches it for you; just approve the prompt.</li>
                <li><strong>Cross-chain takes a moment.</strong> CCTP Fast usually settles in under a minute — keep the page open.</li>
                <li><strong>Gas.</strong> Paying is gasless on every chain — the platform submits each transaction and covers gas and the bridge fee. The one exception is a wallet&apos;s <strong>one-time smart-account setup</strong> on each chain you pay from, which the wallet submits itself and costs the subscriber a few cents. It is never charged again for that chain.</li>
              </ul>
            </Section>
          </div>

          {/* ── Payment rail ───────────────────────────────────────────── */}
          <div className="mt-16">
            <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">Payment rail (API)</p>
            <h2 className="mt-1 text-3xl font-bold tracking-tight text-gray-900">Charge a wallet from your own app</h2>
          </div>

          <div className="mt-8 space-y-10">
            <Section id="rail-quickstart" title="Quickstart">
              <p>
                The whole integration, in the order you write it. Four calls: create a mandate, send the payer to sign
                it, listen for what happens, charge when your billing says so. Everything after this section explains
                the pieces — you do not need it to get a first charge working.
              </p>
              <Pre>{`npm install @sweepconsole/node`}</Pre>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row
                  k="Base URL"
                  v={
                    <>
                      <Code>https://api.sweepconsole.xyz</Code> — the API is its own origin.{" "}
                      <Code>www.sweepconsole.xyz</Code> is this website, and it answers every path with the page you
                      are reading, so a client pointed there gets a <Code>200</Code> full of HTML rather than JSON.
                      The Node client already knows the right one.
                    </>
                  }
                />
              </div>
              <Pre>{`import { Sweep, usdc } from "@sweepconsole/node";
import express from "express";

const sweep = new Sweep(process.env.SWEEP_API_KEY!);
const app = express();

// 1 ─ a user subscribes: create the mandate, send them to sign it
app.post("/subscribe/usdc", async (req, res) => {
  const mandate = await sweep.mandates.create({
    externalRef: req.user.id,               // YOUR id — echoed on every event
    email: req.user.email,
    maxAmount: usdc("15.00"),               // the CEILING, not the price
    interval: "monthly",
    chains: ["base", "arbitrum", "optimism"],
    expiresAt: new Date("2027-01-01"),
  });

  await db.users.update(req.user.id, { sweepMandate: mandate.id });
  res.redirect(mandate.authorizationUrl!);  // they sign in their wallet
});

// 2 ─ react to what happens. express.raw, not express.json — the signature is
//     over the raw bytes, and parsing first destroys them.
app.post("/webhooks/sweep",
  express.raw({ type: "application/json" }),
  sweep.webhooks.express(process.env.SWEEP_WEBHOOK_SECRET!, {
    "mandate.authorized": (e) => db.users.activate(e.externalRef),
    "charge.succeeded":   (e) => db.users.extend(e.externalRef),
    "charge.failed":      (e) => db.users.dun(e.externalRef, e.data.failure_code),
    "mandate.revoked":    (e) => db.users.deactivate(e.externalRef),
  }));

// 3 ─ charge on YOUR schedule. Sweep has none of its own.
for (const user of await db.users.dueForCharge()) {
  try {
    await sweep.charges.create(
      { mandate: user.sweepMandate, amount: usdc("9.00"), description: "Pro plan — September" },
      { idempotencyKey: \`\${user.id}:\${thisPeriod}\` },
    );
  } catch (e) {
    if (e instanceof Sweep.PeriodCapExceeded) continue;          // already collected
    if (e instanceof Sweep.MandateRevoked) await db.users.deactivate(user.id);
    else throw e;
  }
}`}</Pre>
              <p>
                Before any of it runs you need three things from the portal, once:{" "}
                <strong>a payout wallet</strong> (Settings), <strong>the rail enabled</strong> on your account
                (Payment rail → Request access), and <strong>an API key</strong> plus a{" "}
                <strong>webhook endpoint</strong>. <a href="#rail-getting-started" className="text-brand-700 underline">Getting started</a>{" "}
                walks through those five steps.
              </p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="Why usdc(&quot;9.00&quot;)" v="Amounts are micro-units — 9000000. The helper returns a branded type, so a bare number will not compile where an amount belongs, and the factor of a million cannot reach production." />
                <Row k="Why express.raw" v={<>The signature covers the exact bytes we sent. <Code>express.json()</Code> parses them first, so what you would hash is no longer what was signed.</>} />
                <Row k="Why an idempotency key" v={<>Required, not advisory. A natural key — an invoice id, or <Code>{"`${userId}:${period}`"}</Code> — means a retry after a timeout collects once rather than twice.</>} />
                <Row k="Why nothing returns a result" v={<><Code>charges.create</Code> resolves when the charge is accepted, not when it settles. Money moves cross-chain; the outcome arrives on <Code>charge.succeeded</Code> or <Code>charge.failed</Code>.</>} />
              </div>
              <p>
                <strong>Not using Node?</strong> Everything above is four HTTP calls, and the sections below give each
                one as <Code>curl</Code> with the same fields. The client is a convenience, not a requirement.
              </p>
            </Section>

            <Section id="rail-overview" title="What the rail is">
              <p>
                Everything above describes Sweep&apos;s <strong>hosted</strong> product: you create a plan, we run the
                checkout, and we own the billing clock. The <strong>rail</strong> is the other half — your app keeps its
                own plans, prices and schedule, and uses Sweep only to move USDC out of a subscriber&apos;s wallet on a
                standing authorization.
              </p>
              <p>
                Two objects. A <strong>mandate</strong> is one payer&apos;s signed, capped permission for one merchant.
                A <strong>charge</strong> is one pull against it. You decide when to charge; nothing here has a
                schedule of its own, and the renewal cron never touches a mandate.
              </p>
              <p>
                The rail is an entitlement rather than a setting: <Code>/v1/mandates</Code> and <Code>/v1/charges</Code>{" "}
                answer <Code>403 rail_not_enabled</Code> until your account is granted access. It is also the first
                place where a leaked API key can move your customers&apos; money — not to the thief, since a charge
                always settles to your payout wallet and changing that wallet needs your authenticator, but anyone
                holding it can charge every mandate you have up to its cap. Treat the key accordingly.
              </p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="1 · POST /v1/mandates" v="You create a pending mandate and get back an authorization URL." />
                <Row k="2 · you send the payer there" v="They connect a wallet and sign one permission per chain." />
                <Row k="3 · mandate.authorized" v="The mandate flips to active. Now it can be charged." />
                <Row k="4 · POST /v1/charges" v={<>One pull, whenever your billing logic says so. Answers <Code>202</Code>.</>} />
                <Row k="5 · charge.succeeded" v="Settled on Arc, in the merchant's payout wallet." />
              </div>
            </Section>

            <Section id="rail-getting-started" title="Getting started">
              <p>
                Five steps before you write any code, then four things to wire into your app. Everything below is
                test mode — live keys are not issued yet.
              </p>
              <ol className="space-y-3">
                <Step n={1}>
                  <strong>Create an account</strong> and verify your email — the same signup as any creator.
                </Step>
                <Step n={2}>
                  <strong>Link a payout wallet</strong> — portal → <strong>Settings</strong> → <strong>Payout
                  wallet</strong>. An Arc address, verified by signing a nonce. Do this before anything else: a
                  mandate will be created and authorized perfectly happily without one, and then the first charge
                  fails with <Code>no_payout_wallet</Code>. It fails late, after the payer has already signed.
                </Step>
                <Step n={3}>
                  <strong>Ask us to enable the rail</strong> — portal → <strong>Payment rail</strong> →{" "}
                  <strong>Request access</strong>. This is the one step that is not self-serve: until your account is
                  granted it, <Code>/v1/mandates</Code> and <Code>/v1/charges</Code> answer{" "}
                  <Code>403 rail_not_enabled</Code>. Access is granted rather than switched on because the rail
                  decides whether an account may solicit recurring wallet authorizations at all — and unlike a card
                  network there is no chargeback to unwind one. Once it is granted that screen
                  becomes your mandates and charges instead, which is how you know it worked.
                </Step>
                <Step n={4}>
                  <strong>Create a test API key</strong> — portal → <strong>API Keys</strong> → <strong>Regenerate</strong>.
                  You will be asked to confirm it is you. The key is shown <em>once</em>; copy it then. Treat it like a
                  payment credential, because on this rail that is exactly what it is.
                </Step>
                <Step n={5}>
                  <strong>Register a webhook endpoint</strong> — portal → <strong>Webhooks</strong> →{" "}
                  <strong>Add endpoint</strong> — subscribed to <Code>mandate.authorized</Code>,{" "}
                  <Code>mandate.revoked</Code>, <Code>charge.succeeded</Code> and <Code>charge.failed</Code>. It must
                  be a public <Code>https://</Code> URL — localhost is refused, and the address is re-checked before
                  every delivery. Use a tunnel while developing.
                </Step>
              </ol>
              <p className="font-semibold text-gray-800">Then, in your own app</p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="when a user subscribes" v={<>Call <Code>POST /v1/mandates</Code> and store the returned <Code>mdt_…</Code> against that user.</>} />
                <Row k="send them to sign" v={<>Redirect to the <Code>authorization_url</Code> from that response.</>} />
                <Row k="on mandate.authorized" v={<>Mark them active and start your own billing clock. Do this on the <strong>webhook</strong>, not on the redirect — a payer can close the tab before it returns.</>} />
                <Row k="when your billing says so" v={<>Call <Code>POST /v1/charges</Code> with an <Code>Idempotency-Key</Code>, then act on <Code>charge.succeeded</Code> / <Code>charge.failed</Code>.</>} />
              </div>
              <p>
                That is the whole integration. You keep your plans, prices, schedule, trials, dunning policy and
                product emails. Sweep moves the money, enforces the ceiling the payer signed, and sends them a receipt
                for each charge.
              </p>
              <p>
                <strong>Where to watch it.</strong> The portal has a <strong>Payment rail</strong> screen listing your
                mandates and charges, and the dashboard reports rail figures in a band of their own. Rail money is
                counted <em>separately</em> from subscriptions everywhere — the subscription payments ledger does not
                include charges, and no screen sums the two. They are different products with different clocks, and one
                combined number would answer neither question. For programmatic access,{" "}
                <Code>GET /v1/mandates</Code> and <Code>GET /v1/charges</Code> both list and filter.
              </p>
            </Section>

            <Section id="rail-example" title="A working integration">
              <p>
                The whole thing is two server routes and a webhook handler. This is Express; the shape is the same
                anywhere. Nothing here is pseudo-code — it is what the four steps above look like written out.
              </p>
              <p className="font-semibold text-gray-800">1 · The &ldquo;Pay with USDC&rdquo; button</p>
              <p>
                A form that posts to your own server, exactly like a Stripe Checkout session. The secret key never
                reaches the browser.
              </p>
              <Pre>{`<form method="POST" action="/subscribe/usdc">
  <button type="submit">Pay with USDC</button>
</form>`}</Pre>

              <p className="font-semibold text-gray-800">2 · Create the mandate and redirect</p>
              <Pre>{`const SWEEP = "https://api.sweepconsole.xyz";

app.post("/subscribe/usdc", async (req, res) => {
  const user = req.user;                       // however you authenticate

  const r = await fetch(\`\${SWEEP}/v1/mandates\`, {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${process.env.SWEEP_API_KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      external_ref: user.id,                   // YOUR id — echoed on every event
      email: user.email,
      max_amount: 15_000_000,                  // 15.00 USDC ceiling, NOT the price
      interval: "monthly",
      chains: ["base", "arbitrum", "optimism"],
      expires_at: "2027-09-20T00:00:00.000Z",
      return_url: "https://shop.example.com/thanks",
    }),
  });
  const mandate = await r.json();

  await db.users.update(user.id, { sweepMandate: mandate.id });
  res.redirect(mandate.authorization_url);     // they sign in their wallet
});`}</Pre>
              <p>
                Give <Code>max_amount</Code> headroom over your price. It is a ceiling, it is fixed for the life of
                the mandate, and charging above it later means asking the payer to sign a new one.
              </p>

              <p className="font-semibold text-gray-800">3 · The webhook handler</p>
              <Pre>{`app.post("/webhooks/sweep", express.raw({ type: "application/json" }), (req, res) => {
  const signature = String(req.headers["x-sweep-signature"] ?? "");
  const expected =
    "sha256=" + crypto.createHmac("sha256", process.env.SWEEP_WEBHOOK_SECRET).update(req.body).digest("hex");
  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.status(400).send("bad signature");

  const event = JSON.parse(req.body.toString("utf8"));
  const userId = event.external_ref;           // the id you sent at step 2

  switch (event.event_type) {
    case "mandate.authorized":
      // Start YOUR clock here, not on the return_url — they can close the tab.
      db.users.update(userId, { usdcActive: true, nextChargeOn: addMonths(new Date(), 1) });
      break;

    case "charge.succeeded":
      db.users.update(userId, { paidUntil: addMonths(new Date(), 1) });
      break;

    case "charge.failed":
      // Your policy, not ours. insufficient_funds is usually an empty wallet.
      db.users.update(userId, { dunning: event.data.failure_code });
      break;

    case "mandate.revoked":
    case "mandate.expired":
      db.users.update(userId, { usdcActive: false });
      break;
  }

  res.status(200).send("ok");                  // acknowledge fast, work after
});`}</Pre>

              <p className="font-semibold text-gray-800">4 · Charge on your own schedule</p>
              <Pre>{`// Your cron, your billing day — Sweep has no schedule of its own.
for (const user of await db.users.dueForCharge()) {
  const r = await fetch(\`\${SWEEP}/v1/charges\`, {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${process.env.SWEEP_API_KEY}\`,
      "Idempotency-Key": \`\${user.id}:\${thisPeriod}\`,   // natural key beats a random one
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mandate: user.sweepMandate,
      amount: 9_000_000,                       // 9.00 USDC — anything up to the ceiling
      description: "Pro plan — September",     // the ONLY thing the payer sees
    }),
  });

  if (r.status === 202) continue;              // accepted; the outcome arrives by webhook
  const { error } = await r.json();
  if (error.code === "period_cap_exceeded") { /* already collected this period */ }
  if (error.code === "mandate_revoked") { /* they withdrew consent — stop charging */ }
}`}</Pre>
              <p>
                That is the integration. The one thing worth repeating: <Code>description</Code> is the only text the
                payer sees on their receipt, so write it for them rather than for your logs.
              </p>
            </Section>

            <Section id="rail-mandates" title="Create a mandate">
              <p>
                A mandate cannot be created server-to-server, because the permission is a wallet signature. Creating one
                mints a <Code>pending</Code> row and returns a hosted URL for the payer to open — the same redirect
                shape as a hosted checkout.
              </p>
              <Pre>{`curl -X POST https://api.sweepconsole.xyz/v1/mandates \
  -H "Authorization: Bearer $SWEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_ref": "user_8412",
    "email": "ada@example.com",
    "max_amount": 5000000,
    "interval": "daily",
    "chains": ["base", "arbitrum", "optimism"],
    "expires_at": "2027-09-12T00:00:00.000Z",
    "metadata": { "plan": "pro" }
  }'`}</Pre>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="external_ref" v="Your own id for the payer. Echoed on every event, so you never have to store ours." />
                <Row k="max_amount" v={<>USDC in micro-units — <Code>5000000</Code> is 5 USDC. An integer, because a float here is a rounding bug that ends in someone being charged the wrong amount.</>} />
                <Row k="interval" v={<><Code>daily</Code>, <Code>weekly</Code>, <Code>monthly</Code> or <Code>yearly</Code> — the period the ceiling applies to.</>} />
                <Row k="chains" v={<>Where the payer may authorize. <Code>arc</Code> is rejected: recurring authority there is a permit to a contract, not the wallet permission this rail redeems.</>} />
                <Row k="expires_at" v="When the authorization stops being redeemable. Distinct from the link's own lifetime." />
              </div>
              <p>
                The response carries <Code>authorization_url</Code> and, separately,{" "}
                <Code>authorization_url_expires_at</Code> — the <em>link</em> lasts 24 hours, the <em>mandate</em> lasts
                until <Code>expires_at</Code>. Conflating them ships a broken email. Once the mandate is authorized,{" "}
                <Code>authorization_url</Code> comes back <Code>null</Code>.
              </p>
            </Section>

            <Section id="rail-authorize" title="The authorization page">
              <p>
                Send the payer to <Code>authorization_url</Code>. They connect a wallet and sign one{" "}
                <strong>ERC-7715 permission per chain</strong>. They may sign fewer chains than you asked for — the
                grants are the truth about what is redeemable, and a skipped chain can be added later by reopening the
                link while it is valid.
              </p>
              <p>
                Signing needs an ERC-7715-capable wallet (MetaMask today). The first grant on a chain also performs that
                wallet&apos;s one-time smart-account setup, which the wallet submits itself and costs the payer a few
                cents of gas on that chain. Every charge after that is gasless for them.
              </p>
              <p>
                When at least one chain is signed the mandate becomes <Code>active</Code> and{" "}
                <Code>mandate.authorized</Code> fires with the <Code>chain_ids</Code> that were actually granted. That
                event is your signal to start charging — not the redirect, which the payer can close.
              </p>
            </Section>

            <Section id="rail-charges" title="Collect a charge">
              <p>
                One pull, when your billing logic says it is time. An <Code>Idempotency-Key</Code> header is{" "}
                <strong>required</strong>, not advisory.
              </p>
              <Pre>{`curl -X POST https://api.sweepconsole.xyz/v1/charges \
  -H "Authorization: Bearer $SWEEP_API_KEY" \
  -H "Idempotency-Key: invoice_2026_09_user_8412" \
  -H "Content-Type: application/json" \
  -d '{
    "mandate": "mdt_44d0a31d527ab8cda253",
    "amount": 2000000,
    "description": "Pro plan — September"
  }'

# 202 Accepted
{ "id": "chg_7ed2374c97ea164c4e27", "status": "pending", "amount": 2000000, ... }`}</Pre>
              <p>
                It answers <Code>202</Code>, never <Code>200</Code>. Every charge is cross-chain — Arc cannot back a
                mandate — so collecting is a pull, a burn, an attestation and a mint: <strong>seconds to minutes</strong>.
                The charge row exists the moment we answer; the money arrives later. Learn the outcome from{" "}
                <Code>charge.succeeded</Code> / <Code>charge.failed</Code>, or by polling{" "}
                <Code>GET /v1/charges/:id</Code>.
              </p>
              <p>
                <strong>Which chain pays.</strong> You do not choose. Sweep takes the mandate&apos;s active grants, drops
                any whose signed cap cannot cover the amount, drops any already redeemed this period, scans live
                balances, and takes the <strong>first chain that covers the amount on its own</strong>. There is no
                aggregation: 3 USDC on Base and 3 on Optimism will not fund a 5 USDC charge. The chain that paid comes
                back as <Code>source_chain</Code>; <Code>tx_hash</Code> is always the <strong>Arc</strong> settlement, so
                do not go looking for it on Base.
              </p>
            </Section>

            <Section id="rail-limits" title="Limits & refusals">
              <p>
                The ceiling belongs to the <strong>mandate</strong>, not to a chain. A payer who signs on two chains has
                two independent on-chain caps; Sweep sums charges across them so <Code>max_amount</Code> per{" "}
                <Code>interval</Code> means what it says. The period is a fixed window anchored at the moment the payer
                authorized — not a rolling one.
              </p>
              <p>
                A <Code>pending</Code> charge holds its share of the ceiling while it settles. A charge that fails
                releases it.
              </p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="403 rail_not_enabled" v="Your account has not been granted the rail." />
                <Row k="409 mandate_revoked / mandate_not_active" v="The payer withdrew it, or it was never authorized." />
                <Row k="422 amount_over_cap" v="This single charge is larger than max_amount." />
                <Row k="422 period_cap_exceeded" v={<>It fits under <Code>max_amount</Code> but not under what is left this period. The message names what is committed, what remains, and when the period resets.</>} />
                <Row k="409 charge_conflict" v="Two charges against one mandate committed at the same instant. Retry with the same Idempotency-Key." />
                <Row k="charge.failed · insufficient_funds" v="No granted chain holds the full amount on its own. Asynchronous — the charge was accepted, then could not be collected." />
                <Row k="charge.failed · mandate_period_consumed" v="Every granted chain has already been redeemed this period, even if the mandate's own ceiling has room." />
              </div>
              <p>
                <strong>Charging more than the cap means a new mandate.</strong> <Code>max_amount</Code> is fixed for
                the life of a mandate — it is the number the payer&apos;s wallet enforces, and nothing on your side or
                ours can raise it. So a price increase past that ceiling is not an edit, it is a fresh authorization:
                create a second mandate at the new amount, send the payer its <Code>authorization_url</Code>, and
                charge the new one once <Code>mandate.authorized</Code> arrives. Revoke the old mandate then — not
                before, or you have cancelled a working authorization while waiting on a signature that may never come.
              </p>
              <p>
                Until they sign, keep collecting on the old mandate at the old amount. It is still valid, and a payer
                who ignores the email keeps their subscription working rather than silently lapsing. Charging
                <em>below</em> the cap needs none of this: every <Code>POST /v1/charges</Code> names its own amount, so
                lowering a price is simply charging less, with no authorization change and nothing for the payer to do.
              </p>
              <p>
                A failed charge leaves the mandate <Code>active</Code>. Nothing about the rail cancels an authorization
                on your behalf — only the payer, from their wallet, or you, via{" "}
                <Code>DELETE /v1/mandates/:id</Code>, which is idempotent and fires <Code>mandate.revoked</Code>. That
                revoke is a decision Sweep records and honours, not a cryptographic one: the grants stay signed on
                chain, because only the payer&apos;s own wallet can disable them. We stop redeeming them.
              </p>
            </Section>

            <Section id="rail-idempotency" title="Idempotency">
              <p>
                Send a unique <Code>Idempotency-Key</Code> per charge — a natural one, like your invoice id, beats a
                random one. The key is claimed <em>before</em> the mandate is read, so two identical requests racing
                each other cannot both reach it.
              </p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="same key, same body" v={<>Replays the original response. <Code>202</Code>, same charge id, no second pull.</>} />
                <Row k="same key, different body" v={<><Code>422 idempotency_key_reused</Code>. A new charge needs a new key.</>} />
                <Row k="key still in flight" v={<><Code>409 idempotency_key_in_flight</Code>. Retry shortly.</>} />
                <Row k="no key" v={<><Code>400 idempotency_key_required</Code>.</>} />
              </div>
              <p>
                <strong>A replay returns the response as it was when the charge was created</strong> — typically{" "}
                <Code>status: &quot;pending&quot;</Code> with a null <Code>tx_hash</Code>, even if the charge has since
                settled. That is deliberate: a replay is a copy of the original answer, not a status check. For current
                state use <Code>GET /v1/charges/:id</Code>.
              </p>
            </Section>

            <Section id="rail-notifications" title="What the payer is told">
              <p>
                <strong>Sweep emails them a receipt</strong> whenever a charge settles, to the <Code>email</Code> you
                set on the mandate. It states what was taken, by whom, which chain it came from, the Arc transaction,
                and the ceiling it was collected under — a standing debit the payer never sees coming reads as an
                unexplained withdrawal otherwise.
              </p>
              <p>
                Two things it deliberately does <em>not</em> say, because Sweep cannot know them: a next-charge date
                (your app owns the schedule) and a plan name. The only description the payer sees is the{" "}
                <Code>description</Code> you send with the charge — so write it for them, not for your logs. And{" "}
                <Code>email</Code> is optional on a mandate: omit it and no receipt can be sent.
              </p>
              <p>
                The receipt tells them their one real control is revoking the permission in their own wallet, and that
                a settled charge is not reversible by Sweep — refunds come from you. Product mail beyond the receipt
                (dunning, renewal reminders, anything tied to your plans) is still yours to send;{" "}
                <Code>charge.succeeded</Code> carries <Code>amount</Code>, <Code>source_chain</Code>, the Arc{" "}
                <Code>tx_hash</Code> and your <Code>external_ref</Code>.
              </p>
              <p>
                <strong>Trials are yours too.</strong> A mandate has no trial: it is an authorization, not a plan. A free
                period on the rail is simply you not calling <Code>POST /v1/charges</Code> until it ends. Authorize on
                day one, charge on day fifteen — the mandate sits active and costs the payer nothing in between.
              </p>
              <p>
                <strong>And so are renewals.</strong> There is no renewal endpoint and no{" "}
                <Code>charge.renewed</Code>, because the rail has no concept of a first charge versus a later one —
                every collection is a charge, and your app already knows which is which. Charging monthly means
                calling <Code>POST /v1/charges</Code> once a month. Nothing here has a schedule, so nothing here can
                renew on your behalf.
              </p>
              <p>
                Two things can end a mandate without you doing anything. The payer disabling the grant in their wallet
                reaches you as <Code>mandate.revoked</Code> with <Code>reason: disabled_on_chain</Code>, found by a
                daily reconciliation rather than at the moment it happens. The other is the mandate reaching its{" "}
                <Code>expires_at</Code>, which announces itself twice: <Code>mandate.expiring</Code> a week ahead
                (with <Code>days_remaining</Code>), then <Code>mandate.expired</Code> when it lapses. Both are sent
                once rather than daily.
              </p>
              <p>
                Act on the warning, not the lapse. An expired mandate refuses charges with{" "}
                <Code>mandate_expired</Code>, and you cannot extend one — recovery is a <em>new</em> mandate and
                another wallet signature from the payer. The week exists so you can ask them before a payment is
                missed rather than after.
              </p>
            </Section>
          </div>

          {/* ── Webhooks ────────────────────────────────────────────────── */}
          <div className="mt-16">
            <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">Webhooks</p>
            <h2 className="mt-1 text-3xl font-bold tracking-tight text-gray-900">Get notified of events</h2>
          </div>

          <div className="mt-8 space-y-10">
            <Section id="webhooks" title="Set up an endpoint">
              <p>
                Rather than polling our API, let Sweep <strong>push events to your server</strong> the moment they
                happen — a subscription is created, a payment succeeds, a renewal fails. Your app reacts in real
                time: grant access, update your database, send a receipt.
              </p>
              <WebhookFlow />
              <p className="font-semibold text-gray-800">Create an endpoint — two ways</p>
              <p>
                <strong>1. From the dashboard (easiest).</strong> Go to <Code>Portal → Webhooks → Add endpoint</Code>,
                paste your HTTPS URL, tick the events you care about, and save. You'll be shown a{" "}
                <strong>signing secret</strong> — copy it now; you'll need it to verify events.
              </p>
              <p>
                <strong>2. From the API.</strong> POST to <Code>/v1/webhooks</Code> with your API key:
              </p>
              <Pre>{`curl -X POST https://api.sweepconsole.xyz/v1/webhooks \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://yourapp.com/webhooks/sweep",
    "events": ["subscription.created", "payment.succeeded", "subscription.cancelled"]
  }'`}</Pre>
              <p>
                The response includes a <Code>secret</Code> — store it securely; it's how you confirm an incoming
                event really came from Sweep.
              </p>
              <p className="text-sm text-gray-500">
                Your URL must be <strong>HTTPS</strong> and publicly reachable. For local testing, expose your dev
                server with a tunnel (e.g. <Code>ngrok</Code>) and register that URL.
              </p>
            </Section>

            <Section id="webhooks-events" title="Events you can subscribe to">
              <p>Pick only what you need — you'll receive just those event types.</p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="checkout.session.completed" v="A checkout finished successfully." />
                <Row k="subscription.created" v="A new subscription was activated (first charge taken, or trial started)." />
                <Row k="subscription.renewed" v="A recurring cycle was charged successfully." />
                <Row k="subscription.past_due" v="A renewal failed; the subscription entered the retry window." />
                <Row k="subscription.cancelled" v="The subscription ended; no further charges will be attempted." />
                <Row k="payment.succeeded" v="A charge settled (first payment or a renewal)." />
                <Row k="payment.failed" v="A charge attempt failed." />
              </div>
              <p className="mt-6">
                These four belong to the <a href="#rail-overview" className="text-brand-700 underline">payment rail</a>{" "}
                and only fire for accounts it is enabled on.
              </p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="mandate.authorized" v={<>A payer signed. Carries the <Code>chain_ids</Code> actually granted — start charging on this, not on the redirect.</>} />
                <Row k="mandate.revoked" v={<>An authorization stopped being redeemable. <Code>reason</Code> says which: you called <Code>DELETE /v1/mandates/:id</Code>, or the payer disabled the grant in their own wallet (<Code>disabled_on_chain</Code>, found by a daily reconciliation — we cannot be told at the time). The latter names a <Code>chain_id</Code>: a mandate signed on several chains stays chargeable on the others.</>} />
                <Row k="mandate.expiring" v={<>A mandate reaches its <Code>expires_at</Code> within the warning window (7 days by default). Carries <Code>days_remaining</Code>. Sent once, not daily.</>} />
                <Row k="mandate.expired" v="A mandate passed its expiry and can no longer be charged. Sent once, when it lapses." />
                <Row k="charge.succeeded" v={<>A pull settled on Arc. Carries <Code>source_chain</Code> and the Arc <Code>tx_hash</Code>.</>} />
                <Row k="charge.failed" v={<>A pull could not be collected. Carries <Code>failure_code</Code> — <Code>insufficient_funds</Code>, <Code>mandate_period_consumed</Code> and so on.</>} />
              </div>
            </Section>

            <Section id="webhooks-payload" title="The event payload & headers">
              <p>
                Every event is a JSON <Code>POST</Code> with the same envelope; the <Code>data</Code> object varies by
                event type.
              </p>
              <Pre>{`POST /webhooks/sweep
Content-Type: application/json
X-Sweep-Event: payment.succeeded
X-Sweep-Event-Id: evt_8f3a2c...
X-Sweep-Signature: sha256=2b9c4e7a...

{
  "event_id": "evt_8f3a2c...",
  "event_type": "payment.succeeded",
  "created_at": "2026-06-27T10:15:00.000Z",
  "merchant_id": "XXXX-XXXX-XXXX",
  "external_ref": "your-user-id-123",
  "data": {
    "subscription_id": "sub_abc123",
    "plan_id": "plan_pro",
    "amount": 5000000,
    "currency": "USDC"
  }
}`}</Pre>
              <p>
                <Code>external_ref</Code> is the user ID you supplied at checkout — use it to map the event back to
                your own user. Amounts are in USDC <strong>micro-units</strong> (6 decimals): <Code>5000000</Code> ={" "}
                <Code>5.00 USDC</Code>.
              </p>
              <p className="font-semibold text-gray-800">Headers on every delivery</p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="X-Sweep-Event" v="The event type (also in the body)." />
                <Row k="X-Sweep-Event-Id" v="Unique event ID — retries reuse it, so use it to de-duplicate." />
                <Row k="X-Sweep-Signature" v={<>HMAC-SHA256 of the raw body, formatted <Code>sha256=&lt;hex&gt;</Code>. Verify this.</>} />
              </div>
            </Section>

            <Section id="webhooks-verify" title="Verify signatures & respond">
              <p>
                <strong>Always verify the signature</strong> before trusting an event — it proves the request came
                from Sweep and wasn't tampered with. Compute an HMAC-SHA256 over the <strong>raw request body</strong>{" "}
                using your endpoint's signing secret, and compare it to the <Code>X-Sweep-Signature</Code> header.
              </p>
              <Pre>{`import crypto from "crypto";
import express from "express";

const app = express();
const SECRET = process.env.SWEEP_WEBHOOK_SECRET; // the signing secret from setup

// Verify against the RAW body, so capture it as a Buffer (express.raw).
app.post("/webhooks/sweep", express.raw({ type: "application/json" }), (req, res) => {
  const signature = String(req.headers["x-sweep-signature"] ?? "");
  const expected =
    "sha256=" + crypto.createHmac("sha256", SECRET).update(req.body).digest("hex");

  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.status(400).send("bad signature");

  const event = JSON.parse(req.body.toString("utf8"));
  switch (event.event_type) {
    case "payment.succeeded":      /* grant access for event.external_ref */ break;
    case "subscription.cancelled": /* revoke access */                       break;
  }

  res.status(200).send("ok"); // acknowledge fast
});`}</Pre>
              <p className="font-semibold text-gray-800">Responding & retries</p>
              <p>
                Return any <Code>2xx</Code> within <strong>10 seconds</strong> to acknowledge. Do slow work (emails,
                provisioning) <em>after</em> you respond, or hand it to a queue. If you don't return <Code>2xx</Code>,
                Sweep retries with backoff — after <strong>5 min, 30 min, 2 h, 5 h, then 10 h</strong>.
              </p>
              <p>
                Retries reuse the same <Code>X-Sweep-Event-Id</Code>, so make your handler <strong>idempotent</strong>:
                record processed event IDs and skip duplicates.
              </p>
            </Section>
          </div>

          <div className="mt-12 rounded-2xl border border-gray-200 bg-gray-50 p-6 text-center">
            <p className="text-sm text-gray-600">Ready to accept stablecoin subscriptions?</p>
            <Link to="/signup" className="mt-3 inline-block rounded-xl bg-gray-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-black">
              Create your account
            </Link>
          </div>
        </main>
      </div>

      <footer className="border-t border-gray-100">
        <div className="mx-auto max-w-7xl px-6 py-8 text-xs text-gray-400">
          A payment infrastructure for developers · Powered by stablecoins · © {new Date().getFullYear()} Sweep Console
        </div>
      </footer>
    </div>
  );
}

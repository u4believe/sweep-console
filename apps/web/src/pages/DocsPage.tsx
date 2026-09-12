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
          <p className="mt-1 text-xs text-gray-500">A payment succeeds, a renewal runs, a refund is issued…</p>
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

const toc = [
  {
    group: "Using Sweep Console",
    items: [
      { id: "creator-account", label: "Create a creator account" },
      { id: "subscribing", label: "Subscribe to a plan" },
      { id: "email-verification", label: "Email verification" },
      { id: "wallets", label: "Connecting & switching wallets" },
      { id: "upgrading", label: "Upgrading a plan" },
      { id: "revenue-split", label: "Revenue & settlement" },
      { id: "challenges", label: "Common challenges" },
    ],
  },
  {
    group: "Payment rail (API)",
    items: [
      { id: "rail-overview", label: "What the rail is" },
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

/* ── page ──────────────────────────────────────────────────────────────── */

export function DocsPage() {
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

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-6 py-12 lg:grid-cols-[230px_1fr]">
        {/* TOC */}
        <aside className="hidden lg:block">
          <nav className="sticky top-24 space-y-5 border-l border-gray-100 pl-4 text-sm">
            {toc.map((grp) => (
              <div key={grp.group}>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">{grp.group}</p>
                {grp.items.map((t) => (
                  <a key={t.id} href={`#${t.id}`} className="block py-1 text-gray-500 transition hover:text-brand-700">
                    {t.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">Documentation</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-gray-900">How Sweep Console works</h1>
          <p className="mt-3 text-lg text-gray-500">
            A guide to creating an account, accepting and paying for subscriptions, how fees and settlement work —
            and how to run the project locally with Circle's developer tools.
          </p>

          {/* ── Using Sweep Console ─────────────────────────────────────── */}
          <div className="mt-12 space-y-10">
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
                  tiers (name, price, interval, trial, features). You can add tiers later, but an existing tier's terms are
                  immutable — to change them, delete the plan and recreate it (deleted-plan data stays readable).
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
                is a <strong>cancel + resubscribe</strong>: the chosen tier's amount/interval is snapshotted onto the new
                subscription (terms are immutable per subscription).
              </p>
              <p>
                Completing the new subscription <strong>auto-replaces the old one</strong> (or you can revoke the old one first from
                the checkout). If you upgrade with the <strong>same wallet</strong> that already enabled cross-chain renewals, the
                grant carries over — no re-authorizing while that grant is still active.
              </p>
            </Section>

            <Section id="revenue-split" title="Creator revenue & settlement">
              <p>
                <strong>Revenue allocation.</strong> The platform fee is <strong>3%</strong>{" "}
                (<Code>PLATFORM_FEE_BPS=300</Code>) — so <strong>creators keep 97%</strong> of every charge. The split
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
                place where a leaked API key moves money to whoever holds it — treat the key accordingly.
              </p>
              <div className="rounded-xl border border-gray-200 px-5 py-1">
                <Row k="1 · POST /v1/mandates" v="You create a pending mandate and get back an authorization URL." />
                <Row k="2 · you send the payer there" v="They connect a wallet and sign one permission per chain." />
                <Row k="3 · mandate.authorized" v="The mandate flips to active. Now it can be charged." />
                <Row k="4 · POST /v1/charges" v={<>One pull, whenever your billing logic says so. Answers <Code>202</Code>.</>} />
                <Row k="5 · charge.succeeded" v="Settled on Arc, in the merchant's payout wallet." />
              </div>
            </Section>

            <Section id="rail-mandates" title="Create a mandate">
              <p>
                A mandate cannot be created server-to-server, because the permission is a wallet signature. Creating one
                mints a <Code>pending</Code> row and returns a hosted URL for the payer to open — the same redirect
                shape as a hosted checkout.
              </p>
              <Pre>{`curl -X POST https://api.sweepconsole.com/v1/mandates \
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
              <Pre>{`curl -X POST https://api.sweepconsole.com/v1/charges \
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
                <strong>Nothing, today.</strong> The authorization page confirms the permission at signing time, and
                after that Sweep sends the payer no email when a charge is collected — the events go to{" "}
                <strong>you</strong>, over webhooks. Hosted subscriptions get a receipt email from Sweep; rail charges do
                not.
              </p>
              <p>
                So the receipt is yours to send. <Code>charge.succeeded</Code> carries everything one needs —{" "}
                <Code>amount</Code>, <Code>source_chain</Code>, the Arc <Code>tx_hash</Code> and your{" "}
                <Code>external_ref</Code> — and a payer who is debited on a standing authorization with no notice from
                anyone will treat it as an unexplained withdrawal. Send something.
              </p>
              <p>
                <strong>Trials are yours too.</strong> A mandate has no trial: it is an authorization, not a plan. A free
                period on the rail is simply you not calling <Code>POST /v1/charges</Code> until it ends. Authorize on
                day one, charge on day fifteen — the mandate sits active and costs the payer nothing in between.
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
                happen — a subscription is created, a payment succeeds, a refund is issued. Your app reacts in real
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
              <Pre>{`curl -X POST https://your-api.example.com/v1/webhooks \\
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
                <Row k="mandate.revoked" v="The authorization was closed and will not be redeemed again." />
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

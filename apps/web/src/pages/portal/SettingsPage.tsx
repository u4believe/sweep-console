import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { WalletSettings } from "@/components/portal/WalletSettings";
import { SecuritySettings } from "@/components/portal/SecuritySettings";
import { useAuth } from "@/context/auth";
import { PageHeader } from "@/components/portal/PageHeader";
import { ErrorNote, Kicker, Mono, Section } from "@/components/portal/primitives";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface MerchantProfile {
  merchantId: string;
  name: string;
  email: string;
  walletAddress: string | null;
  walletType: string;
  addressVerifiedAt: string | null;
  isLive: boolean;
  createdAt: string;
}

/// Only what the go-live checklist needs from the webhooks endpoint.
interface WebhookSummary {
  deliveryCount: number;
}

const TABS = [
  { id: "account", label: "Account" },
  { id: "wallet", label: "Payout wallet" },
  { id: "branding", label: "Branding" },
  { id: "team", label: "Team" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SettingsPage() {
  const { refresh } = useAuth();
  const [params, setParams] = useSearchParams();
  const [profile, setProfile] = useState<MerchantProfile | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookSummary[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [nameError, setNameError] = useState("");

  // The tab lives in the URL so a reload, a back button, or a link someone
  // pastes to a teammate all land on the same panel.
  const requested = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : "account";

  useEffect(() => {
    fetch(`${API_URL}/portal/me`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: MerchantProfile; error?: { message?: string } }) => {
        if (json.data) { setProfile(json.data); setName(json.data.name); }
        else setError(json.error?.message ?? "Failed to load profile");
      })
      .catch(() => setError("Could not reach the API server"));

    // Feeds one row of the go-live checklist: an endpoint that exists but has
    // never received anything is not a working integration.
    fetch(`${API_URL}/portal/webhooks`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: WebhookSummary[] }) => setWebhooks(json.data ?? []))
      .catch(() => setWebhooks([]));
  }, []);

  async function saveName() {
    setNameError(""); setNameSaved(false); setSavingName(true);
    try {
      const res = await fetch(`${API_URL}/auth/complete-profile`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(data.error?.message ?? "Couldn't save. Please try again.");
      }
      setProfile((p) => (p ? { ...p, name: name.trim() } : p));
      await refresh();
      setNameSaved(true);
    } catch (e) {
      setNameError(e instanceof Error ? e.message : "Couldn't save. Please try again.");
    } finally {
      setSavingName(false);
    }
  }

  if (error) {
    return (
      <>
        <PageHeader kicker="Account" title="Settings" />
        <ErrorNote>{error}</ErrorNote>
      </>
    );
  }

  if (!profile) {
    return (
      <>
        <PageHeader kicker="Account" title="Settings" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Section key={i}>
            <div className="mb-3 h-4 w-40 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
            <div className="mb-2 h-3 w-full animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
            <div className="h-3 w-3/4 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
          </Section>
        ))}
      </>
    );
  }

  return (
    <>
      <PageHeader kicker={profile.name} title="Settings" />

      <div
        className="flex"
        style={{ borderBottom: "2px solid var(--color-divider)", padding: "0 32px", overflowX: "auto" }}
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setParams(t.id === "account" ? {} : { tab: t.id }, { replace: true })}
              aria-current={active ? "page" : undefined}
              className="cursor-pointer"
              style={{
                background: "transparent",
                border: 0,
                borderBottom: `3px solid ${active ? "var(--color-accent)" : "transparent"}`,
                color: active ? "var(--color-text)" : "var(--color-neutral-700)",
                padding: "12px 16px 10px",
                fontFamily: "var(--font-body)",
                fontSize: 13.5,
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "account" && (
        <AccountTab
          profile={profile}
          webhooks={webhooks}
          name={name}
          setName={(v) => { setName(v); setNameSaved(false); setNameError(""); }}
          onSave={saveName}
          saving={savingName}
          saved={nameSaved}
          saveError={nameError}
        />
      )}

      {tab === "wallet" && <WalletTab profile={profile} />}

      {tab === "branding" && (
        <ComingSoon
          title="Checkout branding"
          blurb="Your display name, support email, terms URL and an accent colour, applied to the hosted checkout page and email receipts."
          why="Nothing here is stored yet — these fields don't exist on your account, and the checkout has no hook to read them. Building it means a schema change plus a pass over checkout and receipts."
        />
      )}

      {tab === "team" && (
        <ComingSoon
          title="Team"
          blurb="Invite teammates by email, with roles — only owners move funds or go live."
          why="Your account is a single login today; there is no second person for the portal to recognise. This is an access-control model rather than a screen, and it decides who can clear the confirmation prompts on payouts."
        />
      )}
    </>
  );
}

/* ── Account ─────────────────────────────────────────────────────────────── */

function AccountTab({
  profile, webhooks, name, setName, onSave, saving, saved, saveError,
}: {
  profile: MerchantProfile;
  webhooks: WebhookSummary[] | null;
  name: string;
  setName: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  saveError: string;
}) {
  const walletReady = Boolean(profile.walletAddress && profile.addressVerifiedAt);
  const webhooksReady = (webhooks ?? []).some((w) => w.deliveryCount > 0);

  return (
    <>
      <div className="grid md:grid-cols-[1.2fr_1fr]">
        <section
          className="md:border-r"
          style={{ padding: "26px 32px", borderColor: "var(--color-divider)" }}
        >
          <h3 className="m-0" style={{ fontSize: 20, letterSpacing: "-0.02em", marginBottom: 4 }}>Account</h3>
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)", marginBottom: 20 }}>
            Company name is shown to subscribers at checkout.
          </p>

          <div
            className="flex flex-wrap items-end gap-3"
            style={{ maxWidth: 480, borderTop: "1px solid var(--color-divider)", paddingTop: 18 }}
          >
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label htmlFor="company-name">Company name</label>
              <input
                id="company-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary shrink-0"
              style={{ padding: "11px 18px" }}
              onClick={onSave}
              disabled={saving || name.trim().length === 0 || name.trim() === profile.name}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {saved && <p className="m-0" style={{ fontSize: 12, color: "var(--color-accent-700)", marginTop: 6 }}>Saved.</p>}
          {saveError && <p className="m-0" style={{ fontSize: 12, color: "var(--color-accent-700)", marginTop: 6 }}>{saveError}</p>}

          <dl className="m-0" style={{ marginTop: 26, borderTop: "1px solid var(--color-divider)" }}>
            {[
              { k: "Email", v: profile.email },
              { k: "Merchant ID", v: <Mono size={12.5}>{profile.merchantId}</Mono> },
              {
                k: "Mode",
                v: <span className={`tag ${profile.isLive ? "tag-accent" : "tag-outline"}`}>
                     {profile.isLive ? "Live" : "Test"}
                   </span>,
              },
              {
                k: "Member since",
                v: new Date(profile.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
              },
            ].map((row) => (
              <div
                key={row.k}
                className="flex flex-wrap gap-3"
                style={{ borderBottom: "1px solid var(--color-divider)", padding: "10px 0", fontSize: 14 }}
              >
                <dt style={{ width: 130, color: "var(--color-neutral-700)" }}>{row.k}</dt>
                <dd className="m-0">{row.v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <aside style={{ padding: "26px 32px", background: "var(--color-surface)" }}>
          <h3 className="m-0" style={{ fontSize: 20, letterSpacing: "-0.02em", marginBottom: 4 }}>Go live</h3>
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-800)", marginBottom: 16, lineHeight: 1.6 }}>
            Live mode charges real USDC. You&apos;ll need a verified payout wallet and a webhook
            endpoint receiving events.
          </p>

          <div style={{ borderTop: "1px solid var(--color-divider)" }}>
            {[
              {
                label: "Payout wallet verified",
                // Read from the account itself, so the row can't drift from reality.
                state: walletReady ? "Done" : profile.walletAddress ? "Unverified" : "Needed",
                done: walletReady,
              },
              {
                label: "Webhook endpoint receiving events",
                // An endpoint that exists but has delivered nothing isn't proof
                // of an integration, so this counts deliveries, not endpoints.
                state: webhooks === null ? "…" : webhooksReady ? "Done" : "Needed",
                done: webhooksReady,
              },
              {
                label: "Business details for compliance",
                state: "Not open yet",
                done: false,
              },
            ].map((c) => (
              <div
                key={c.label}
                className="flex items-center gap-3"
                style={{ padding: "12px 0", borderBottom: "1px solid var(--color-divider)" }}
              >
                <span
                  style={{
                    width: 14, height: 14, flex: "none", display: "block",
                    background: c.done ? "var(--color-accent)" : "var(--color-neutral-300)",
                  }}
                />
                <span style={{ fontSize: 13 }}>{c.label}</span>
                <span className={`tag ${c.done ? "tag-accent" : "tag-neutral"}`} style={{ marginLeft: "auto" }}>
                  {c.state}
                </span>
              </div>
            ))}
          </div>

          {/* Deliberately inert: there is no live-access request to submit yet,
              and a button that silently does nothing is worse than one that
              says so. */}
          <button type="button" className="btn btn-primary" style={{ marginTop: 20, padding: "11px 18px" }} disabled>
            Request live access
          </button>
          <p className="m-0" style={{ fontSize: 11.5, color: "var(--color-neutral-700)", marginTop: 8, lineHeight: 1.5 }}>
            Live mode isn&apos;t open yet. The checklist above tracks what you&apos;ll need when it is.
          </p>
        </aside>
      </div>

      {/* Full width under the grid: enrolling an authenticator is a wide,
          multi-step job that would be cramped in the aside column. */}
      <SecuritySettings />
    </>
  );
}

/* ── Payout wallet ───────────────────────────────────────────────────────── */

function WalletTab({ profile }: { profile: MerchantProfile }) {
  return (
    <section style={{ padding: "26px 32px", maxWidth: 820 }}>
      <WalletSettings
        initialAddress={profile.walletAddress}
        walletType={profile.walletType}
        addressVerifiedAt={profile.addressVerifiedAt}
      />

      <div style={{ marginTop: 26 }}>
        <Kicker>Settlement chain</Kicker>
        <div
          className="flex flex-wrap items-center gap-3.5"
          style={{ border: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: "16px 18px" }}
        >
          <svg viewBox="0 0 31 32" height="24" aria-label="Arc" style={{ display: "block", flex: "none", height: 24, width: "auto" }}>
            <path
              d="M0 32C0.260374 24.166 1.59328 16.8547 3.82135 11.1696C6.64316 3.96673 10.728 0 15.3227 0C19.9174 0 24.0016 3.96673 26.824 11.1696C28.292 14.9157 29.372 19.3668 30.0119 24.2089C30.0691 24.6414 30.1178 25.0809 30.1678 25.5195C30.184 25.5466 30.1938 25.5718 30.1905 25.5923C30.1905 25.5923 30.5666 27.9326 30.6465 32H30.604C30.0462 31.5439 23.4681 26.3931 12.5636 27.8845C12.7282 26.0457 12.9544 24.2565 13.2467 22.5415C13.2617 22.4538 13.2789 22.3692 13.2942 22.2821C17.5711 22.1536 21.3146 22.6486 24.1853 23.2972C24.1746 23.2293 24.1657 23.1594 24.1547 23.0918C23.5647 19.4302 22.6941 16.0779 21.5717 13.2131C19.7364 8.52888 17.3416 5.61852 15.3227 5.61852C13.3038 5.61852 10.909 8.52888 9.07379 13.2131C8.62954 14.3462 8.22512 15.5545 7.86244 16.8291C7.35258 18.615 6.92424 20.5296 6.58214 22.5413C6.0758 25.5124 5.75944 28.6987 5.64292 32H0Z"
              fill="var(--color-text)"
            />
          </svg>
          <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 16 }}>Arc</span>
          <span className="tag tag-neutral">Fixed</span>
        </div>
        <p className="m-0" style={{ fontSize: 12, color: "var(--color-neutral-700)", marginTop: 10, maxWidth: "64ch", lineHeight: 1.6 }}>
          Every settlement lands on Arc — it isn&apos;t a choice, and there is nothing to configure.
          Customers pay from Arc, Base, Arbitrum or Optimism and full settlement lands on Arc
          automatically, so you always reconcile in one place.
        </p>
      </div>
    </section>
  );
}

/* ── Not built yet ───────────────────────────────────────────────────────── */

/**
 * An honest placeholder. It says what the tab will do and, in one line, what is
 * actually missing — a merchant who knows why a thing is absent stops looking
 * for the setting they think they've lost.
 */
function ComingSoon({ title, blurb, why }: { title: string; blurb: string; why: string }) {
  return (
    <section style={{ padding: "26px 32px", maxWidth: 720 }}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="m-0" style={{ fontSize: 20, letterSpacing: "-0.02em" }}>{title}</h3>
        <span className="tag tag-outline">Coming soon</span>
      </div>
      <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)", marginTop: 6, lineHeight: 1.6 }}>
        {blurb}
      </p>
      <p
        className="m-0"
        style={{
          fontSize: 12.5,
          color: "var(--color-neutral-700)",
          marginTop: 18,
          paddingLeft: 12,
          borderLeft: "3px solid var(--color-divider)",
          lineHeight: 1.6,
        }}
      >
        {why}
      </p>
    </section>
  );
}

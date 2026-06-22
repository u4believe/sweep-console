import { useEffect, useState } from "react";
import { WalletSettings } from "@/components/portal/WalletSettings";
import { useAuth } from "@/context/auth";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface MerchantProfile {
  merchantId: string;
  name: string;
  email: string;
  webhookSecret: string;
  walletAddress: string | null;
  walletType: string;
  addressVerifiedAt: string | null;
  isLive: boolean;
}

export function SettingsPage() {
  const { refresh } = useAuth();
  const [profile, setProfile] = useState<MerchantProfile | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [nameError, setNameError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/portal/me`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: MerchantProfile; error?: { message?: string } }) => {
        if (json.data) { setProfile(json.data); setName(json.data.name); }
        else setError(json.error?.message ?? "Failed to load profile");
      })
      .catch(() => setError("Could not reach the API server"));
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

  if (error) return <div className="rounded-xl bg-red-50 p-6 text-sm text-red-600">{error}</div>;

  if (!profile) {
    return (
      <div className="space-y-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card p-6 animate-pulse space-y-3">
            <div className="h-4 w-32 rounded bg-gray-200" />
            <div className="h-3 w-full rounded bg-gray-100" />
            <div className="h-3 w-3/4 rounded bg-gray-100" />
          </div>
        ))}
      </div>
    );
  }

  const testKeyPrefix = `test_${profile.merchantId.replace(/-/g, "").slice(0, 8)}`;
  const liveKeyPrefix = `live_${profile.merchantId.replace(/-/g, "").slice(0, 8)}`;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Settings</h1>

      <div className="space-y-6">
        <div className="card p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Account</h2>

          {/* Editable company / display name (what subscribers see on checkout) */}
          <div className="mb-5">
            <label htmlFor="company-name" className="block text-sm font-medium text-gray-700">Company name</label>
            <p className="mb-2 text-xs text-gray-400">Shown to your subscribers on the checkout page.</p>
            <div className="flex gap-2">
              <input
                id="company-name"
                value={name}
                onChange={(e) => { setName(e.target.value); setNameSaved(false); setNameError(""); }}
                maxLength={100}
                className="w-full max-w-xs rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                onClick={saveName}
                disabled={savingName || name.trim().length === 0 || name.trim() === profile.name}
                className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-50"
              >
                {savingName ? "Saving…" : "Save"}
              </button>
            </div>
            {nameSaved && <p className="mt-1 text-xs text-brand-600">✓ Saved.</p>}
            {nameError && <p className="mt-1 text-xs text-red-600">{nameError}</p>}
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex gap-3">
              <span className="w-24 text-gray-500">Email</span>
              <span className="font-medium text-gray-900">{profile.email}</span>
            </div>
            <div className="flex gap-3">
              <span className="w-24 text-gray-500">Merchant ID</span>
              <code className="font-mono text-xs text-gray-600">{profile.merchantId}</code>
            </div>
            <div className="flex gap-3">
              <span className="w-24 text-gray-500">Mode</span>
              <span className={`badge ${profile.isLive ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                {profile.isLive ? "Live" : "Test"}
              </span>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-900">API Keys</h2>
          <p className="mb-4 text-sm text-gray-500">API keys are shown only once at signup. Contact support to rotate them.</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Test Secret Key</p>
                <p className="font-mono text-xs text-gray-500">{testKeyPrefix}••••••••••••••••</p>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Live Secret Key</p>
                <p className="font-mono text-xs text-gray-500">{liveKeyPrefix}••••••••••••••••</p>
              </div>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-900">Webhook Signing Secret</h2>
          <p className="mb-3 text-sm text-gray-600">Use this secret to verify that webhook events were sent by SweepConsole.</p>
          <div className="rounded-lg bg-gray-50 px-4 py-3">
            <code className="break-all font-mono text-xs text-gray-700">{profile.webhookSecret}</code>
          </div>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-900 p-4 text-xs text-green-400">
{`// Verify in your webhook handler:
const sig = req.headers['x-sweep-signature'];
const body = await req.text();
const expected = 'sha256=' + createHmac('sha256', webhookSecret)
  .update(body).digest('hex');
if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
  return res.status(400).send('Invalid signature');
}`}
          </pre>
        </div>

        <WalletSettings
          initialAddress={profile.walletAddress}
          walletType={profile.walletType}
          addressVerifiedAt={profile.addressVerifiedAt}
        />
      </div>
    </div>
  );
}

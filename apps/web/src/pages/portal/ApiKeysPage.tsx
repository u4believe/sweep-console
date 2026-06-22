import { useEffect, useState, useId } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface KeyInfo {
  hasTestKey: boolean;
  name: string;
  prefix: string | null;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="shrink-0 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

export function ApiKeysPage() {
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const nameId = useId();

  useEffect(() => {
    fetch(`${API_URL}/portal/api-keys`, { credentials: "include" })
      .then(async (r) => {
        const json = await r.json() as { data?: KeyInfo; error?: { message?: string } };
        if (!r.ok) setLoadError(json.error?.message ?? "Failed to load API keys");
        else if (json.data) setKeyInfo(json.data);
      })
      .catch(() => setLoadError("Could not reach the API server"));
  }, []);

  async function handleGenerate(e: { preventDefault(): void }) {
    e.preventDefault();
    setGenerating(true);
    setGenError("");
    setNewKey(null);

    const res = await fetch(`${API_URL}/portal/api-keys/regenerate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() || "Default" }),
    });
    const json = await res.json() as { key?: string; name?: string; prefix?: string; error?: { message?: string } };
    setGenerating(false);

    if (!res.ok) {
      setGenError(json.error?.message ?? "Failed to generate key");
      return;
    }

    setNewKey(json.key ?? "");
    setKeyInfo({ hasTestKey: true, name: json.name ?? "Default", prefix: json.prefix ?? null });
    setShowForm(false);
    setName("");
  }

  if (loadError) {
    return <div className="rounded-xl bg-red-50 p-6 text-sm text-red-600">{loadError}</div>;
  }

  if (!keyInfo) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card p-6 animate-pulse space-y-3">
            <div className="h-4 w-32 rounded bg-gray-200" />
            <div className="h-3 w-64 rounded bg-gray-100" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Keys</h1>
          <p className="mt-1 text-sm text-gray-500">
            Test keys let you integrate SweepConsole without real payments.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => { setShowForm(true); setNewKey(null); setGenError(""); }}
            className="btn-primary text-sm"
          >
            Create API key
          </button>
        )}
      </div>

      {/* One-time key reveal */}
      {newKey && (
        <div className="mb-6 rounded-xl border border-green-200 bg-green-50 p-5">
          <p className="mb-2 text-sm font-semibold text-green-800">
            Your new test API key — copy it now, it won&apos;t be shown again.
          </p>
          <div className="flex items-center gap-3 rounded-lg bg-white border border-green-200 px-4 py-3">
            <code className="flex-1 break-all font-mono text-sm text-gray-900">{newKey}</code>
            <CopyButton value={newKey} />
          </div>
          <p className="mt-2 text-xs text-green-700">
            The previous key (if any) has been invalidated.
          </p>
        </div>
      )}

      {/* Generate / Regenerate form */}
      {showForm && (
        <form onSubmit={handleGenerate} className="mb-6 card p-6 space-y-4">
          <h2 className="text-base font-semibold text-gray-900">Create API key</h2>
          {keyInfo.hasTestKey && (
            <p className="rounded-lg bg-yellow-50 px-4 py-3 text-sm text-yellow-700">
              Regenerating will immediately invalidate your current key. Any integration using it will break.
            </p>
          )}
          {genError && (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{genError}</p>
          )}
          <div>
            <label htmlFor={nameId} className="block mb-1.5 text-sm font-medium text-gray-700">
              Key name <span className="text-gray-400">(optional)</span>
            </label>
            <input
              id={nameId}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Local dev, Staging server"
              maxLength={50}
              className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={generating}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {generating ? "Generating…" : "Create API key"}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setGenError(""); setName(""); }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Current key status */}
      <div className="card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium text-gray-900">{keyInfo.name}</p>
              <span className="badge bg-yellow-100 text-yellow-700">Test</span>
            </div>
            {keyInfo.prefix ? (
              <p className="mt-1 font-mono text-sm text-gray-500">
                {keyInfo.prefix}••••••••••••••••••••••••••••••••
              </p>
            ) : (
              <p className="mt-1 text-sm text-gray-400">No key created yet.</p>
            )}
          </div>
          {keyInfo.hasTestKey && (
            <span className="shrink-0 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
              Active
            </span>
          )}
        </div>

        {!keyInfo.hasTestKey && (
          <p className="mt-4 text-sm text-gray-500">
            Click <strong>Create key</strong> above to generate your first test API key.
          </p>
        )}

        <div className="mt-5 border-t border-gray-100 pt-5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Usage</p>
          <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-xs text-green-400">{`Authorization: Bearer ${keyInfo.prefix ? keyInfo.prefix + "••••••••••••••••" : "test_your_key_here"}`}</pre>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-blue-50 border border-blue-100 p-4 text-sm text-blue-700">
        <strong>Beta note:</strong> Only test keys are available during the beta period. Live keys will be enabled when you go live.
      </div>
    </div>
  );
}

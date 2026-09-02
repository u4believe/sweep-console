import { useEffect, useState, useId } from "react";
import { PageHeader } from "@/components/portal/PageHeader";
import { ErrorNote, Kicker, Mono, Section } from "@/components/portal/primitives";
import { apiFetch, wasCancelled } from "@/lib/stepup";

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
      className="btn btn-secondary shrink-0"
      style={{ padding: "6px 12px", fontSize: 12 }}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function ApiKeysPage() {
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState("");
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

    // Guarded: a new key outlives the session that minted it, so apiFetch
    // will ask the merchant to confirm before this goes through.
    const res = await apiFetch(`/portal/api-keys/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() || "Default" }),
    });
    const cancelled = await wasCancelled(res);
    const json = await res.json() as { key?: string; name?: string; prefix?: string; error?: { message?: string } };
    setGenerating(false);

    if (!res.ok) {
      if (!cancelled) setGenError(json.error?.message ?? "Failed to generate key");
      return;
    }

    setNewKey(json.key ?? "");
    setKeyInfo({ hasTestKey: true, name: json.name ?? "Default", prefix: json.prefix ?? null });
    setName("");
  }

  if (loadError) {
    return (
      <>
        <PageHeader kicker="Developers" title="API keys" />
        <ErrorNote>{loadError}</ErrorNote>
      </>
    );
  }

  return (
    <>
      <PageHeader kicker="Developers" title="API keys" />

      {!keyInfo ? (
        <Section bordered={false}>
          <div className="mb-3 h-4 w-40 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
          <div className="h-3 w-64 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
        </Section>
      ) : (
        <>
          {/* One-time key reveal. */}
          {newKey && (
            <div style={{ padding: "24px 32px 0" }}>
              <div
                style={{
                  border: "2px solid var(--color-accent)",
                  background: "var(--color-accent-100)",
                  padding: "18px 20px",
                }}
              >
                <p
                  className="m-0 mb-1"
                  style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 15 }}
                >
                  Your new test API key — copy it now
                </p>
                <p className="m-0 mb-3" style={{ fontSize: 12.5, color: "var(--color-accent-800)" }}>
                  Shown only once. The previous key, if any, has been invalidated.
                </p>
                <div
                  className="flex items-center gap-3"
                  style={{
                    background: "var(--color-bg)",
                    border: "1px solid var(--color-divider)",
                    padding: "10px 14px",
                  }}
                >
                  <code
                    className="flex-1"
                    style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, wordBreak: "break-all" }}
                  >
                    {newKey}
                  </code>
                  <CopyButton value={newKey} />
                </div>
              </div>
            </div>
          )}

          {/* Current key. */}
          <Section title="Current key">
            <div style={{ borderTop: "1px solid var(--color-divider)", paddingTop: 14 }}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="m-0" style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 17 }}>
                      {keyInfo.name}
                    </p>
                    <span className="tag tag-outline">Test</span>
                  </div>
                  {keyInfo.prefix ? (
                    <p className="m-0 mt-1.5">
                      <Mono size={13}>{keyInfo.prefix}••••••••••••••••••••••••••••••••</Mono>
                    </p>
                  ) : (
                    <p className="m-0 mt-1.5" style={{ fontSize: 13, color: "var(--color-neutral-600)" }}>
                      No key created yet.
                    </p>
                  )}
                </div>
                {keyInfo.hasTestKey && (
                  <span className="tag tag-accent ml-auto shrink-0">Active</span>
                )}
              </div>

              <div style={{ borderTop: "1px solid var(--color-divider)", marginTop: 18, paddingTop: 14 }}>
                <Kicker>Usage</Kicker>
                <pre
                  className="m-0 overflow-x-auto"
                  style={{
                    background: "var(--color-neutral-900)",
                    color: "var(--color-neutral-100)",
                    padding: "14px 16px",
                    fontFamily: "ui-monospace, Menlo, monospace",
                    fontSize: 12.5,
                  }}
                >
{`Authorization: Bearer ${keyInfo.prefix ? keyInfo.prefix + "••••••••••••••••" : "test_your_key_here"}`}
                </pre>
              </div>
            </div>
          </Section>

          {/* Create / rotate. */}
          <Section title={keyInfo.hasTestKey ? "Rotate key" : "Create key"}>
            <form onSubmit={handleGenerate} className="max-w-lg">
              {keyInfo.hasTestKey && (
                <p className="m-0 mb-3" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>
                  Rotating immediately invalidates the current key — any integration using it will break.
                </p>
              )}
              {genError && (
                <p className="m-0 mb-3" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{genError}</p>
              )}

              <div className="field" style={{ marginBottom: 14 }}>
                <label htmlFor={nameId}>Key name (optional)</label>
                <input
                  id={nameId}
                  className="input"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Local dev, Staging server"
                  maxLength={50}
                />
              </div>

              <button type="submit" className="btn btn-primary" disabled={generating}>
                {generating ? "Generating…" : keyInfo.hasTestKey ? "Rotate API key" : "Create API key"}
              </button>
            </form>
          </Section>

          <Section bordered={false}>
            <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
              <strong>Beta note:</strong> only test keys are available during the beta period. Live
              keys are enabled when you go live.
            </p>
          </Section>
        </>
      )}
    </>
  );
}

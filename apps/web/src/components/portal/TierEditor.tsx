import { useState } from "react";
import { featureList, INTERVAL_NOUNS, type Tier } from "@/pages/portal/plan-model";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * Edits ONE existing tier, independently of every other tier on the plan.
 *
 * A tier's price, interval and trial are its billing terms — subscriptions
 * snapshot them at checkout and the checkout page sells against them — so they
 * are fixed for the life of the tier and shown read-only here. Name and feature
 * copy are presentation: they apply from the next checkout onward and are
 * editable in place.
 *
 * Saving or removing this tier issues a request scoped to this tier alone; no
 * sibling tier is read, rewritten, or invalidated by either action.
 *
 * The plan's own terms (the default option at checkout) are edited through this
 * same component with planDefault set. They have no PlanTier row, so they patch
 * the plan instead and cannot be removed — but the editable/locked split is
 * identical, and a merchant shouldn't have to learn two different editors.
 */
export function TierEditor({
  tier,
  planId,
  isDefault,
  isRecommended,
  onRecommend,
  recommending,
  subscriberCount,
  onChanged,
  planDefault = false,
}: {
  tier: Tier;
  planId: string;
  isDefault: boolean;
  /** This tier currently carries the checkout badge. */
  isRecommended: boolean;
  /** Make this tier the recommended one, or clear the badge if it already is. */
  onRecommend: () => void;
  recommending: boolean;
  subscriberCount: number;
  onChanged: () => void;
  /** The plan's own terms rather than a PlanTier: patched on the plan, never removable. */
  planDefault?: boolean;
}) {
  const [name, setName] = useState(tier.name);
  const [feats, setFeats] = useState(featureList(tier.features).join("\n"));

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const originalFeats = featureList(tier.features).join("\n");

  const dirty = name.trim() !== tier.name || feats !== originalFeats;
  const canSave = dirty && name.trim().length > 0 && !saving;

  const endpoint = planDefault
    ? `${API_URL}/portal/plans/${planId}/default-tier`
    : `${API_URL}/portal/plans/${planId}/tiers/${tier.id}`;

  async function save() {
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = {};
      if (name.trim() !== tier.name) body.name = name.trim();
      if (feats !== originalFeats) {
        body.features = feats.split("\n").map((s) => s.trim()).filter(Boolean);
      }

      const res = await fetch(endpoint, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? "Couldn't save this tier.");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this tier.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    setError("");
    try {
      const res = await apiFetch(`/portal/plans/${planId}/tiers/${tier.id}`, { method: "DELETE" });
      if (!res.ok) {
        // A closed dialog is not a failure — say nothing and put the row back.
        if (await wasCancelled(res)) {
          setRemoving(false);
          setConfirmRemove(false);
          return;
        }
        throw new Error(await messageOf(res, "Couldn't remove this tier."));
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove this tier.");
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  return (
    <div style={{ padding: "18px 0 20px", borderBottom: "1px solid var(--color-divider)" }}>
      {/* Locked billing terms, stated plainly on the first line. */}
      <div className="flex flex-wrap items-baseline gap-3">
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 17 }}>
          {(tier.amount / 1_000_000).toFixed(2)} USDC
        </span>
        <span style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
          per {INTERVAL_NOUNS[tier.interval] ?? tier.interval}
        </span>
        <span style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
          {tier.trial_days > 0 ? `${tier.trial_days}-day trial` : "no trial"}
        </span>
        {isDefault && <span className="tag tag-accent">Default</span>}
        {isRecommended && <span className="tag tag-outline">Recommended</span>}
        <span className="tag tag-neutral">Price, interval &amp; trial locked</span>

        {planDefault ? null : confirmRemove ? (
          <span className="ml-auto flex items-center gap-2">
            <span style={{ fontSize: 12, color: "var(--color-neutral-800)" }}>
              Retire {tier.name} from checkout?
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: "5px 10px", fontSize: 12 }}
              onClick={() => setConfirmRemove(false)}
              disabled={removing}
            >
              Keep
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: "5px 10px", fontSize: 12 }}
              onClick={remove}
              disabled={removing}
            >
              {removing ? "Removing…" : "Remove"}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-ghost ml-auto"
            style={{ fontSize: 12 }}
            onClick={() => setConfirmRemove(true)}
          >
            Remove tier
          </button>
        )}
      </div>

      {/* Editable presentation. */}
      <div
        className="mt-3 grid items-start gap-5"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}
      >
        <div className="flex flex-col gap-3">
          <div className="field">
            <label htmlFor={`name-${tier.id}`}>Tier name</label>
            <input
              id={`name-${tier.id}`}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
            />
          </div>

          <div className="field">
            <label htmlFor={`feats-${tier.id}`}>Features — one per line</label>
            <textarea
              id={`feats-${tier.id}`}
              className="input"
              style={{ minHeight: 92 }}
              value={feats}
              onChange={(e) => setFeats(e.target.value)}
            />
          </div>

          {error && (
            <p className="m-0" style={{ fontSize: 12, color: "var(--color-accent-700)" }}>{error}</p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: "7px 12px", fontSize: 12 }}
              onClick={save}
              disabled={!canSave}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={onRecommend}
              disabled={recommending}
            >
              {recommending
                ? "Saving…"
                : isRecommended
                  ? "Remove Recommended badge"
                  : "Mark as Recommended"}
            </button>
            {saved && (
              <span style={{ fontSize: 12, color: "var(--color-accent-700)" }}>Saved.</span>
            )}
            {dirty && !saving && !saved && (
              <span style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>Unsaved changes</span>
            )}
          </div>
        </div>

        <p className="m-0" style={{ fontSize: 12, color: "var(--color-neutral-700)", lineHeight: 1.6 }}>
          Name and feature copy apply from the next checkout onward
          {subscriberCount > 0 && (
            <> — the {subscriberCount === 1 ? "1 subscriber" : `${subscriberCount} subscribers`} already
            on this plan keep the terms they signed up with</>
          )}
          . Price, interval and trial length are fixed once a tier exists; add another tier to sell
          different terms.
          <br />
          <br />
          {planDefault ? (
            <>
              These are the plan&apos;s own terms — the option every subscriber sees. They can be
              renamed and re-described, but not removed: delete the plan to retire them.
            </>
          ) : (
            <>
              Removing retires this tier from checkout — no new subscriber can pick it, existing ones
              keep billing, and no other tier is affected.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

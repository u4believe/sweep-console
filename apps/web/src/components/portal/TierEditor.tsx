import { useState } from "react";
import { featureList, INTERVAL_NOUNS, type Tier } from "@/pages/portal/plan-model";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * Edits ONE existing tier, independently of every other tier on the plan.
 *
 * The price may be LOWERED, never raised. Every subscriber signed a wallet
 * permission capped at the price they saw, so a cut is always collectable while
 * a rise would be refused by their own wallet and drop them into dunning. The
 * field below is therefore bounded by today's price, and a cut reaches existing
 * subscribers at their next renewal — which is the point of being able to make
 * one.
 *
 * The interval and trial stay fixed for the life of the tier. The interval is
 * baked into every signed grant's period schedule, so changing it would
 * desynchronise each subscriber's enforcer window from the billing clock; the
 * trial is a promise already made to whoever took it. Name and feature copy are
 * presentation and apply from the next checkout onward.
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
  // Held as the string the merchant typed, so "9." and "9.0" behave while typing.
  const [price, setPrice] = useState((tier.amount / 1_000_000).toFixed(2));
  // No default, deliberately. Every option reprices a different set of people,
  // so a pre-selected one would be a decision made on the creator's behalf — and
  // the API refuses a price without a scope for the same reason.
  const [scope, setScope] = useState<"" | "new" | "existing" | "everyone">("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const originalFeats = featureList(tier.features).join("\n");
  const originalPrice = (tier.amount / 1_000_000).toFixed(2);

  // Micro-units, rounded rather than truncated: 9.999 typed into a USDC field is
  // a slip, and flooring it to 9.99 would quietly undercharge for the life of
  // the plan.
  const priceMicros = Math.round(Number(price) * 1_000_000);
  const priceValid = /^\d+(\.\d{1,6})?$/.test(price.trim()) && priceMicros > 0;
  const priceRaised = priceValid && priceMicros > tier.amount;
  const priceChanged = priceValid && priceMicros !== tier.amount;

  const dirty = name.trim() !== tier.name || feats !== originalFeats || price.trim() !== originalPrice;
  const canSave =
    dirty &&
    name.trim().length > 0 &&
    !saving &&
    (!priceChanged || (priceValid && scope !== ""));

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
      if (priceChanged) {
        body.amount = priceMicros;
        body.applies_to = scope;
      }

      // apiFetch, not fetch: a price change is step-up guarded, so this request
      // is answered with a 401 naming the challenge and has to be replayed with
      // the proof. Plain fetch would surface that as "Couldn't save this tier."
      const res = await apiFetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Closing the dialog is not a failure — say nothing and leave the form
        // as it was, so the merchant can change their mind without an error.
        if (await wasCancelled(res)) return;
        throw new Error(await messageOf(res, "Couldn't save this tier."));
      }
      setSaved(true);
      setScope("");
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
        <span className="tag tag-neutral">Interval &amp; trial locked</span>

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
            <label htmlFor={`price-${tier.id}`}>
              Price per {INTERVAL_NOUNS[tier.interval] ?? tier.interval}
            </label>
            <input
              id={`price-${tier.id}`}
              className="input"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              aria-describedby={`price-help-${tier.id}`}
              aria-invalid={(price.trim() !== "" && !priceValid) || undefined}
            />
            <p
              id={`price-help-${tier.id}`}
              className="m-0 mt-1"
              style={{ fontSize: 11.5, color: "var(--color-neutral-700)" }}
            >
              {price.trim() !== "" && !priceValid
                ? "Enter an amount in USDC, up to 6 decimal places."
                : priceChanged
                  ? `${priceRaised ? "Raising" : "Lowering"} from ${originalPrice} to ${Number(price).toFixed(2)} USDC.` +
                    (priceRaised
                      // The consequence of a raise, before they choose a scope:
                      // a subscriber's wallet cap may not reach the new price.
                      ? " Subscribers whose wallet permission is too small for the new price are asked to" +
                        " re-authorize; nothing is collected from them until they do, and they are never" +
                        " charged more than they approved."
                      : " Every subscriber's permission already covers a lower amount, so nothing needs re-approving.")
                  : `Currently ${originalPrice} USDC. Changing it asks who it applies to, and emails the subscribers it affects.`}
            </p>
          </div>

          {/* The scope. Only once a price is actually different — offering it
              while nothing has changed is a question about nothing. */}
          {priceChanged && priceValid && (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ fontSize: 12.5, fontWeight: 600, padding: 0 }}>
                Who does {Number(price).toFixed(2)} USDC apply to?
              </legend>
              <div className="mt-1 flex flex-col gap-1.5">
                {([
                  ["new", "New subscribers only", "Everyone already subscribed keeps the price they signed up at. Nobody is emailed, because nobody's price changed."],
                  ["existing", "Existing subscribers only", `The listed price stays ${originalPrice} USDC for new signups. Current subscribers move at their next renewal.`],
                  ["everyone", "Everyone", "The listed price changes and current subscribers move at their next renewal."],
                ] as const).map(([id, label, note]) => (
                  <label key={id} className="flex items-start gap-2" style={{ fontSize: 12.5, cursor: "pointer" }}>
                    <input
                      type="radio"
                      name={`scope-${tier.id}`}
                      id={`scope-${tier.id}-${id}`}
                      checked={scope === id}
                      onChange={() => setScope(id)}
                      style={{ accentColor: "var(--color-accent)", marginTop: 3, flex: "none" }}
                    />
                    <span className="min-w-0">
                      <span style={{ fontWeight: 600 }}>{label}</span>
                      <span className="block" style={{ fontSize: 11.5, color: "var(--color-neutral-700)", lineHeight: 1.45 }}>
                        {note}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="m-0 mt-2" style={{ fontSize: 11.5, color: "var(--color-neutral-700)" }}>
                {scope === ""
                  ? "Pick one to save."
                  : scope === "new"
                    ? "Saving asks you to confirm it's you."
                    : "Saving asks you to confirm it's you, then emails every affected subscriber the old price, the new price, and when it starts."}
              </p>
            </fieldset>
          )}

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
          Name and feature copy apply from the next checkout onward. A price cut applies to everyone,
          including the{" "}
          {subscriberCount > 0
            ? subscriberCount === 1
              ? "1 subscriber"
              : `${subscriberCount} subscribers`
            : "subscribers"}{" "}
          already on this plan, from their next renewal. The interval and trial length are fixed once a
          tier exists; add another tier to sell different terms.
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

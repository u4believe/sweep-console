import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Kicker, Section } from "@/components/portal/primitives";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * What a creator's balance is worth delivered on a chain we don't settle on.
 *
 * Settlement pays a creator wherever their subscriber paid from, so revenue
 * arrives spread across Base, Arbitrum, Optimism and Monad — and the existing
 * withdrawal moves it to an address on that same chain. This panel answers the
 * other question: all of it, on Solana, in one move, for how much.
 *
 * QUOTES ONLY, DELIBERATELY VISIBLE AS SUCH. The API behind it is dry — it
 * returns no deposit address, so there is nothing for this component to pay
 * into even if it tried. The banner says so rather than letting a creator fill
 * in a form that cannot submit and discover why at the end.
 */

type ChainBalance = { blockchain: string; usdcBalance: string; read: boolean };
type BalanceData = { usdcBalance: string; chains?: ChainBalance[] };

type Destination = { chain: string; label: string; symbols: string[] };
type Unavailable = { chain: string; label: string; why: string };

type Quote = {
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  withdrawFee: string;
  refundFee: string;
  timeEstimate: number | null;
  executionFeeBps: number;
};

const CHAIN_LABEL: Record<string, string> = {
  BASE: "Base",
  ARB: "Arbitrum",
  OP: "Optimism",
  MONAD: "Monad",
  ARC: "Arc",
};
const chainLabel = (code: string) => CHAIN_LABEL[code] ?? code;

/** "~35s" reads as machine output; "about 35 seconds" is what a person asked. */
function eta(secs: number | null): string {
  if (secs === null) return "unknown";
  if (secs < 90) return `about ${Math.round(secs)} seconds`;
  return `about ${Math.round(secs / 60)} minutes`;
}

/**
 * What a creator is agreeing to, in the four places this path differs from
 * the withdrawal they already know.
 *
 * Each one is a thing that WILL happen, not a disclaimer: prices do move,
 * the arriving amount is smaller than the leaving one, a wrong address is
 * gone, and the delivery is someone else's network. A creator who learns any
 * of those afterwards has been misled by omission, however well the fee
 * breakdown above was laid out.
 *
 * Four, and no more. A fifth box is where people stop reading and start
 * clicking, which costs more than the fifth thing is worth saying.
 */
const POLICIES: Array<{ id: string; text: string }> = [
  {
    id: "price",
    text: "Prices are live and differ by destination chain. The quote can change before the transfer completes.",
  },
  {
    id: "amount",
    text: "I may receive slightly less than I send. The destination network's fee and the protocol's execution fee come out of the amount.",
  },
  {
    id: "final",
    text: "Payouts are final. If the destination address is wrong, the funds cannot be recovered.",
  },
  {
    id: "network",
    text: "Delivery is handled by NEAR Intents, not Sweep Console. Times are estimates, and a failed route refunds to my payout wallet on the original chain.",
  },
];

export function PayoutRoutesSection() {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [dests, setDests] = useState<Destination[]>([]);
  const [unavailable, setUnavailable] = useState<Unavailable[]>([]);
  const [partnerKey, setPartnerKey] = useState(true);
  const [listErr, setListErr] = useState("");

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [asset, setAsset] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [quotedAt, setQuotedAt] = useState<number | null>(null);

  /**
   * Ticked boxes, by id — and deliberately NOT remembered across quotes.
   *
   * A creator agrees that THIS price may move and THIS amount may arrive
   * short. Carrying the ticks over to a re-priced route would turn a
   * considered agreement into a formality they clicked past once, which is
   * the failure mode the boxes exist to prevent. They reset with the quote.
   */
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const allAgreed = POLICIES.every((p) => agreed[p.id]);
  /**
   * When this creator accepted the terms — null until they have, undefined
   * until we know.
   *
   * Held on the merchant, not in this browser: the agreement should survive a
   * new laptop and a cleared cache, and "they ticked it once" is a weaker
   * record than the date they did. undefined suppresses the boxes while the
   * answer is in flight, so they never flash up for someone who agreed months
   * ago.
   */
  const [acceptedAt, setAcceptedAt] = useState<string | null | undefined>(undefined);
  /** Opens the accepted terms for re-reading. Agreed is not forgotten. */
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/portal/wallet/circle/balance`, { credentials: "include" })
      .then((r) => r.json())
      .then((j: { data?: BalanceData }) => {
        if (!j.data) return;
        setBalance(j.data);
        /**
         * Default to the chain holding the most, because that is the one a
         * creator came here about. The existing withdrawal refuses to guess a
         * chain, but that is a form that MOVES money on submit — this one
         * only prices, so a sensible default costs nothing and a blank
         * dropdown costs a click on every visit.
         */
        const funded = (j.data.chains ?? [])
          .filter((c) => c.read && parseFloat(c.usdcBalance) > 0)
          .sort((a, b) => parseFloat(b.usdcBalance) - parseFloat(a.usdcBalance));
        if (funded[0]) setFrom(funded[0].blockchain);
      })
      .catch(() => {
        /* The panel still works without a balance; the amount is just typed. */
      });
  }, []);

  useEffect(() => {
    const q = from ? `?from=${encodeURIComponent(from)}` : "";
    fetch(`${API_URL}/portal/payouts/destinations${q}`, { credentials: "include" })
      .then((r) => r.json())
      .then(
        (j: {
          data?: {
            destinations?: Destination[];
            unavailable?: Unavailable[];
            partner_key?: boolean;
            terms_accepted_at?: string | null;
          };
          error?: { message?: string };
        }) => {
          if (j.error) {
            setListErr(j.error.message ?? "We couldn't list payout destinations.");
            return;
          }
          setListErr("");
          setDests(j.data?.destinations ?? []);
          setUnavailable(j.data?.unavailable ?? []);
          setPartnerKey(j.data?.partner_key !== false);
          setAcceptedAt(j.data?.terms_accepted_at ?? null);
        },
      )
      .catch(() => setListErr("We couldn't reach the payout network just now."));
  }, [from]);

  /** Assets the chosen destination actually lists, so the pair always exists. */
  const assetsHere = useMemo(() => {
    const d = dests.find((x) => x.chain === to);
    return d?.symbols ?? ["USDC", "USDT"];
  }, [dests, to]);

  useEffect(() => {
    if (to && !assetsHere.includes(asset)) setAsset(assetsHere[0] ?? "USDC");
  }, [to, assetsHere, asset]);

  const ready = Boolean(from && to && asset && amount && parseFloat(amount) > 0 && recipient.trim().length > 1);

  const runQuote = useCallback(async () => {
    if (!ready) return;
    setQuoting(true);
    setQuoteErr("");
    try {
      const res = await fetch(`${API_URL}/portal/payouts/quote`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, asset, amount, recipient: recipient.trim() }),
      });
      const j = (await res.json()) as {
        data?: { quote?: Quote };
        error?: { message?: string; details?: Record<string, string> };
      };
      if (!res.ok || !j.data?.quote) {
        setQuote(null);
        setQuoteErr(
          j.error?.message ??
            Object.values(j.error?.details ?? {})[0] ??
            "We couldn't price that payout.",
        );
        return;
      }
      setQuote(j.data.quote);
      setQuotedAt(Date.now());
    } catch {
      setQuote(null);
      setQuoteErr("We couldn't reach the payout network just now.");
    } finally {
      setQuoting(false);
    }
  }, [ready, from, to, asset, amount, recipient]);

  /**
   * Re-price on edit, once, after a pause.
   *
   * A quote is a live price and goes stale while a creator reads it, so an
   * explicit "Get quote" button would hand them a number and then let it rot
   * silently. Debounced instead: every edit invalidates the old number
   * immediately — the breakdown disappears rather than sitting there wrong —
   * and the new one arrives when typing stops.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!ready) {
      setQuote(null);
      if (!acceptedAt) setAgreed({});
      return;
    }
    setQuote(null);
    // Ticks reset with the price only while the agreement is still being
    // asked for. Once it is recorded there is nothing to re-ask, and clearing
    // them would put the boxes back in front of someone who is done with them.
    if (!acceptedAt) setAgreed({});
    timer.current = setTimeout(() => void runQuote(), 600);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ready, runQuote, acceptedAt]);

  /**
   * The fourth tick IS the acceptance; there is no separate "I agree" button.
   *
   * Recorded the moment it happens rather than on submit, because submit does
   * not exist yet and a creator who ticked all four has already done the
   * thing we are asking them to do. Optimistic: the boxes collapse
   * immediately, and a failed write leaves them shown rather than claiming an
   * agreement the server never stored.
   */
  useEffect(() => {
    if (!allAgreed || acceptedAt !== null) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/portal/payouts/accept-terms`, {
          method: "POST",
          credentials: "include",
        });
        const j = (await res.json()) as { data?: { accepted_at?: string } };
        if (live && res.ok && j.data?.accepted_at) setAcceptedAt(j.data.accepted_at);
      } catch {
        /* Left unaccepted, so the boxes stay and it can be tried again. */
      }
    })();
    return () => {
      live = false;
    };
  }, [allAgreed, acceptedAt]);

  const funded = (balance?.chains ?? []).filter((c) => c.read);
  const srcLabel = from ? chainLabel(from) : "";
  const dstLabel = dests.find((d) => d.chain === to)?.label ?? to;

  /** The route's own cost, as a percentage — what the table in the CLI shows. */
  const routeCostPct = useMemo(() => {
    if (!quote) return null;
    const inn = parseFloat(quote.amountIn);
    const out = parseFloat(quote.amountOut);
    if (!Number.isFinite(inn) || !Number.isFinite(out) || inn <= 0) return null;
    return ((inn - out) / inn) * 100;
  }, [quote]);

  return (
    <Section title="Withdraw to another chain">
      <p className="m-0 mb-1" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
        Price a payout to a chain Sweep doesn't settle on — Solana, Polygon, Tron and{" "}
        {Math.max(dests.length - 3, 0)} more — paid in USDC or USDT.
      </p>

      {/* Said before the form, not after it. A creator who fills five fields
          and then learns nothing can be sent has been wasted, and the panel
          looks broken rather than early. */}
      <p className="tag tag-outline mb-4" style={{ padding: "8px 12px", marginTop: 12 }}>
        Quotes only for now — nothing moves. These are live prices from the payout network.
      </p>

      {/* A deployment that lost the key quotes 24bp light and would look
          cheaper than it is. On screen, because that is where the number gets
          believed. */}
      {!partnerKey && (
        <p className="m-0 mb-4" style={{ fontSize: 12.5, color: "var(--color-accent-700)" }}>
          No partner key is configured, so execution would cost 25bp instead of 1bp. The prices
          below don't include it either way.
        </p>
      )}

      {listErr && (
        <p className="m-0 mb-4" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{listErr}</p>
      )}

      <div className="max-w-lg space-y-3">
        {funded.length > 0 && (
          <div className="field">
            <label htmlFor="pr-from">From</label>
            <select id="pr-from" className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">Select a chain…</option>
              {funded.map((c) => (
                <option key={c.blockchain} value={c.blockchain} disabled={parseFloat(c.usdcBalance) <= 0}>
                  {chainLabel(c.blockchain)} — {parseFloat(c.usdcBalance).toFixed(2)} USDC
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex gap-3">
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="pr-to">To</label>
            <select id="pr-to" className="input" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Select a destination…</option>
              {dests.map((d) => (
                <option key={d.chain} value={d.chain}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="pr-asset">Paid in</label>
            <select id="pr-asset" className="input" value={asset} onChange={(e) => setAsset(e.target.value)}>
              {assetsHere.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="pr-amount">Amount (USDC)</label>
          <input
            id="pr-amount"
            className="input"
            inputMode="decimal"
            placeholder="100.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="pr-recipient">
            {to ? `Your ${dstLabel} address` : "Destination address"}
          </label>
          <input
            id="pr-recipient"
            className="input"
            placeholder={to === "sol" ? "Your Solana address" : to === "tron" ? "T…" : "0x…"}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            spellCheck={false}
          />
          <p className="m-0 mt-1" style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>
            Checked for shape before pricing — the network refuses a quote on a malformed address,
            which otherwise reads as "no route".
          </p>
        </div>
      </div>

      {/* ── the answer ───────────────────────────────────────────────────── */}

      <div
        className="mt-5"
        style={{ borderTop: "1px solid var(--color-divider)", paddingTop: 16 }}
      >
        {!ready ? (
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-600)" }}>
            Fill in the amount and a destination address to see a live price.
          </p>
        ) : quoting ? (
          <div className="h-8 w-48 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
        ) : quoteErr ? (
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{quoteErr}</p>
        ) : quote ? (
          <>
            <Kicker>They receive</Kicker>
            <p
              className="m-0"
              style={{
                fontFamily: "var(--font-heading)",
                fontWeight: 700,
                fontSize: 34,
                lineHeight: 1,
                letterSpacing: "-0.03em",
              }}
            >
              {parseFloat(quote.amountOut).toFixed(2)} <span style={{ fontSize: 15 }}>{asset}</span>
            </p>
            <p className="m-0 mt-2" style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
              on {dstLabel}, {eta(quote.timeEstimate)}
              {srcLabel && ` after it leaves ${srcLabel}`}.
            </p>

            <dl
              className="m-0 mt-4 grid gap-y-1.5"
              style={{ gridTemplateColumns: "auto 1fr", fontSize: 12.5, maxWidth: 440 }}
            >
              <dt style={{ color: "var(--color-neutral-700)" }}>Route cost</dt>
              <dd className="m-0 text-right">
                {routeCostPct === null
                  ? "—"
                  : `${(parseFloat(quote.amountIn) - parseFloat(quote.amountOut)).toFixed(4)} USDC (${routeCostPct.toFixed(3)}%)`}
              </dd>

              {/* Charged in the TOKEN, out of the amount — so a creator needs
                  no gas token on the destination chain at all. That is the
                  part people assume wrongly, so it is spelled out. */}
              <dt style={{ color: "var(--color-neutral-700)" }}>{dstLabel} network fee</dt>
              <dd className="m-0 text-right">
                {parseFloat(quote.withdrawFee).toFixed(4)} {asset} — no gas token needed
              </dd>

              <dt style={{ color: "var(--color-neutral-700)" }}>At execution</dt>
              <dd className="m-0 text-right">
                +{quote.executionFeeBps}bp ({(quote.executionFeeBps / 100).toFixed(2)}%), not in the
                figure above
              </dd>

              <dt style={{ color: "var(--color-neutral-700)" }}>Worst case</dt>
              <dd className="m-0 text-right">
                {parseFloat(quote.minAmountOut).toFixed(2)} {asset}
              </dd>
            </dl>

            {/* A fixed destination cost means the percentage falls as the
                amount rises, which is the single most useful thing a creator
                can know before choosing when to withdraw. */}
            {routeCostPct !== null && routeCostPct > 0.25 && (
              <p className="m-0 mt-3" style={{ fontSize: 12, color: "var(--color-neutral-700)", maxWidth: 440 }}>
                {dstLabel} charges a flat {parseFloat(quote.withdrawFee).toFixed(2)} {asset} to
                deliver, so this route gets proportionally cheaper the more you withdraw at once.
              </p>
            )}

            {quotedAt && (
              <p className="m-0 mt-3" style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                Priced {new Date(quotedAt).toLocaleTimeString()} · re-prices as you edit
              </p>
            )}

            {/* AFTER the price, not before it. Terms shown first are terms
                read before there is anything to judge them against; a
                creator can only agree that 99.97 may arrive short once they
                have seen the 99.97.

                And ONCE. The boxes are a first-use gate, not a per-withdrawal
                ritual — a checkbox that reappears every time stops being read
                by the third time it does, which defeats the only thing it was
                for. What replaces it is a line naming the date, so the
                agreement stays visible without being re-demanded. */}
            {acceptedAt === undefined ? null : acceptedAt === null ? (
              <>
                <fieldset
                  style={{
                    marginTop: 30,
                    border: "1px solid var(--color-divider)",
                    borderRadius: "var(--radius-md)",
                    padding: "14px 16px",
                    maxWidth: 520,
                  }}
                >
                  <legend
                    className="uppercase"
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      color: "var(--color-neutral-700)",
                      padding: "0 6px",
                    }}
                  >
                    Before your first cross-chain withdrawal
                  </legend>
                  {POLICIES.map((p) => (
                    <label
                      key={p.id}
                      htmlFor={`pr-ack-${p.id}`}
                      className="flex gap-2.5"
                      style={{ fontSize: 12.5, lineHeight: 1.45, marginTop: 8, cursor: "pointer" }}
                    >
                      <input
                        id={`pr-ack-${p.id}`}
                        type="checkbox"
                        checked={Boolean(agreed[p.id])}
                        onChange={(e) =>
                          setAgreed((prev) => ({ ...prev, [p.id]: e.target.checked }))
                        }
                        style={{ marginTop: 2, flex: "none", accentColor: "var(--color-accent)" }}
                      />
                      <span>{p.text}</span>
                    </label>
                  ))}
                  <p className="m-0 mt-3" style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                    You'll only be asked this once.
                  </p>
                </fieldset>

                <div className="mt-4 flex items-center gap-3">
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ padding: "8px 14px", fontSize: 12.5 }}
                    disabled
                    title="Cross-chain withdrawals aren't enabled yet"
                  >
                    Withdraw to {dstLabel}
                  </button>
                  <span style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                    Tick all four to continue ({POLICIES.filter((p) => agreed[p.id]).length} of{" "}
                    {POLICIES.length}).
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="mt-5 flex items-center gap-3">
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ padding: "8px 14px", fontSize: 12.5 }}
                    disabled
                    title="Cross-chain withdrawals aren't enabled yet"
                  >
                    Withdraw to {dstLabel}
                  </button>
                  <span style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                    Not enabled yet — this path quotes only for now.
                  </span>
                </div>

                {/* The agreement stays readable without being re-demanded.
                    A creator who wants to check what they agreed to can; one
                    who does not is not made to tick it again. */}
                <p className="m-0 mt-3" style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                  Payout terms accepted{" "}
                  {new Date(acceptedAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                  .{" "}
                  <button
                    type="button"
                    onClick={() => setReviewing((v) => !v)}
                    style={{
                      font: "inherit",
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "var(--color-accent)",
                      cursor: "pointer",
                      textDecoration: "underline",
                    }}
                  >
                    {reviewing ? "Hide" : "Review"}
                  </button>
                </p>
                {reviewing && (
                  <ul
                    className="m-0 mt-2"
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: "var(--color-neutral-700)",
                      maxWidth: 520,
                      paddingLeft: 18,
                    }}
                  >
                    {POLICIES.map((p) => (
                      <li key={p.id} style={{ marginTop: 4 }}>
                        {p.text}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        ) : null}
      </div>

      {unavailable.length > 0 && (
        <p
          className="m-0 mt-5"
          style={{
            fontSize: 11.5,
            color: "var(--color-neutral-600)",
            borderTop: "1px solid var(--color-divider)",
            paddingTop: 12,
          }}
        >
          Not available:{" "}
          {unavailable.map((u, i) => (
            <span key={u.chain}>
              {i > 0 && " · "}
              {u.label} ({u.why})
            </span>
          ))}
        </p>
      )}
    </Section>
  );
}

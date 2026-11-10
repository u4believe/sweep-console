// What a person is allowed to read when something breaks.
//
// The rule this file enforces: a message is shown on screen only if it is about
// something the reader can act on — their wallet declined, their balance is
// short, their code expired, a field is wrong. Everything else is ours: a failed
// query, an RPC that timed out, a library that threw. Those are real and they
// must be debuggable, so they go to the console here and to the Railway logs on
// the server — but on screen they become one plain sentence, because a stack
// trace tells the reader nothing they can do and tells anyone probing the app
// exactly which of their attempts landed.
//
// Server errors carry a `reference` from the API (see lib/response.ts). It is
// the one technical detail worth showing: it is meaningless to an attacker and
// it turns "it broke" into a single log search.

const GENERIC = "Something went wrong. Please try again.";

/**
 * An error whose message has already been through `messageOfResponse`, so it is
 * known to be safe to render: either our API's own 4xx explanation, or the
 * generic line plus a reference for a 5xx.
 *
 * The tag is the point. Without it `friendlyError` cannot tell "That code has
 * expired." — which the reader needs — from a viem stack trace that happens to
 * arrive at the same catch, and it has to either show both or hide both.
 */
export class ApiError extends Error {
  readonly reference?: string;
  constructor(message: string, reference?: string) {
    super(message);
    this.name = "ApiError";
    this.reference = reference;
  }
}

/// Reads a failed response and throws it as an ApiError. The shape every portal
/// and checkout call site had written by hand, in one place.
export async function throwApiError(res: Response, fallback = GENERIC): Promise<never> {
  throw new ApiError(await messageOfResponse(res, fallback));
}

/// Conditions the reader owns. Matched on the message text because they arrive
/// from wallets and RPC providers, which have no error codes in common.
const USER_FACING: { test: RegExp; say: string }[] = [
  {
    test: /user storage|gator_7715/i,
    say: "MetaMask couldn't reach its permission storage. Turn on Settings → Backup and sync in MetaMask, make sure you're signed in and online, then try again.",
  },
  { test: /\brejected\b|\bdenied\b|cancell?ed by|user cancell?ed/i, say: "You cancelled the request." },
  {
    test: /does not support|not supported|unsupported (chain|method)/i,
    say: "This wallet can't do that. MetaMask supports it today.",
  },
  {
    test: /insufficient (funds|balance)|exceeds balance/i,
    say: "That wallet doesn't hold enough USDC for this payment.",
  },
  {
    test: /chain mismatch|wrong network|switch chain/i,
    say: "Your wallet is on the wrong network. Approve the switch and try again.",
  },
  {
    test: /network error|failed to fetch|load failed|networkerror/i,
    say: "We couldn't reach the server. Check your connection and try again.",
  },
  {
    /**
     * The account is 7702-delegated to an implementation MetaMask refuses.
     *
     * Observed on Base, where a subscriber's account pointed at
     * 0x7702cb554e6bFb442cb743A7dF23154544a7176C while the same account
     * pointed at MetaMask's own 0x63c0c19a282a1b52b07dd5a65b58948a07dae32b on
     * Arbitrum, Optimism and Monad.
     *
     * That address is Coinbase's EIP-7702 proxy (base/eip-7702-proxy), which
     * turns an EOA into a Coinbase Smart Wallet. Coinbase sponsors the
     * delegation on Base, so it costs nothing and can happen without the
     * holder registering that it did — and afterwards MetaMask will not act on
     * an implementation it does not recognise. One chain out of four, which is
     * why this looked chain-specific and random.
     *
     * It arrives as -32603 from wallet_sendCalls during the upgrade step, not
     * from the permission request, so it is a property of the SUBSCRIBER'S
     * ACCOUNT ON THAT CHAIN and not of anything we send. Listed before the
     * 4100 rule because "internal error" would otherwise fall through to the
     * generic line and say nothing anyone can act on.
     */
    test: /upgraded to unsupported contract|unsupported (delegation|implementation)/i,
    say:
      "This account was upgraded to a different kind of smart account on this network — by " +
      "Coinbase Wallet or a similar app — and MetaMask can't use it. Switch this account back " +
      "to a standard account in the app that upgraded it, or pay from a different account.",
  },
  {
    /**
     * EIP-1193 4100, which MetaMask returns for a METHOD it does not offer as
     * readily as for an account it has not been granted.
     *
     * On the grant path it means the wallet cannot service
     * wallet_requestExecutionPermissions — the ERC-7715 advanced-permissions
     * feature — and it arrives identically on every chain, which is how it is
     * told apart from a per-chain problem. The raw text names viem and a
     * method, which tells a subscriber nothing they can act on, and the
     * capability probe cannot be trusted to have caught it first:
     * getSupportedDelegationChainIds is documented as inconclusive on MetaMask
     * builds that refuse the probe and then service the request anyway, so the
     * UI deliberately offers every chain and lets the attempt judge.
     */
    test: /has not been authorized by the user|\b4100\b|method not (supported|found)|unsupported method/i,
    say:
      "Your wallet can't authorize recurring permissions. This needs MetaMask v13.23.0 or " +
      "newer — check Settings → About in MetaMask and update if it is older. If it is current, " +
      "switch this account to a smart account from the MetaMask account menu and try again.",
  },
];

/**
 * Turn anything thrown — an Error, a string, a rejected fetch — into a sentence
 * that is safe to render. The original always reaches the browser console.
 *
 * `fallback` replaces the generic line when the caller knows what the person was
 * trying to do ("We couldn't cancel that subscription."). It must stay free of
 * technical detail: it is shown for the unrecognized case, which is precisely
 * the case where we do not know what went wrong.
 */
export function friendlyError(e: unknown, fallback = GENERIC): string {
  // Already sanitized upstream, and usually the most useful thing we can say.
  if (e instanceof ApiError) return e.message;

  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (raw) console.error("[sweep]", e);

  for (const { test, say } of USER_FACING) {
    if (test.test(raw)) return say;
  }
  return fallback;
}

/**
 * The same decision for an API response, which unlike a thrown error tells us
 * whether its message was written for the reader.
 *
 * A 4xx is our own code refusing something specific — a used code, an amount
 * over a cap, a revoked mandate — and its message is already the explanation.
 * A 5xx is an unhandled failure, so its message is never shown; only the
 * reference is, appended to whatever the caller says happened.
 */
export async function messageOfResponse(res: Response, fallback = GENERIC): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: string; details?: Record<string, string>; reference?: string } }
    | null;
  const error = body?.error;

  if (res.status >= 500) {
    console.error("[sweep] server error", res.status, error);
    return error?.reference ? `${fallback} If it keeps happening, quote reference ${error.reference}.` : fallback;
  }

  if (!error) return fallback;

  // A 422 puts the constant "Validation failed" in `message` and the part worth
  // reading in `details`. Showing only the message is how a missing reason on a
  // form became an error nobody could act on.
  const detail = error.details && Object.values(error.details).filter(Boolean);
  if (detail && detail.length > 0) return detail.join(" ");
  return error.message ?? fallback;
}

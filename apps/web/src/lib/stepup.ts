// Client half of step-up authentication.
//
// The server does not tell the portal in advance which buttons are guarded —
// it answers the request itself with 401 `step_up_required` and names the
// methods that merchant may use. So the flow is: attempt, get challenged,
// confirm, retry with the token. `apiFetch` does all four, which means a
// guarded call site is written exactly like an unguarded one.

import { ApiError, messageOfResponse, throwApiError } from "@/lib/errors";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export type StepUpMethod = "email" | "totp" | "recovery";

/// The 401 body, as the server sends it.
export interface StepUpNeed {
  message: string;
  code: "step_up_required";
  action: string;
  action_label: string;
  methods: StepUpMethod[];
  required: "totp" | "any";
  /// The action accepts only an authenticator, and this account has none set up.
  /// `methods` is empty; send them to enrol rather than showing a code field.
  enrolment_required?: boolean;
  /// Why enrolment is being asked for, so the dialog can explain itself
  /// truthfully. "enrolment" means the account simply must have a second
  /// factor; absent means the stricter case — the action hands over a
  /// credential or moves money, and an emailed code is refused for it.
  reason?: "enrolment";
}

/// Resolves with a step-up token, or null if the merchant closed the dialog.
type Requester = (need: StepUpNeed) => Promise<string | null>;

let requester: Requester | null = null;

/// StepUpDialog calls this on mount. One dialog is mounted in PortalLayout, so
/// there is never more than one registered.
export function registerStepUpRequester(fn: Requester): () => void {
  requester = fn;
  return () => {
    if (requester === fn) requester = null;
  };
}

function isStepUpNeed(body: unknown): body is StepUpNeed {
  return typeof body === "object" && body !== null && (body as { code?: string }).code === "step_up_required";
}

/// Same contract as fetch, plus: a 401 asking for step-up is handled here and
/// the request is replayed once with the proof. Credentials are always
/// included — every portal route is cookie-authenticated.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_URL}${path}`;
  const first = await fetch(url, { credentials: "include", ...init });
  if (first.status !== 401) return first;

  // Read from a clone: the caller still owns the original body if we hand it back.
  const body = await first.clone().json().catch(() => null);
  const need = (body as { error?: unknown } | null)?.error;
  if (!isStepUpNeed(need) || !requester) return first;

  const token = await requester(need);
  if (!token) {
    // Cancelled. Answer in the caller's own language rather than replaying the
    // server's "confirm it's you", which would read as a failure.
    return new Response(
      JSON.stringify({ error: { message: "Cancelled — nothing was changed.", code: "step_up_cancelled" } }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const headers = new Headers(init.headers);
  headers.set("x-step-up-token", token);
  return fetch(url, { credentials: "include", ...init, headers });
}

/// True when a failed response was the merchant closing the dialog, so callers
/// can stay silent instead of showing an error for something nobody did.
export async function wasCancelled(res: Response): Promise<boolean> {
  if (res.ok) return false;
  const body = await res.clone().json().catch(() => null);
  return (body as { error?: { code?: string } } | null)?.error?.code === "step_up_cancelled";
}

// ─── Security endpoints, used by the dialog and the Settings panel ────────────

/// Returns when the emailed code dies, so the dialog can count it down rather
/// than let someone type into a field that already can't accept anything.
export async function startEmailChallenge(action: string): Promise<Date> {
  const res = await fetch(`${API_URL}/portal/security/step-up/start`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) await throwApiError(res, "Could not send the code.");
  const json = (await res.json()) as { expires_at?: string };
  return json.expires_at ? new Date(json.expires_at) : new Date(Date.now() + 120_000);
}

export async function verifyStepUp(action: string, method: StepUpMethod, code: string): Promise<string> {
  const res = await fetch(`${API_URL}/portal/security/step-up/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, method, code }),
  });
  /**
   * ApiError, not Error — which is the whole reason this refusal was unreadable.
   *
   * friendlyError only trusts an ApiError; a plain Error falls through to the
   * caller's fallback. So every distinct reason the server gives —
   * "Incorrect code.", "That code was already used. Wait for your app's next
   * code.", "Too many incorrect codes. Try again in a few minutes.", "No
   * authenticator is set up on this account." — arrived at StepUpDialog and
   * was flattened to the same four words: "That code didn't work."
   *
   * A merchant was told their code was wrong when it had been used, or when
   * they were throttled, or when the account had no authenticator at all.
   * Three different problems, one message, none of them actionable.
   *
   * throwApiError also keeps the 4xx/5xx distinction: a 4xx message is the
   * server explaining itself and is shown; a 5xx is an unhandled failure and
   * only its reference is.
   */
  if (!res.ok) await throwApiError(res, "That code didn't work.");
  const json = (await res.json().catch(() => ({}))) as { token?: string };
  if (!json.token) throw new ApiError("That code didn't work.");
  return json.token;
}

// Kept as the name the portal already imports; the decision lives in one place.
// A 5xx message is never shown on screen — see lib/errors.ts for why.
export const messageOf = messageOfResponse;

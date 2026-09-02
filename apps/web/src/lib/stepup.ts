// Client half of step-up authentication.
//
// The server does not tell the portal in advance which buttons are guarded —
// it answers the request itself with 401 `step_up_required` and names the
// methods that merchant may use. So the flow is: attempt, get challenged,
// confirm, retry with the token. `apiFetch` does all four, which means a
// guarded call site is written exactly like an unguarded one.

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
  if (!res.ok) throw new Error(await messageOf(res, "Could not send the code."));
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
  const json = (await res.json().catch(() => ({}))) as { token?: string; error?: { message?: string } };
  if (!res.ok || !json.token) throw new Error(json.error?.message ?? "That code didn't work.");
  return json.token;
}

export async function messageOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

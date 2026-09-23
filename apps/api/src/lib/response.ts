import { randomBytes } from "crypto";
import type { Response } from "express";

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json(data);
}

export function created<T>(res: Response, data: T) {
  return res.status(201).json(data);
}

export function err(res: Response, message: string, status: number, code?: string) {
  return res.status(status).json({
    error: { message, code: code ?? httpCodeToSlug(status) },
  });
}

export function validationError(res: Response, details: Record<string, string>) {
  return res.status(422).json({
    error: { message: "Validation failed", code: "validation_error", details },
  });
}

function httpCodeToSlug(status: number): string {
  const map: Record<number, string> = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
    500: "internal_error",
  };
  return map[status] ?? "error";
}

/**
 * The only way a 5xx should leave this API.
 *
 * Two audiences, two different messages. The logs get everything — the scope,
 * the stack, the original exception — because an error nobody can read is an
 * error nobody can fix. The caller gets a sentence with no stack trace, no
 * table name, no RPC URL and no library text in it: a subscriber who could not
 * pay is owed an explanation, not our internals, and the internals are exactly
 * what tells an attacker which probe landed.
 *
 * The reference is what joins the two. It is printed in the log line and shown
 * to the user, so "it said reference 4f2a9c" is enough to find the exact
 * failure in Railway without asking them to reproduce anything.
 *
 * `scope` names the call site the way the existing console.error tags do
 * ("portal/tier", "charges POST"), so log search keeps working.
 */
export function serverError(
  res: Response,
  scope: string,
  e: unknown,
  userMessage = "Something went wrong on our end. Please try again in a moment."
) {
  const reference = randomBytes(3).toString("hex");
  console.error(`[${scope}] ref=${reference}`, e);
  return res.status(500).json({
    error: {
      message: `${userMessage} If it keeps happening, quote reference ${reference}.`,
      code: "internal_error",
      reference,
    },
  });
}

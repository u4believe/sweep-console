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

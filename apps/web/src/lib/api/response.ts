import { NextResponse } from "next/server";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function created<T>(data: T) {
  return NextResponse.json(data, { status: 201 });
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

export function err(message: string, status: number, code?: string) {
  return NextResponse.json(
    { error: { message, code: code ?? httpCodeToSlug(status) } },
    { status }
  );
}

export function validationError(details: Record<string, string>) {
  return NextResponse.json(
    { error: { message: "Validation failed", code: "validation_error", details } },
    { status: 422 }
  );
}

export function notFound(resource = "Resource") {
  return err(`${resource} not found`, 404, "not_found");
}

export function unauthorized(message = "Invalid API key") {
  return err(message, 401, "unauthorized");
}

export function forbidden(message = "Access denied") {
  return err(message, 403, "forbidden");
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

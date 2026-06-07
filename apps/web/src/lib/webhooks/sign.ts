import { createHmac, timingSafeEqual } from "crypto";

/**
 * Signs a webhook payload with HMAC-SHA256.
 * Returns the signature as "sha256=<hex>".
 * Developers verify this header before processing the event.
 */
export function signWebhook(payload: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${sig}`;
}

/**
 * Verifies an incoming webhook signature.
 * Timing-safe comparison prevents timing attacks.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = signWebhook(payload, secret);
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

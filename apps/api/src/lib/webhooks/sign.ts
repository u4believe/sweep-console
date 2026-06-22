import { createHmac } from "crypto";

export function signWebhook(payload: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${sig}`;
}

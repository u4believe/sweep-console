import { Sweep, WebhookSignatureError } from "../dist/index.js";
import { createHmac } from "node:crypto";

const r = [];
const ok = (n, p, x = "") => r.push(`${p ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`);
const threw = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };

// ── 1. the key must never go over plaintext ──
ok("rejects an http baseUrl", /must be https/.test(threw(() => new Sweep("sk_test_x", { baseUrl: "http://api.example.com" }))),
  threw(() => new Sweep("sk_test_x", { baseUrl: "http://api.example.com" })).slice(0, 60));
ok("  names the host in the refusal", /api\.example\.com/.test(threw(() => new Sweep("sk_test_x", { baseUrl: "http://api.example.com" }))));
ok("allows http on localhost", threw(() => new Sweep("sk_test_x", { baseUrl: "http://localhost:4000" })) === "");
ok("allows http on 127.0.0.1", threw(() => new Sweep("sk_test_x", { baseUrl: "http://127.0.0.1:4000" })) === "");
ok("allows https anywhere", threw(() => new Sweep("sk_test_x", { baseUrl: "https://api.example.com" })) === "");
ok("rejects a non-URL baseUrl", /is not a URL/.test(threw(() => new Sweep("sk_test_x", { baseUrl: "not a url" }))));
ok("default baseUrl is https", threw(() => new Sweep("sk_test_x")) === "");

// ── 2. webhook verification ──
const secret = "whsec_test";
const sweep = new Sweep("sk_test_x");
const body = JSON.stringify({
  event_id: "evt_1", event_type: "mandate.revoked", created_at: new Date().toISOString(),
  merchant_id: "m_1", external_ref: "user_42", data: { revoked_by: "payer" },
});
const sig = "sha256=" + createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");

ok("accepts a correct signature", (() => { try { sweep.webhooks.construct(body, sig, secret); return true; } catch { return false; } })());
ok("rejects a tampered body", (() => {
  const t = body.replace('"payer"', '"merchant"');
  try { sweep.webhooks.construct(t, sig, secret); return false; } catch (e) { return e instanceof WebhookSignatureError; }
})());
ok("rejects a missing header", (() => { try { sweep.webhooks.construct(body, undefined, secret); return false; } catch (e) { return /No X-Sweep-Signature/.test(e.message); } })());
ok("rejects a wrong secret", (() => { try { sweep.webhooks.construct(body, sig, "whsec_other"); return false; } catch { return true; } })());
ok("rejects bare hex (no sha256= prefix)", (() => {
  const bare = sig.slice("sha256=".length);
  try { sweep.webhooks.construct(body, bare, secret); return false; } catch { return true; }
})());
ok("a length mismatch does not crash timingSafeEqual", (() => {
  try { sweep.webhooks.construct(body, "sha256=abc", secret); return false; } catch (e) { return e instanceof WebhookSignatureError; }
})());

// ── 3. the opt-in age check ──
const oldBody = JSON.stringify({
  event_id: "evt_2", event_type: "mandate.revoked", created_at: new Date(Date.now() - 3600_000).toISOString(),
  merchant_id: "m_1", external_ref: "user_42", data: {},
});
const oldSig = "sha256=" + createHmac("sha256", secret).update(Buffer.from(oldBody)).digest("hex");
ok("an hour-old event passes with no tolerance set (retries work)",
  (() => { try { sweep.webhooks.construct(oldBody, oldSig, secret); return true; } catch { return false; } })());
ok("and is rejected when a tolerance is asked for",
  (() => { try { sweep.webhooks.construct(oldBody, oldSig, secret, { toleranceSeconds: 300 }); return false; } catch (e) { return /outside the 300s tolerance/.test(e.message); } })());
ok("eventId is exposed for dedupe", sweep.webhooks.construct(body, sig, secret).eventId === "evt_1");

// ── 4. no secret leaks into an error message ──
const key = "sk_test_SUPERSECRET123";
const s2 = new Sweep(key);
const msg = threw(() => s2.webhooks.construct("{}", "sha256=00", "whsec"));
ok("no API key in a verification error", !msg.includes("SUPERSECRET"), msg.slice(0, 50));
ok("no signing secret in a verification error", !msg.includes("whsec"), msg.slice(0, 50));

console.log(r.join("\n"));
const f = r.filter((l) => l.startsWith("FAIL")).length;
console.log(`\n${r.length - f}/${r.length} passed`);
process.exit(f ? 1 : 0);

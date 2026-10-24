/**
 * Exercises dist/sweep.js (the CDN build) against a minimal DOM stub.
 * No jsdom in this repo, so the stub covers only what the button touches —
 * which is also a useful check in itself: anything it reaches for that is not
 * here will throw.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = [];
const ok = (name, pass, extra = "") =>
  out.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);

function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    className: "",
    innerHTML: "",
    children: [],
    attrs: {},
    listeners: {},
    classList: {
      add(...c) {
        const have = el.className ? el.className.split(" ") : [];
        for (const x of c) if (!have.includes(x)) have.push(x);
        el.className = have.join(" ");
      },
    },
    get textContent() {
      return el._text ?? "";
    },
    set textContent(v) {
      el._text = v;
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    getAttribute(k) {
      return el.attrs[k] ?? null;
    },
    removeAttribute(k) {
      delete el.attrs[k];
    },
    appendChild(c) {
      el.children.push(c);
      c._parent = el;
      return c;
    },
    remove() {
      el.removed = true;
      // Actually detach. Without this a "closed" panel is still findable in
      // its parent's children, and a test for closing passes or fails on the
      // stub rather than on the code.
      const p = el._parent;
      if (p) p.children = p.children.filter((c) => c !== el);
      el._parent = null;
    },
    addEventListener(t, fn) {
      (el.listeners[t] ||= []).push(fn);
    },
    removeEventListener(t, fn) {
      el.listeners[t] = (el.listeners[t] || []).filter((f) => f !== fn);
    },
    querySelector(sel) {
      // the only query the button makes on itself
      if (sel === ".sweep-pay__label") return (el._label ||= makeEl("span"));
      return null;
    },
    click() {
      for (const fn of el.listeners.click || []) fn({ preventDefault() {} });
    },
  };
  return el;
}

const head = makeEl("head");
const registry = {};
globalThis.document = {
  head,
  createElement: makeEl,
  getElementById: (id) => head.children.find((c) => c.id === id) ?? registry["#" + id] ?? null,
  querySelector: (sel) => registry[sel] ?? null,
};
const assigned = [];
globalThis.window = { location: { assign: (u) => assigned.push(u) } };

// load the CDN build exactly as a browser would
const here = dirname(fileURLToPath(import.meta.url));
const src = await readFile(join(here, "../dist/sweep.js"), "utf8");
new Function(src)();
const Sweep = globalThis.Sweep;

ok("CDN build defines window.Sweep.mount", typeof Sweep?.mount === "function");
ok("no stylesheet before the first mount", head.children.length === 0);

// ── a plain container gets a real <button>, not a div ──
const host = makeEl("div");
registry["#pay"] = host;
registry["#pay"].id = "pay";
let errs = [];
const h = Sweep.mount("#pay", { session: "/api/sweep/session", onError: (e) => errs.push(e) });
ok("creates a BUTTON", h.element.tagName === "BUTTON", h.element.tagName);
ok('sets type="button"', h.element.getAttribute("type") === "button");
ok("has the sweep-pay class", h.element.className.includes("sweep-pay"));
ok("default label", h.element._label.textContent === "Subscribe with USDC", h.element._label.textContent);

// ── happy path: endpoint returns { url } ──
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ url: "/authorize/mdt_x" }) });
h.element.click();
await new Promise((r) => setTimeout(r, 5));
ok("redirects to the URL", assigned[0] === "/authorize/mdt_x", String(assigned[0]));
ok("stays busy while navigating away", h.element.getAttribute("aria-busy") === "true");

// ── nested under data, as a forwarding endpoint would answer ──
assigned.length = 0;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { checkout_url: "/checkout/cs_1" } }) });
const hData = Sweep.mount(makeEl("div"), { session: "/s" });
hData.element.click();
await new Promise((r) => setTimeout(r, 5));
ok("accepts data.checkout_url", assigned[0] === "/checkout/cs_1", String(assigned[0]));

// ── a refusal: message surfaces, button returns to rest ──
assigned.length = 0;
errs = [];
globalThis.fetch = async () => ({
  ok: false,
  status: 409,
  json: async () => ({ error: { message: "user_42 already has an active mandate (mdt_8f45…)." } }),
});
const hErr = Sweep.mount(makeEl("div"), { session: "/s", onError: (e) => errs.push(e) });
hErr.element.click();
await new Promise((r) => setTimeout(r, 5));
ok("no redirect on failure", assigned.length === 0);
ok("surfaces the API message", errs[0]?.message.startsWith("user_42 already has"), errs[0]?.message);
ok("label restored", hErr.element._label.textContent === "Subscribe with USDC");
ok("usable again", hErr.element.getAttribute("aria-busy") === null);

// ── double click while in flight must fire once ──
assigned.length = 0;
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  await new Promise((r) => setTimeout(r, 20));
  return { ok: true, status: 200, json: async () => ({ url: "/authorize/once" }) };
};
const hRace = Sweep.mount(makeEl("div"), { session: "/s" });
hRace.element.click();
hRace.element.click();
hRace.element.click();
await new Promise((r) => setTimeout(r, 40));
ok("in-flight clicks ignored", calls === 1, `${calls} request(s)`);
ok("redirected once", assigned.length === 1, `${assigned.length}`);

// ── an endpoint that answers without a URL is a clear error, not a silent stall ──
errs.length = 0;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
const hNoUrl = Sweep.mount(makeEl("div"), { session: "/s", onError: (e) => errs.push(e) });
hNoUrl.element.click();
await new Promise((r) => setTimeout(r, 5));
ok("missing URL is reported", /answered without a URL/.test(errs[0]?.message ?? ""), errs[0]?.message);

// ── enhancing an existing <button> keeps its own label ──
const theirs = makeEl("button");
theirs.textContent = "Pay monthly in USDC";
registry["#theirs"] = theirs;
const h2 = Sweep.mount("#theirs", { session: "/s", variant: "outline", size: "sm", block: true });
ok("reuses the element", h2.element === theirs);
ok("keeps the merchant's label", theirs._label.textContent === "Pay monthly in USDC", theirs._label.textContent);
ok("applies variant + size + block",
  ["sweep-pay--outline", "sweep-pay--sm", "sweep-pay--block"].every((c) => theirs.className.includes(c)),
  theirs.className);

// ── onRedirect can take over ──
assigned.length = 0;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ url: "/mine" }) });
let seen = null;
const h3 = Sweep.mount(makeEl("div"), { session: "/s", onRedirect: (u) => { seen = u; return false; } });
h3.element.click();
await new Promise((r) => setTimeout(r, 5));
ok("onRedirect receives the URL", seen === "/mine");
ok("returning false cancels navigation", assigned.length === 0);
ok("and the button recovers", h3.element.getAttribute("aria-busy") === null);

// ── a session function skips fetching entirely ──
globalThis.fetch = async () => { throw new Error("must not be called"); };
assigned.length = 0;
const h4 = Sweep.mount(makeEl("div"), { session: () => "/from-function" });
h4.element.click();
await new Promise((r) => setTimeout(r, 5));
ok("session function is used as-is", assigned[0] === "/from-function", String(assigned[0]));

// ── a missing target says so ──
let threw = "";
try { Sweep.mount("#nope", { session: "/s" }); } catch (e) { threw = e.message; }
ok("missing target throws a clear error", /nothing matched/.test(threw), threw.slice(0, 60));

// ── a javascript: URL must never be navigated to ──
errs.length = 0;
assigned.length = 0;
for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:x"]) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ url: bad }) });
  const hx = Sweep.mount(makeEl("div"), { session: "/s", onError: (e) => errs.push(e) });
  hx.element.click();
  await new Promise((r) => setTimeout(r, 5));
}
ok("refuses javascript:/data:/vbscript:", assigned.length === 0 && errs.length === 3,
  `${assigned.length} navigation(s), ${errs.length} error(s)`);
ok("  and says why", /refusing to navigate/.test(errs[0]?.message ?? ""), errs[0]?.message);

// a relative path and a cross-origin https URL both stay allowed
assigned.length = 0;
for (const good of ["/authorize/mdt_ok", "https://checkout.example.com/x"]) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ url: good }) });
  const hg = Sweep.mount(makeEl("div"), { session: "/s" });
  hg.element.click();
  await new Promise((r) => setTimeout(r, 5));
}
ok("allows a path and an https host", assigned.length === 2, assigned.join(" "));

// ── destroy unwinds ──
h2.destroy();
theirs.click();
ok("destroy removes the handler", (theirs.listeners.click || []).length === 0);

ok("stylesheet injected once across every mount",
  head.children.length === 1 && head.children[0].id === "sweep-pay-styles",
  `${head.children.length} <style> element(s)`);

/* ══════════════════════════════════════════════════════════════════════
   The authorize modal.

   The stub grows here rather than up top, so what the button needs stays
   separable from what the panel needs — and anything the panel reaches for
   that is not stubbed still throws, which is the point of the stub.
   ══════════════════════════════════════════════════════════════════════ */

const body = makeEl("body");
body.style = {};
document.body = body;
const docListeners = {};
document.addEventListener = (t, fn) => ((docListeners[t] ||= []).push(fn));
document.removeEventListener = (t, fn) => (docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn));
document.activeElement = null;

const winListeners = {};
window.addEventListener = (t, fn) => ((winListeners[t] ||= []).push(fn));
window.removeEventListener = (t, fn) => (winListeners[t] = (winListeners[t] || []).filter((f) => f !== fn));
window.location.href = "https://merchant.example.com/billing";
globalThis.requestAnimationFrame = (fn) => fn();

const panelOf = () => body.children.find((c) => c.className === "sweep-modal");
const frameOf = () => panelOf()?.children[0]?.children.find((c) => c.tagName === "IFRAME");

// ── it opens over the page, and tells the frame it is embedded ──
assigned.length = 0;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ url: "https://pay.sweep.test/authorize/mdt_m" }) });
let authorized = null;
let cancelled = 0;
const ha = Sweep.authorize(makeEl("div"), {
  session: "/s",
  onAuthorized: (m) => (authorized = m),
  onCancelled: () => cancelled++,
});
ha.element.click();
await new Promise((r) => setTimeout(r, 5));

ok("opens a panel instead of navigating", assigned.length === 0 && !!panelOf(), `${assigned.length} navigation(s)`);
ok("marks the frame as embedded", (frameOf()?.src || "").includes("embed=1"), frameOf()?.src);
ok("no sandbox — the popup fallback needs the exit", frameOf()?.attrs.sandbox === undefined);
ok("locks the page behind it", body.style.overflow === "hidden", String(body.style.overflow));
ok("default label", ha.element._label.textContent === "Authorize payments", ha.element._label.textContent);

// ── only the frame's own origin may drive it ──
const fire = (data, origin, source) => {
  for (const fn of winListeners.message || []) fn({ data, origin, source });
};
const frameWin = {};
frameOf().contentWindow = frameWin;

fire({ source: "sweep", type: "authorized", mandate: { mandate_id: "forged" } }, "https://evil.example", frameWin);
ok("ignores another origin", authorized === null && !!panelOf());

fire({ source: "sweep", type: "authorized", mandate: { mandate_id: "forged2" } }, "https://pay.sweep.test", {});
ok("ignores another window on the right origin", authorized === null && !!panelOf());

// ── the real thing ──
fire({ source: "sweep", type: "authorized", mandate: { mandate_id: "mdt_m" } }, "https://pay.sweep.test", frameWin);
ok("accepts the frame itself", authorized?.mandate_id === "mdt_m", JSON.stringify(authorized));
ok("closes the panel", !panelOf());
ok("gives the page back", body.style.overflow !== "hidden", String(body.style.overflow));
ok("authorizing is not a cancellation", cancelled === 0, String(cancelled));

// ── Escape dismisses and reports it ──
const hb = Sweep.authorize(makeEl("div"), { session: "/s", onCancelled: () => cancelled++ });
hb.element.click();
await new Promise((r) => setTimeout(r, 5));
ok("reopens", !!panelOf());
for (const fn of docListeners.keydown || []) fn({ key: "Escape" });
ok("Escape closes it", !panelOf());
ok("and fires onCancelled once", cancelled === 1, String(cancelled));

// ── redirect mode is still the old behaviour ──
assigned.length = 0;
const hr = Sweep.authorize(makeEl("div"), { session: "/s", mode: "redirect" });
hr.element.click();
await new Promise((r) => setTimeout(r, 5));
ok("mode:redirect navigates", assigned[0] === "https://pay.sweep.test/authorize/mdt_m", String(assigned[0]));

console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`\n${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);

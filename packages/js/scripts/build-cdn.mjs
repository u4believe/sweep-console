/**
 * Produces the two files a <script> tag needs, from what tsc already emitted.
 *
 *   dist/sweep.js    the ESM module wrapped in an IIFE that defines window.Sweep
 *   dist/button.css  the stylesheet, lifted out of BUTTON_CSS
 *
 * There is no bundler in this repo, and adding one to wrap a single file would
 * be the larger cost. The wrap is only safe while src/index.ts stays one file
 * with no imports and no `export { … }` block, so both are checked here: a
 * violation fails the build instead of shipping a script that throws on load.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const esm = await readFile(join(root, "dist/index.js"), "utf8");

for (const [pattern, why] of [
  [/^\s*import[\s{*]/m, "an `import` — the IIFE has no module loader to resolve it"],
  [/^\s*export\s*\{/m, "an `export { … }` block — only `export function`/`const` can be stripped"],
  [/^\s*export\s+\*/m, "an `export *` — same reason"],
]) {
  if (pattern.test(esm)) {
    console.error(`[build-cdn] src/index.ts now has ${why}.`);
    console.error("[build-cdn] Keep it one self-contained file, or add a real bundler.");
    process.exit(1);
  }
}

// `export function f` → `function f`, `export const x` → `const x`. Type-only
// exports leave no trace in the emitted JS, so nothing else needs touching.
const body = esm.replace(/^export\s+(function|const|class|let|var)\b/gm, "$1");

const banner = `/* @sweepconsole/js — https://sweepconsole.com. MIT. */`;
const iife = `${banner}
(function (global) {
  "use strict";
${body
  .split("\n")
  .map((l) => (l ? "  " + l : l))
  .join("\n")}
  global.Sweep = Sweep;
})(typeof globalThis !== "undefined" ? globalThis : window);
`;

await writeFile(join(root, "dist/sweep.js"), iife, "utf8");

// The stylesheet, from the same constant the runtime injects, so the linked
// file and the injected one can never drift.
const match = esm.match(/const BUTTON_CSS = `([\s\S]*?)`;/);
if (!match) {
  console.error("[build-cdn] Could not find BUTTON_CSS in dist/index.js.");
  process.exit(1);
}
const css = match[1].replace(/\\`/g, "`").replace(/\\\$/g, "$");
await writeFile(
  join(root, "dist/button.css"),
  `/* @sweepconsole/js — the button, standalone. Generated from src/index.ts; edit it there. */\n${css}\n`,
  "utf8"
);

const kb = (s) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(1) + "KB";
console.log(`[build-cdn] dist/sweep.js ${kb(iife)} · dist/button.css ${kb(css)}`);

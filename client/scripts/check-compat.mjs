// Fails when the built bundle calls a browser API that something in our
// browserslist lacks and src/polyfills.ts doesn't supply.
//
// Our own source is linted by eslint-plugin-compat, but pdf.js and other
// dependencies are only visible here, in dist/. A watch-list of APIs that have
// bitten (or are likely to) is matched against the built JS, then checked
// against MDN's browser-compat-data for every browser in the floor.
//
//   npm run build && npm run check:compat
//
// `polyfilled` = supplied by src/polyfills.ts. `guarded` = the dependency
// feature-detects it itself (pdf.js's Float16Array, try-wrapped fromBase64), so
// it is safe without one. Neither is verified here; they only record why a
// hit is not a failure.
//
// To cover a new API: add a row to WATCHED. If it fails the check, either
// polyfill it in src/polyfills.ts and mark it `polyfilled`, or raise the floor.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import browserslist from "browserslist";

const require = createRequire(import.meta.url);
const bcd = require("@mdn/browser-compat-data");

const WATCHED = [
  { name: "Iterator.prototype", pattern: /\bIterator\.prototype\b/, bcd: "javascript.builtins.Iterator", polyfilled: true },
  { name: "URL.parse", pattern: /\bURL\.parse\(/, bcd: "api.URL.parse_static", polyfilled: true },
  { name: "Uint8Array#toHex", pattern: /\.toHex\(\)/, bcd: "javascript.builtins.Uint8Array.toHex", polyfilled: true },
  { name: "Map#getOrInsertComputed", pattern: /\.getOrInsertComputed\(/, bcd: "javascript.builtins.Map.getOrInsertComputed", polyfilled: true },
  { name: "Promise.withResolvers", pattern: /\bPromise\.withResolvers\(/, bcd: "javascript.builtins.Promise.withResolvers", polyfilled: true, polyfilled: true },
  { name: "Promise.try", pattern: /\bPromise\.try\(/, bcd: "javascript.builtins.Promise.try", polyfilled: true },
  { name: "Array#toSorted", pattern: /\.toSorted\(/, bcd: "javascript.builtins.Array.toSorted", polyfilled: true },
  { name: "Array#toReversed", pattern: /\.toReversed\(/, bcd: "javascript.builtins.Array.toReversed" },
  { name: "Array#findLast", pattern: /\.findLast(Index)?\(/, bcd: "javascript.builtins.Array.findLast" },
  { name: "Object.groupBy", pattern: /\bObject\.groupBy\(/, bcd: "javascript.builtins.Object.groupBy" },
  { name: "Set methods (union…)", pattern: /\.(union|intersection|difference|isSubsetOf)\(/, bcd: "javascript.builtins.Set.union", ambiguous: true },
  { name: "structuredClone", pattern: /\bstructuredClone\(/, bcd: "api.structuredClone" },
  { name: "AbortSignal.any", pattern: /\bAbortSignal\.any\(/, bcd: "api.AbortSignal.any_static", polyfilled: true },
  { name: "AbortSignal.timeout", pattern: /\bAbortSignal\.timeout\(/, bcd: "api.AbortSignal.timeout_static", polyfilled: true },
  { name: "ReadableStream async iteration", pattern: /Symbol\.asyncIterator\]\s*=?\s*[^;]{0,40}\bReadableStream/, bcd: "api.ReadableStream.@@asyncIterator", ambiguous: true },
  { name: "Array.fromAsync", pattern: /\bArray\.fromAsync\(/, bcd: "javascript.builtins.Array.fromAsync" },
  { name: "Float16Array", pattern: /\bFloat16Array\b/, bcd: "javascript.builtins.Float16Array", guarded: true },
  { name: "Uint8Array.fromBase64", pattern: /\bUint8Array\.fromBase64\(/, bcd: "javascript.builtins.Uint8Array.fromBase64", guarded: true },
  { name: "Math.sumPrecise", pattern: /\bMath\.sumPrecise\(/, bcd: "javascript.builtins.Math.sumPrecise", guarded: true },
  { name: "Error.isError", pattern: /\bError\.isError\(/, bcd: "javascript.builtins.Error.isError" },
];

// browserslist name -> bcd browser id
const BCD_BROWSER = {
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  safari: "safari",
  ios_saf: "safari_ios",
  and_chr: "chrome_android",
};

const parts = (v) => String(v).split(".").map(Number);
const lt = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
};

// Lowest version we promise to support, per browser.
const floor = {};
for (const q of browserslist()) {
  const [name, ver] = q.split(" ");
  const id = BCD_BROWSER[name];
  const low = ver.split("-")[0];
  if (id && (!floor[id] || lt(low, floor[id]))) floor[id] = low;
}

function addedIn(bcdPath, browser) {
  const entry = bcdPath.split(".").reduce((o, k) => o?.[k], bcd);
  if (!entry?.__compat) return undefined; // unknown to bcd: can't judge
  const s = entry.__compat.support[browser];
  const first = (Array.isArray(s) ? s : [s]).find((x) => x && !x.flags && !x.prefix && !x.alternative_name);
  if (!first) return Infinity.toString();
  const v = first.version_added;
  if (v === true) return "0";
  if (!v || v === false) return Infinity.toString();
  return String(v).replace(/^≤/, "");
}

const polyfillSource = fs.readFileSync(path.resolve("src/polyfills.ts"), "utf8");
const dist = path.resolve("dist");
if (!fs.existsSync(dist)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(2);
}
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
  );
const files = walk(dist).filter((f) => /\.m?js$/.test(f));

let failed = false;
const rows = [];
for (const w of WATCHED) {
  const hits = files.filter((f) => w.pattern.test(fs.readFileSync(f, "utf8")));
  if (!hits.length) continue;
  const missing = Object.entries(floor)
    .filter(([b]) => {
      const v = addedIn(w.bcd, b);
      return v !== undefined && (v === "Infinity" || lt(floor[b], v));
    })
    .map(([b, v]) => `${b} ${v}`);
  const where = hits.map((f) => path.relative(dist, f)).join(", ");
  if (!missing.length) rows.push(`ok       ${w.name}`);
  else if (w.guarded) rows.push(`guarded  ${w.name}  (dependency feature-detects)`);
  else if (w.polyfilled && !polyfillSource.includes(w.name.split(/[.#]/).pop())) {
    failed = true;
    rows.push(`FAIL     ${w.name} — marked polyfilled but src/polyfills.ts never mentions it`);
  } else if (w.polyfilled) rows.push(`polyfill ${w.name}  (below: ${missing.join(", ")})`);
  else if (w.ambiguous) rows.push(`warn     ${w.name} — pattern is loose, check by hand: ${where}`);
  else {
    failed = true;
    rows.push(`FAIL     ${w.name} — used in ${where}; unsupported in ${missing.join(", ")}`);
  }
}
console.log(`floor: ${Object.entries(floor).map(([b, v]) => `${b} ${v}`).join(", ")}`);
console.log(rows.join("\n") || "no watched APIs found in bundle");
if (failed) {
  console.error("\nPolyfill these in src/polyfills.ts (and set `polyfilled: true`), or raise the browserslist floor.");
  process.exit(1);
}

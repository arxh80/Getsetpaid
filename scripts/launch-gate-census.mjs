#!/usr/bin/env node
// Launch-gate census (Phase 10 Task 1). Prints what exists, mechanically, so
// docs/launch-gates.md can say "measured" rather than "believed". Not a test:
// it never exits non-zero for a gap; the gaps are graded in the document.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const rel = (p) => relative(root, p).split(sep).join("/");
const read = (p) => readFileSync(p, "utf8");

// 1. ROUTES: every page.tsx under app/, as its URL pattern, and whether a
//    spec that constructs AxeBuilder names it. A quoted path counts when it
//    matches the route with each dynamic segment filled by a template
//    expression (`${world.orgSlug}`) or a literal value ("exact"); a spec
//    that only names the route's static tail is reported "by tail". The
//    census cannot see which page a helper scans, so "none" is a candidate,
//    read by hand before it is graded.
const pages = walk(join(root, "app")).filter((p) => p.endsWith(`${sep}page.tsx`));
const toUrl = (p) =>
  "/" + rel(p).replace(/^app\//, "").replace(/\/page\.tsx$/, "").split("/")
    .filter((s) => !/^\(.*\)$/.test(s)).join("/");
const specs = walk(join(root, "tests", "e2e")).filter((p) => p.endsWith(".spec.ts"));
const axeSpecs = specs.filter((p) => read(p).includes("AxeBuilder"));
const axeText = axeSpecs.map(read).join("\n");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const routes = pages.map((p) => {
  const url = toUrl(p);
  const segs = url.split("/").filter(Boolean);
  const dyn = "(?:\\$\\{[^}]+\\}|[^/\"'`$]+)";
  const body = segs.map((s) => (/^\[.*\]$/.test(s) ? dyn : esc(s))).join("/");
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from esc()-escaped route segments
  const exactRe = new RegExp(`["'\`]/${body}(?:[?#][^"'\`]*)?["'\`]`);
  const statics = segs.filter((s) => !/^\[.*\]$/.test(s));
  const tail = statics.length ? "/" + statics.slice(-2).join("/") : "";
  const exact = segs.length === 0 ? /["'`]\/["'`]/.test(axeText) : exactRe.test(axeText);
  const byTail = !exact && tail.length > 1 && axeText.includes(tail);
  return { url, file: rel(p), axe: exact ? "exact" : byTail ? "by tail" : "none" };
});

// 2. LISTS: every `.from("<table>").select(` read in lib/ and app/ that is not
//    followed, within the same statement, by .limit( / .range( / .single( /
//    .maybeSingle( / .eq("id" -- a candidate unbounded list read.
const sources = [...walk(join(root, "lib")), ...walk(join(root, "app"))]
  .filter((p) => /\.(ts|tsx)$/.test(p));
const lists = [];
for (const p of sources) {
  const text = read(p);
  const re = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)\s*\.select\(/g;
  let m;
  while ((m = re.exec(text))) {
    const end = text.indexOf(";", m.index);
    const stmt = text.slice(m.index, end === -1 ? m.index + 800 : end);
    const bounded = /\.(limit|range|single|maybeSingle)\(|\.eq\(\s*["'`]id["'`]/.test(stmt) || /head:\s*true/.test(stmt);
    if (!bounded) lists.push({ file: rel(p), line: text.slice(0, m.index).split("\n").length, table: m[1] });
  }
}

// 3. RATE LIMITS: every limiter key named in SECURITY.md § 5 tables, and the
//    test files that mention it.
const security = read(join(root, "SECURITY.md"));
const s5 = security.slice(security.indexOf("## 5."), security.indexOf("## 6."));
const keys = [...new Set([...s5.matchAll(/`([a-z][a-z0-9_]+)`/g)].map((m) => m[1]))];
const testFiles = [...walk(join(root, "tests")), ...walk(join(root, "supabase", "tests"))]
  .filter((p) => /\.(ts|tsx|sql|sh)$/.test(p));
const testText = testFiles.map((p) => [rel(p), read(p)]);
const rateLimits = keys.map((k) => ({ key: k, tests: testText.filter(([, t]) => t.includes(k)).map(([f]) => f) }));

// 4. DEFINERS: every SECURITY DEFINER function created by a migration (the
//    latest definition wins), and whether the permission matrix or a census
//    names it.
const migs = readdirSync(join(root, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort();
const defs = new Map();
for (const f of migs) {
  const text = read(join(root, "supabase", "migrations", f));
  const re = /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+\.[a-z_0-9]+)\s*\(([\s\S]*?)\)\s*returns[\s\S]*?(security\s+definer|security\s+invoker|\$\$|\$function\$)/gi;
  let m;
  while ((m = re.exec(text))) defs.set(m[1].toLowerCase(), { definer: /definer/i.test(m[3]), migration: f });
}
const matrix = read(join(root, "tests", "integration", "security", "phase7-permission-matrix.test.ts"));
const censusText = testText.filter(([f]) => /census/.test(f)).map(([, t]) => t).join("\n");
const definers = [...defs].filter(([, v]) => v.definer).map(([name, v]) => {
  const short = name.split(".")[1];
  return { name, migration: v.migration, inMatrix: matrix.includes(short), inCensus: censusText.includes(short) };
});

console.log(JSON.stringify({ routes, lists, rateLimits, definers }, null, 2));

# Phase 10 — Launch hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove every launch gate in `SECURITY.md` § 11 and PRD § Delivery phases ("Pen test, performance, accessibility, backup restore") with re-runnable evidence, fix every Critical and High finding, and queue the founder actions an agent cannot do.

**Architecture:** Remediation-driven. Part A (Tasks 1–3) inventories the gates and attacks the product with the two pinned audit skills; its outputs are a graded gap list and findings files. Part B (Tasks 4+) is written into this file from those outputs, one task per remediation cluster, before any Part B task is dispatched. Part C closes the phase: `docs/launch-gates.md` final, founder actions queued, final review, PR.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres RLS, Auth, Storage), Vitest 4, Playwright, psql suites under `supabase/tests/`, the vendored skills in `.agents/skills/` (`owasp-security-check`, `supabase-audit-rls`, `wcag-audit-patterns`).

**Spec:** `docs/superpowers/specs/2026-10-16-launch-hardening-design.md`.
**Ledger:** `.superpowers/sdd/2026-10-16-launch-hardening/progress.md` (`.superpowers` is gitignored but the ledger is tracked: add it with `git add -f`).

## Global Constraints

- Branch `launch-hardening`, worktree `.claude/worktrees/launch-hardening`, stacked on `q228-closure-backup-parts` (PR #32). When #32 (and #33) merge, merge `origin/main` in before the Phase 10 PR.
- **Never** run `pnpm build` or `pnpm start`, and never point anything at a hosted Supabase project.
- The local stack and port 3000 are shared: before any `db reset`, psql run, integration run or e2e run, check for other sessions' `node`/`playwright`/`psql` processes. One heavy job at a time. psql is not on PATH: `docker exec supabase_db_getsetpaid psql -U postgres ...`.
- Never start ClamAV or any extra container locally (the Docker VM is capped at 2 GB).
- e2e: run specs in groups, each `npx playwright test <files> --workers=1` (a fresh dev server per group). If a run's shell is reaped for low memory, its children keep running: stop them by PID. A worker death `0xC0000142`, `Target crashed`, or `ERR_CONNECTION_REFUSED` is the machine, not the product; re-run that group, never add retries to config.
- `supabase-audit-rls`: local stack only, **anon key only**, never the service-role key; `.sb-pentest-context.json` and `.sb-pentest-audit.log` stay gitignored; findings are triaged into `SECURITY.md` § 10.
- Every Critical or High finding is fixed with: a failing test first (psql assertion, vitest or Playwright, whichever reaches the layer), the fix, then a mutant that reverts the fix and turns the test red. Record the mutant in the task report.
- A new psql assertion moves its suite's `run_suite` pin in `supabase/tests/run-rls-tests.sh`.
- A migration is additive (never edit an applied one). Rebuild a function from its live `pg_get_functiondef`, and diff it against its latest migration first.
- Commit and push after every change, one logical change per commit. Trailers:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SXBZ6oxYezw5xV7GQ9p13n`.
- Founder questions go to `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md` (tracked, `git add -f`) with a default that is implemented. Q243 is the design approval; the next free number is **Q244**.
- Never commit secrets, `.env` files, service-role keys, the pentest context file or the contents of private buckets.

---

## Part A — inventory and attack

### Task 1: The launch-gate inventory

A read-mostly task. It produces the document Part B is written from. It changes no product code.

**Files:**
- Create: `docs/launch-gates.md`
- Create: `scripts/launch-gate-census.mjs` (a Node script, no dependencies beyond Node 24, that prints the four mechanical censuses below as JSON; it is evidence, re-runnable, and not a test)
- Create: `.superpowers/sdd/2026-10-16-launch-hardening/task-1-report.md`

**Interfaces:**
- Produces: `docs/launch-gates.md` with one row per gate (see Step 3 for the columns), and a section **"Gaps, graded"** listing every gap as `G<n> | severity | gate | what is missing | proposed remediation | proposed test`. Part B's tasks are written from that list, so every gap needs a concrete proposed test.
- Produces: `node scripts/launch-gate-census.mjs` printing `{ routes, lists, rateLimits, definers }`.

- [ ] **Step 1: Write the census script**

`scripts/launch-gate-census.mjs` reads the repo from the working directory and prints JSON with four keys. Use only `node:fs`, `node:path` and regular expressions; it is a census, so it reports what it finds and never fails.

```js
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
```

- [ ] **Step 2: Run it and keep the output**

Run: `node scripts/launch-gate-census.mjs > .superpowers/sdd/2026-10-16-launch-hardening/census-1.json`
Expected: valid JSON. Then print counts:
`node -e "const c=require('./.superpowers/sdd/2026-10-16-launch-hardening/census-1.json'); console.log({routes:c.routes.length, axeNone:c.routes.filter(r=>r.axe==='none').length, lists:c.lists.length, rateKeysUntested:c.rateLimits.filter(r=>!r.tests.length).length, definers:c.definers.length, definersUncovered:c.definers.filter(d=>!d.inMatrix&&!d.inCensus).length})"`

Every candidate in `lists` and every uncovered definer must then be **read by hand**: a regex census over-reports (a bounded read built across several statements, a definer that is a trigger function no client can call). Record each one as `confirmed gap` or `false positive (why)` in the report. Do not grade a candidate you have not read.

- [ ] **Step 3: Write `docs/launch-gates.md`**

One table, one row per gate. The gates are the eight in `SECURITY.md` § 11, plus PRD's "performance" and "backup restore", plus the `SECURITY.md` § 15 hosted configuration (as one FOUNDER ACTION row). Columns:

| Column | Content |
|---|---|
| Gate | its name, as `SECURITY.md` § 11 words it |
| Status | `MET`, `PARTIAL`, `OPEN` or `FOUNDER ACTION` |
| Evidence | files and counts, each with the date it was last measured (CLAUDE.md § Testing gates holds most of them) |
| Re-measure | the exact command |
| Gaps | `G<n>` references into the section below |

Then the section **"Gaps, graded"**. Severity: **Critical** = a demonstrated or plausible tenant breakout, private/network leak, auth bypass or data loss; **High** = a security control promised in `CLAUDE.md`/`SECURITY.md` that is missing or untested where a mutation would go unnoticed; **Medium** = coverage missing on a control that is otherwise tested elsewhere; **Low** = documentation or ergonomics. Every gap row carries a proposed remediation and a proposed test (file and assertion), concrete enough to become a Part B task.

Then the section **"Founder actions"**: the third-party penetration test, the production backup-restore drill, counsel sign-off on the legal pages and the DPIA/ROPA, ICO registration, the EU Art 27 representative, signed DPAs (Supabase, Brevo, IONOS), and the hosted-project configuration in `SECURITY.md` § 15, each with a realistic lead time.

- [ ] **Step 4: Self-check the document**

Run: `grep -c "^| G[0-9]" docs/launch-gates.md` and confirm it equals the number of gaps in the report. Confirm every `OPEN`/`PARTIAL` row names at least one `G<n>`.

- [ ] **Step 5: Commit**

```bash
git add scripts/launch-gate-census.mjs docs/launch-gates.md
git add -f .superpowers/sdd/2026-10-16-launch-hardening/task-1-report.md .superpowers/sdd/2026-10-16-launch-hardening/census-1.json
git commit -m "Inventory every launch gate against its evidence, and grade the gaps"
git push
```

---

### Task 2: The OWASP pass

**Files:**
- Create: `.superpowers/sdd/2026-10-16-launch-hardening/task-2-findings.md`
- Modify: `SECURITY.md` § 10 (one row per accepted residual risk), and code/tests for each fixed finding
- Test: whichever layer reaches the finding (named per finding)

**Interfaces:**
- Consumes: Task 1's `docs/launch-gates.md` (gates 3 and 6 rows, and their gaps).
- Produces: `task-2-findings.md` with one entry per finding: `F<n> | severity | category (XSS, SQLi, IDOR/BOLA, CSRF, session, file access, privilege escalation, tenant breakout, secrets, headers) | location (file:line) | exploit sketch (concrete request or input) | status (fixed in <sha> with test <file> and mutant <description> / recorded in FOLLOW-UPS / false positive because ...)`.

- [ ] **Step 1: Load the skill**

Invoke the `owasp-security-check` skill (vendored at `.agents/skills/owasp-security-check/`) and follow its checklist over this codebase. Scope, in this order (highest blast radius first, `SECURITY.md` § 10): every route handler under `app/**/route.ts`; every server action (`"use server"` files under `lib/` and `app/`); every use of `lib/supabase/service.ts` and `lib/supabase/admin.ts`; every `dangerouslySetInnerHTML`, `href={` built from user data, and markdown/rich-text renderer (`lib/legal/markup*`, notes); every file upload/download path (`lib/crm/documents.ts`, `lib/feedback/actions.ts`, `lib/export/download.ts`); `middleware.ts`/`proxy.ts` and `next.config.*` (CSP and headers); session handling in `lib/auth/`.

- [ ] **Step 2: For each candidate, decide with evidence**

A candidate becomes a finding only with a concrete exploit sketch (the request, the input, the principal). For SQLi, check every `.rpc(` argument and every `execute`/`format(` in SQL that takes caller input (`%I`/`%L` and `using` are safe; string concatenation is not). For IDOR, check that every id taken from a URL or form is resolved through the caller's own RLS client or re-checked server-side. For CSRF, check that every state-changing request is a Server Action or a route handler that refuses a cross-site request (Next.js Server Actions compare `Origin` to `Host`; a route handler does not unless it checks).

- [ ] **Step 3: Fix each Critical and High finding, test first**

For each: write the failing test, run it red, fix, run it green, revert the fix to prove the test reds (the mutant), restore, commit (`Fix F<n>: <one line>`), push.

- [ ] **Step 4: Run the gates that the fixes touch**

At least `pnpm lint`, `pnpm typecheck`, `pnpm exec vitest run tests/unit`, plus the integration file, psql suite or e2e spec of each fix.

- [ ] **Step 5: Commit the findings file**

```bash
git add SECURITY.md
git add -f .superpowers/sdd/2026-10-16-launch-hardening/task-2-findings.md
git commit -m "Record the OWASP pass: findings, fixes and residual risks"
git push
```

---

### Task 3: The anon-key RLS audit (`supabase-audit-rls`, local only)

**Files:**
- Create: `.superpowers/sdd/2026-10-16-launch-hardening/task-3-findings.md`
- Modify: `SECURITY.md` § 10, and a psql suite or integration test per confirmed bypass

**Interfaces:**
- Consumes: Task 1's gate 1 row.
- Produces: `task-3-findings.md` in Task 2's format (`R<n>` ids).

- [ ] **Step 1: Prepare a clean, seeded local stack**

Check for other sessions' processes; `npx supabase db reset --local`; seed two tenants with the e2e world fixtures' shape (or `scripts/demo-seed.sql` if present) so every table has rows to leak. Confirm `.sb-pentest-context.json` and `.sb-pentest-audit.log` are in `.gitignore` (`git check-ignore -v .sb-pentest-context.json`).

- [ ] **Step 2: Run the skill with the anon key only**

Invoke the `supabase-audit-rls` skill against `http://127.0.0.1:54321` with the **anon** key from `npx supabase status -o json` (`ANON_KEY`), and with the JWT of a real signed-in principal per role it asks for. Never pass the service-role key.

- [ ] **Step 3: Confirm or refute each reported issue**

Reproduce each reported issue as a concrete PostgREST request (curl with the anon key and a principal's JWT). A reproduced bypass is **Critical**: write the psql assertion (in the suite that owns the table) or an HTTP check in `run-rls-tests.sh`'s API block, run it red, fix with an additive migration, run it green, mutate, restore. An unreproduced report is a false positive with the request that refuted it.

- [ ] **Step 4: Run the full psql suite on a fresh reset**

`npx supabase db reset --local && bash supabase/tests/run-rls-tests.sh` → "All suites passed".

- [ ] **Step 5: Commit**

```bash
git add SECURITY.md
git add -f .superpowers/sdd/2026-10-16-launch-hardening/task-3-findings.md
git commit -m "Record the anon-key RLS audit against the local stack"
git push
```

---

## Part B — remediation (written from Tasks 1–3 before dispatch)

The coordinator writes one task per remediation cluster here, from `docs/launch-gates.md` § "Gaps, graded" and the two findings files, each in the Task structure above with its files, the failing test's code, and the commands. Expected clusters, to be confirmed or dropped by Task 1's evidence:

- every unbounded list read bounded, with a census test that fails on a new one;
- every rate limit in `SECURITY.md` § 5 exercised by a test at its boundary;
- every app route covered by an axe scan, or listed in the census with the reason it is not;
- every list read index-backed at realistic volume (`EXPLAIN` on seeded data, a psql assertion per hot query);
- a local backup-restore drill: `docs/runbooks/backup-restore.md` plus a script that dumps the local DB, restores it into a fresh stack and re-runs the psql suite against the restore.

## Part C — close the phase

### Task C1: Founder actions and the final gate document

- [ ] Queue each founder action from `docs/launch-gates.md` § "Founder actions" as one numbered question from Q244 in `DECISIONS-QUEUE.md`, with its lead time and default ("founder to book/sign/register; launch blocked until done").
- [ ] Re-run every gate's re-measure command, update each row's status and date, commit, push.

### Task C2: Final whole-branch review, then the PR

- [ ] Dispatch an independent reviewer over the whole branch range with the five gates to reproduce; fix Critical/Important findings; then open the Phase 10 PR (base `q228-closure-backup-parts` while #32 is open, `main` once it merges).

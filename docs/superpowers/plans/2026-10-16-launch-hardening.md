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

**Coordinator ruling for the fix phase (2026-10-17, after the audit phase stopped on F1):** F1 moves to Task 19 and F4 to Task 6, so neither is fixed here. This phase does four things:
1. Finish `task-2-findings.md`: rows F7–F10 were cut off when the file was written.
2. Finish the audit scope left after the early stop: the bodies of the CRM and admin Server Actions, and the export, erasure and retention runners. Add any new finding as a further row.
3. Fix F2 (Admin self-promotes to Owner) and F3 (password or MFA change straight to GoTrue skips step-up) test first, plus F5 (the `safeNextPath` dot-segment open redirect) and F6 (auth cookies without `Secure`), which are cheap Mediums.
4. Write `docs/threat-model.md` (G19) with its reference test.

Queue F2's question, "may an Admin grant or remove the Owner role? (default per the PRD: no, only an Owner, implemented)", as the next free Q. If F3 has no GoTrue-side control in the pinned version, record it as a residual in `SECURITY.md` § 4 and § 10 with the evidence instead of building around GoTrue. Either way, turn on the pinned GoTrue's password-changed and MFA-factor notification emails if it supports them (`supabase/config.toml` `[auth.email.notification.*]`, today "declared intent, not an active control"), prove one arrives in Mailpit, and add the hosted setting to `SECURITY.md` § 15 (amended 2026-10-18, audit finding 5).

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

## Part B — remediation (written from Task 1's graded gaps, 2026-10-17)

Each task below closes one or more gaps from `docs/launch-gates.md` § "Gaps, graded". **The gap rows are part of each task's requirements:** read every row the task names, verbatim, before starting. A row's "Proposed remediation" and "Proposed test" are the spec; where this task text and a row disagree, this task text governs (it records a coordinator decision). Task 2 and Task 3 findings that need remediation are appended here as further tasks when those tasks report.

Every task inherits the Global Constraints, and in particular: a Critical or High gap is closed test first (run it red), then the fix (green), then a mutant that reverts the fix and turns the test red, recorded in the report. Each task ends by updating its gap rows in `docs/launch-gates.md` (status column of the gate row it moves, and a "Closed in <sha>" note on the gap row) and running the gates its changes touch: always `pnpm lint`, `pnpm typecheck` (after `npx next typegen` if a route changed) and `pnpm exec vitest run tests/unit`, plus the named heavy suites.

**Execution order:** Task 4 runs immediately after Task 1, before Tasks 2 and 3, because it closes the only Critical gap. The rest run after Task 3 in the order written (severity first).

**Amended 2026-10-17 after Task 2's audit phase:** Task 2 stopped early on F1, a Critical that is not a Task 1 gap. F1 is appended as **Task 19** and runs right after Task 4. The order is now Task 4 → Task 19 → Task 20 → Task 2 fix phase → Task 3 → Tasks 5–16 → Tasks 17–18 (Task 20, G11's Q245 residual, added after Task 4 reported).

**Amended 2026-10-18 after the founder's whole-repo audit ("fix all"):** five new tasks close the audit findings no task held. Task 21 (remove a member, change a role; High) and Task 22 (sign out everywhere; High) run right after Task 2's fix phase, 21 first because it needs F2. Task 23 (storage quota, plus the custom-field limit race), Task 24 (every export in parts) and Task 25 (one runner credential check) run after Task 16. The order is now Task 19 → Task 20 → Task 2 fix phase → Task 21 → Task 22 → Task 3 → Tasks 5–16 → Tasks 23–25 → Tasks 17–18. The audit's other findings already map to tasks: 1 → 19, 2 → 20, 3/5/10/14 → Task 2 fix phase (F2, F3, F5, F6), 6 → 6, 8 → 8, 9 → 10 and 11, 13 → 5. Task 2 F4 (erasure and `close_my_workspace` skip step-up over PostgREST) folds into Task 6.

---

### Task 4: Close the invite pre-hijack (G11, Critical)

**Files:**
- Create: `supabase/migrations/<next timestamp>_invites_require_a_proven_email.sql`
- Modify: `supabase/config.toml` (`[auth.email] enable_confirmations = true`), `lib/org/actions.ts` (the invite step that reuses an existing account), `supabase/tests/rls_foundation.sql` + its `run_suite` pin, `SECURITY.md` § 15 (Confirm email ON, with its verification step), `docs/launch-gates.md`
- Create: `tests/unit/security/auth-config.test.ts`, `tests/e2e/invite-pre-hijack.spec.ts`

**Interfaces:**
- Consumes: `public.accept_invite` as last defined (`supabase/migrations/20260828220000_second_gate_on_foundation_writes.sql`; rebuild from the live `pg_get_functiondef` and diff against that file first).
- Produces: `accept_invite` refuses SQLSTATE `42501` with hint `invite_email_unconfirmed` when `auth.users.email_confirmed_at` is NULL for `auth.uid()`; `tests/unit/security/auth-config.test.ts` exporting nothing, reading `supabase/config.toml` (Task 8 extends this same file).

- [ ] **Step 1: Reproduce the attack before changing anything.** Against the local stack (check for other sessions first), through the real forms: sign up at `/signup` as `squatter-<ts>@example.test` (confirmations are off locally, so the account is usable at once); as a second workspace's Owner, invite that address with role Manager through the real invite form; as the squatter, open `/invites` and accept. Record in the report whether the membership became `active` (the expected reproduction) and the exact steps. If it does NOT reproduce, stop and report DONE_WITH_CONCERNS with the evidence: the grade and the rest of this task change.
- [ ] **Step 2: Write the failing psql assertions** in `rls_foundation.sql`, in the suite's own assertion style: an invited user whose `auth.users.email_confirmed_at` is NULL calls `accept_invite` → SQLSTATE `42501`, and the membership row stays `invited`; the positive control: the same fixture with `email_confirmed_at = now()` accepts and the row becomes `active`. Move the `RLS FOUNDATION` pin. Run the runner on a fresh reset: the new refusal assertion is red.
- [ ] **Step 3: Write the failing config test** `tests/unit/security/auth-config.test.ts`: parse `supabase/config.toml` (a small TOML reader, or a section-aware line scan; no new dependency unless one is already in `package.json`) and assert `[auth.email] enable_confirmations = true`. Red.
- [ ] **Step 4: The fix.** The additive migration rebuilds `accept_invite` with the email-proven check before any write. In `lib/org/actions.ts`, when the invite step finds an existing account, refuse to bind it if that account's email is unconfirmed (read `email_confirmed_at` from the Admin API user record) with a plain message to the inviter ("That address has an account that has not confirmed its email yet. Ask them to confirm it, then invite again."). Set `enable_confirmations = true` in `config.toml`. Re-run: green.
- [ ] **Step 5: The e2e proof** `tests/e2e/invite-pre-hijack.spec.ts`: sign up through `/signup` (now lands on `/signup/check-email`); assert the squatter cannot sign in before confirming; have a second workspace's Owner invite the address and assert the inviter sees the refusal above; assert no `organisation_memberships` row for that user exists in Postgres. Then confirm through the local mail catcher (Inbucket/Mailpit, whichever `config.toml` runs) and assert a fresh invite can now be accepted (the positive control).
- [ ] **Step 5b: The confirmations-ON takeover (task review, Task 1 fix round).** `lib/org/actions.ts:258-261` and `:280-282` record that `inviteUserByEmail` on an existing **unconfirmed** user returns 200 with the same id and re-sends the invite (only a confirmed user gets `email_exists`), so a squatter who signed up with confirmations ON is bound in the `created: true` branch — and when the real owner follows the invite link, the squatter's account becomes confirmed with the squatter's password intact. The `accept_invite` check alone does not close this. Write the failing case first (integration or e2e): with confirmations ON, the squatter signs up as the address (unconfirmed); the workspace invites it; the victim follows the invite link from the mail catcher and sets up access; then **the squatter's original password must fail to sign in**. Fix in the invite step itself (the refuse-to-bind-an-unconfirmed-existing-account check lives in the `created: true` branch as well as the 422 fallback; the inviter sees the refusal message from Step 4), or require the invitee to set a new password on invite verification (which invalidates the squatter's). Choose the one the test proves; record which and why. Mutant: remove the check → the squatter signs in → red.
- [ ] **Step 6: Probe GoTrue's unconfirmed re-signup.** With confirmations on, sign up an address, do not confirm, sign up the same address again with a different password, and record what GoTrue does (a second confirmation mail to the same inbox is the safe outcome; a password overwrite usable without the inbox is a finding). Record the result in the report and in `SECURITY.md` § 10 if it is a residual risk.
- [ ] **Step 7: Mutant.** Revert the `accept_invite` check in a scratch migration applied by psql inside a transaction (or temporarily), and show the Step 2 assertion red; restore.
- [ ] **Step 8: Gates.** Fresh reset + full psql runner ("All suites passed"); `pnpm test` (the whole vitest, since invite flows have integration tests); the e2e specs that sign up or invite (`invite-pre-hijack.spec.ts`, and every spec that `grep -l "invite\|signup" tests/e2e/*.spec.ts` names) in groups with `--workers=1`. Founder question: queue "Confirm email ON in production (default: yes, implemented)" as the next free Q.
- [ ] **Step 9: Commit per logical change, push.**

---

### Task 5: A server-only request mark: close the directory-limit bypass and the impersonator's direct reads (G2, G14, High)

**Files:**
- Create: `supabase/migrations/<ts>_server_request_mark.sql`, `tests/integration/security/server-request-mark.test.ts`
- Modify: `lib/supabase/server.ts` (send the header), `.env.example`, the local seed (wherever local-only rows are seeded; find it — `supabase/seed.sql` or the runner's fixture block), `supabase/tests/run-rls-tests.sh` (HTTP block), `supabase/tests/rls_phase7_impersonation.sql` § IM + pin, `tests/integration/security/rate-limit-network-discovery.test.ts`, `SECURITY.md` §§ 5, 7, 15, `docs/launch-gates.md`

**Interfaces:**
- Produces: `private.api_pre_request()` registered as PostgREST's `db_pre_request`; a transaction-local flag that later checks read (recommended shape below); `private.request_is_from_server() returns boolean`; env `GETSETPAID_SERVER_REQUEST_SECRET` (server-only, never `NEXT_PUBLIC_`).

**Coordinator decision (the recommended shape; the implementer may improve it with evidence, not drop a property):**
1. The server's Supabase client (`lib/supabase/server.ts`, and only it — never a browser client) sends `x-getsetpaid-server: <GETSETPAID_SERVER_REQUEST_SECRET>` on every request.
2. `private.api_pre_request()` reads `current_setting('request.headers', true)::json ->> 'x-getsetpaid-server'`, compares its SHA-256 with a digest held in the database (Vault or a `private` table readable by no API role), and sets a transaction-local flag (`set_config('getsetpaid.from_server', 'on', true)`) when it matches. It then refuses (raise with a PostgREST-mapped 403) any request whose `request.path` names `network_directory` or `network_connected_profiles` without the flag. It writes nothing.
3. `private.request_is_from_server()` reads that flag. `private.impersonated_organisations()` (rebuild from live) returns its target only when it is true, so an impersonating superuser's direct PostgREST reads see nothing and every read goes through `getCurrentOrg()`'s audited path (G14's default).
4. Locally the digest is seeded from a fixed, clearly-local value that `.env.example` also documents; production sets its own pair (§ 15). A missing digest fails closed (directory refused), and the server logs one clear line naming the missing setting.
5. Confirm by experiment that the local PostgREST honours `pgrst.db_pre_request` via `alter role authenticator set ...` plus `notify pgrst, 'reload config'`, and that a migration can set it so a fresh `db reset` carries it. If it cannot be set from a migration, stop and report NEEDS_CONTEXT with the evidence.

- [ ] **Step 1: Failing tests first.** (a) Runner HTTP block, as a real signed-in session with the anon key: direct `GET /rest/v1/network_directory?select=*` → 403 and no rows; positive control with the header → 200 with rows. (b) The same pair for `network_connected_profiles`. (c) `rls_phase7_impersonation.sql` § IM: a live impersonation session without the flag reads 0 of the target's contacts; with the flag set it reads them. (d) Runner HTTP: direct `GET /rest/v1/contacts?organisation_id=eq.<target>` with the impersonating superuser's JWT returns `[]`. (e) `rate-limit-network-discovery.test.ts`: a new case asserting the direct path is refused while the app path still meters (31st refused). Run red.
- [ ] **Step 2: The fix** per the decision above. Green.
- [ ] **Step 3: Mutants.** Drop the view check from the pre-request function → (a)/(b) red. Drop the flag term from `impersonated_organisations()` → (c)/(d) red. Record both.
- [ ] **Step 4: Gates.** Fresh reset + full psql runner; `pnpm test`; e2e: `network.spec.ts`, `network-leakage.spec.ts`, `impersonation.spec.ts`, `tenant-breakout.spec.ts` in groups with `--workers=1` (the app path must keep working end to end).
- [ ] **Step 5: Docs.** `SECURITY.md` § 5 (the directory limit is now enforced on every path), § 7 (impersonated direct reads closed), § 15 (generate and set the secret and its digest; verification: a direct GET of the directory with a real session returns 403). Commit per logical change, push.

---

### Task 6: Step-up enforced in the database (G13, High)

**Files:**
- Create: `supabase/migrations/<ts>_step_up_tokens.sql`, `supabase/tests/rls_phase10_step_up.sql` (+ its `run_suite` line in `run-rls-tests.sh`), `tests/unit/security/step-up-token-callers.test.ts`
- Modify: every server action that calls `checkStepUp()` before a gated write (`lib/admin/closures.ts`, `impersonation.ts`, `lifecycle.ts`, `overrides.ts`, `retention-actions.ts`, the legal publish/counsel-review actions, the DSR reject action, the export request action — confirm the full list with `grep -rn checkStepUp lib app`), the permission matrix (its catalogue file and its pinned total), `SECURITY.md` § 4, `docs/launch-gates.md`

**Interfaces:**
- Produces: `public.mint_step_up_token(p_purpose text) returns void` (granted to `authenticated`; the server calls it only after `checkStepUp()` passes); `private.consume_step_up(p_purpose text) returns void` (raises `42501`, hint `step_up_required`, unless the caller holds a fresh, unconsumed, unexpired token for that purpose, which it then marks consumed); table `private.step_up_tokens(id, user_id, purpose, created_at, expires_at, consumed_at)`; a closed purpose list as a check constraint.

**Coordinator decisions:**
1. A token lives 5 minutes and is single-use. Purposes are one per gated RPC family; list them in the migration header with the RPC each guards.
2. **Minting must itself require proof the server checked step-up.** A bare `mint_step_up_token` callable over PostgREST would let a scripted caller mint then call — defeating the point. Bind minting to Task 5's server request mark: `mint_step_up_token` refuses unless `private.request_is_from_server()` is true. **Task 6 therefore depends on Task 5** and runs after it.
3. `export_jobs` is gated in its insert trigger (it is a table insert, not an RPC).
4. **Task 2 F4 is in scope (amended 2026-10-17).** Two more paths skip step-up over PostgREST: the `erasure_jobs` insert (`lib/erasure/actions.ts:64-67`, `private.erasure_jobs_before_insert` in `20260930005000` has no freshness term) and `public.close_my_workspace` (`lib/org/closure-actions.ts:54-61`, `20261021000000:325` checks aal2 only). Gate both with a purpose each, in the same suite, with the same five refusals. Read row F4 in `task-2-findings.md`.

- [ ] **Step 1: Failing suite** `rls_phase10_step_up.sql`: for each gated RPC and the `export_jobs` insert — no token → `42501`; a consumed token → `42501`; another user's token → `42501`; an expired token (backdated) → `42501`; a fresh token → succeeds once, and a second call with the same token → `42501`; minting without the server mark → `42501`. Non-vacuity control: the count of gated RPCs equals the purpose list's length. Wire it into the runner with its pin. Red.
- [ ] **Step 2: The fix:** the migration, then each server action mints immediately after `checkStepUp()` passes and before its RPC. Green; the existing suites for those RPCs must stay green (their fixtures will need a token — add a shared psql helper rather than repeating the mint in each suite).
- [ ] **Step 3: Census test** `tests/unit/security/step-up-token-callers.test.ts`: every file calling `checkStepUp(` also calls the mint with a purpose from the closed list (AST or a scoped text scan), so a new gated action cannot forget it.
- [ ] **Step 4: Mutant.** Make `consume_step_up` return early → every refusal in the suite red. Record.
- [ ] **Step 5: Gates.** Fresh reset + full psql runner; `pnpm test`; the permission matrix with its new total; e2e for the gated surfaces (`super-*.spec.ts`, `exports*.spec.ts`, `closure*.spec.ts`, `legal*.spec.ts`, `impersonation.spec.ts` — whatever exists) in groups. Commit per logical change, push.

---

### Task 7: Pin the framework protections: CSRF, session fixation and revocation, security headers (G12, G16 High; G17 Medium)

**Files:**
- Create: `tests/e2e/csrf.spec.ts`, `tests/unit/security/next-config.test.ts`, `tests/integration/session/fixation-and-revocation.test.ts`, `tests/unit/security/headers.test.ts`
- Modify: `docs/launch-gates.md`; code only if a test finds a real hole (then it is a fix with a mutant)

**Interfaces:** consumes `lib/security/headers.ts` (the CSP builder) and `next.config.ts`; produces tests only.

- [ ] **Step 1: CSRF (G12's proposed test, exactly).** In a real signed-in browser, post a real Server Action (create contact) with `Origin: https://evil.example` (Playwright `page.request` with the session's cookies and the action's `Next-Action` id captured from a genuine submission). Assert refusal and the `contacts` row count unchanged in Postgres; positive control with the app's own origin creates the row. Assert every `sb-*-auth-token` cookie carries `SameSite=Lax` or stricter. `next-config.test.ts`: `serverActions.allowedOrigins` is absent or empty.
- [ ] **Step 2: Session (G16's proposed test).** (1) Sign in, capture the refresh token, sign out through the app's action, and assert a refresh with the captured token returns `400` `refresh_token_not_found` (if `signOut({ scope: "local" })` leaves it valid, that is a finding: fix by revoking server-side, test first). (2) An e2e step: plant a bogus `sb-*-auth-token` cookie, sign in, and assert the cookie value changed and the bogus value is not accepted.
- [ ] **Step 3: Headers (G17's proposed test).** With `NODE_ENV=production` and an https `NEXT_PUBLIC_SITE_URL`, assert `script-src` carries neither `'unsafe-inline'` nor `'unsafe-eval'`, and that `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `upgrade-insecure-requests`, `X-Frame-Options`, `X-Content-Type-Options: nosniff` and HSTS are present; with http, HSTS and `upgrade-insecure-requests` are absent. Mutant: add `'unsafe-inline'` to `script-src` → red.
- [ ] **Step 4: Gates.** Unit + the integration file + `csrf.spec.ts` and the touched e2e spec with `--workers=1`. Commit, push.

---

### Task 8: Account-level auth limits and the hosted checklist (G3, G4, G10 High; G31 Low)

**Files:**
- Modify: `supabase/config.toml`, `tests/unit/security/auth-config.test.ts` (created by Task 4), `lib/auth/` sign-in action (find it: `grep -rn signInWithPassword lib app`), `lib/security/rate-limit.ts` only if the fallback needs a new category, `SECURITY.md` §§ 5, 15, `docs/launch-gates.md`
- Create: `tests/integration/security/login-account-budget.test.ts`, `tests/integration/security/recovery-frequency.test.ts`, `tests/unit/security/security-md-checklist.test.ts`

**Coordinator decisions:**
1. **G3 (recovery 3/hour/account):** there is no app recovery page, so GoTrue's own per-user `[auth.email] max_frequency` is the only enforcement point. Default `"20m"` (≤ 3 per hour per account), set in `config.toml` and required in § 15. GoTrue applies the same timer to magic-link mail, so measure locally whether a second magic link within 20 minutes is refused and record the result; if it is, queue the trade-off as a founder question (default: keep `20m`, as `SECURITY.md` § 5 promises 3/hour).
2. **G4 (per-account login lockout in production):** founder action F8 (a Supabase plan that permits the password-verification hook) stays the primary control. **Build the fallback anyway, as defence in depth**, because without F8 production has no per-account bound: an app-side check in the sign-in action, keyed on a SHA-256 of the normalised email, refusing the sixth failed attempt in 15 minutes before GoTrue is called. Use the existing `login_account` counter if the database permits an app-side consume for it without opening a stranger-burns-your-budget hole (`lib/security/rate-limit.ts:48` says the RPC refuses it from a session today — keep that refusal for direct PostgREST callers, e.g. by Task 5's server mark); otherwise add a narrowly scoped server-only path. Document in § 5 that direct GoTrue calls bypass the fallback, leaving the hosted hook (F8) or per-IP as the bound.

- [ ] **Step 1: Failing tests.** `login-account-budget.test.ts` drives the real sign-in action six times for one email with a wrong password and asserts the sixth is refused before GoTrue is called (spy or count GoTrue requests); a correct password on the first try still signs in (positive control). `recovery-frequency.test.ts`: two `resetPasswordForEmail` calls for one account within the window; the second is `429 over_email_send_rate_limit`. `auth-config.test.ts` gains `max_frequency = "20m"` and the three `[auth.rate_limit]` values (G10). Red. **Do not drive GoTrue's per-IP limit to its boundary on the shared stack** (Task 1 re-review): 31 sign-ins from localhost would 429 every other session's sign-ins for up to 5 minutes, and wrong passwords trip the per-account hook first. G10 is pinned by the config test; any live per-IP check is a § 15 hosted step run from an isolated source, never against real users' IPs.
- [ ] **Step 2: Fix** per the decisions. Green. Mutant: remove the app-side check → the login test red.
- [ ] **Step 3: G31.** Add each setting G31 lists to `SECURITY.md` § 15 with its verification step, and update § 10's "tables created outside migrations" row. `security-md-checklist.test.ts` asserts § 15 names each setting key (a text census).
- [ ] **Step 4: Gates.** Unit + the two integration files + `pnpm test:rls`; e2e `login*.spec.ts`/`keyboard.spec.ts` (the login journey) with `--workers=1`. Founder questions: G3's trade-off if measured, G4 (default: buy F8; fallback shipped). Commit, push.

---

### Task 9: The heavy suites in CI, plus licence and SAST scanning (G1 High; G23, G24 Medium)

**Files:**
- Merge: `origin/infra-parallel-stacks` (`59b66f6`, `0627f05`, `7c9bc0e`; 4 commits not on this branch)
- Modify: `.github/workflows/ci.yml`, `package.json` (scripts only), `docs/launch-gates.md`, `CLAUDE.md` § Current state ("CI runs a subset" paragraph, now false)
- Create: `tests/unit/ci/workflow-jobs.test.ts`, `scripts/check-licenses.mjs`, `tests/unit/ci/check-licenses.test.ts`

**Coordinator decisions:**
1. Founder ruling Q169 (2026-09-30, option a): the three heavy jobs run on PRs and on pushes to main. Merge the branch, resolving conflicts in favour of the current `ci.yml`'s existing jobs and pins; keep every `uses:` pinned to a 40-hex SHA with its `# vX.Y.Z` trailer.
2. The branch also brings per-worktree stacks (`pnpm stack:claim`). Merge it whole; do not run `stack:claim` on this machine during this task (the shared stack is in use by the coordinator's flow). Record in the report what it changes for local development.
3. G24 default (founder question, cost): Semgrep CE (free) as SAST in the `scan` job, rule packs `p/typescript` and `p/react`, SHA-pinned; OWASP ZAP baseline as DAST only if it fits the e2e job's runner budget — otherwise record it in `FOLLOW-UPS.md` with the reason. CodeQL is not added.
4. G23: `scripts/check-licenses.mjs` per G23's row, allowlist exactly as the row states, run as a `scan` job step.

- [ ] **Step 1: Failing tests.** `workflow-jobs.test.ts` per G1's and G24's proposed tests (five or more jobs; triggers `pull_request` and `push: main`; the heavy three run the psql runner, `pnpm exec vitest run tests/integration` and `npx playwright test`; every `uses:` is 40-hex; the licence and Semgrep steps exist). `check-licenses.test.ts` per G23's row (real distribution passes; an `AGPL-3.0` fixture fails naming the package; an unknown licence fails). Red.
- [ ] **Step 2: Merge and wire.** Green locally.
- [ ] **Step 3: Prove on GitHub.** Open the Phase 10 PR as a **draft** now (base `q228-closure-backup-parts` while #32 is open), so the workflow runs. Record the run ids and each job's result. Then the planted mutant per G1's row (a scratch commit dropping one policy's `WITH CHECK` in a new migration): see the RLS job go red, revert, record both run ids. Same for Semgrep with a planted `eval(` in a scratch file. If a heavy job fails for runner memory, split Playwright into the local spec groups.
- [ ] **Step 4: Docs and gates.** Update `CLAUDE.md`'s CI paragraph to what now runs. Unit gates. Commit per logical change, push.

---

### Task 10: The local backup-restore drill (G28, High)

**Files:**
- Create: `docs/runbooks/backup-restore.md`, `scripts/backup-restore-drill.sh`
- Modify: `supabase/tests/run-rls-tests.sh` only to accept a target database (env var, default unchanged), `docs/launch-gates.md`

- [ ] **Step 1: Build the drill per G28's row.** Inside the local `supabase_db_getsetpaid` container only: `pg_dumpall --roles-only`, `pg_dump` of the database, restore both into a fresh database in the same container (`createdb getsetpaid_restore`), then the three checks: (1) catalogue diff of `pg_policies`, `relacl`, `proacl`, and `pg_auth_members` for `export_reader` is empty; (2) per-table row counts match for every table in `public`, `private`, `auth`, `storage`; (3) `run-rls-tests.sh` against the restored database prints "All suites passed". The script exits 0 only when all three hold, and prints its elapsed time. Also check that `cron.job` rows and Vault secret names survive, and record what does not (Storage objects do not — that is G30).
- [ ] **Step 2: Mutant.** Omit the roles dump → the drill fails on `export_reader`. Record.
- [ ] **Step 3: Runbook.** `docs/runbooks/backup-restore.md`: the local drill (command, what it proves, the run's date and duration as the local RTO measure), and the production drill (founder action F2: restore the newest Supabase backup into a scratch project, plus a Storage sample, inside 4h; backup age = RPO). The runner change must not alter its default behaviour (re-run the full runner on a fresh reset afterwards: "All suites passed"). Commit, push.

---

### Task 11: A Storage backup job (G30, High)

**Files:**
- Create: `scripts/storage-backup.mjs`, `tests/unit/backup/storage-backup.test.ts`
- Modify: `docs/runbooks/backup-restore.md` (a Storage section), `SECURITY.md` §§ 8, 15, `docs/launch-gates.md`

**Coordinator decision:** G30's proposed default, implemented as a script with mocked-client tests; deploying it (the nightly schedule on the IONOS host, the destination bucket and its DPA) is founder action, queued as the next free Q (default: nightly to UK/EU object storage under the host's DPA, 30-day retention, encrypted at rest). The script reads the bucket list from one constant (the three private buckets: documents, feedback screenshots, exports — confirm names in `lib/supabase/storage.ts`), uses the service-role Storage client (and so must join that client's importer census — update the census allowlist with the reason), and writes to an S3-compatible endpoint from env.

- [ ] **Step 1: Failing tests** per G30's row: every object of every listed bucket is copied (paging through `list` beyond one page); a failed copy exits non-zero and names the object; no object is sent anywhere but the configured endpoint; the script refuses to start if the endpoint env is missing. Red.
- [ ] **Step 2: Implement.** Green. Mutant: skip the second list page → red.
- [ ] **Step 3: Docs.** Runbook section, § 8 (Storage is now backed up, once deployed), § 15 (the env values and the schedule). Unit gates. Commit, push.

---

### Task 12: Catalogue censuses for SECURITY DEFINER functions (G25, G26, Medium)

**Files:**
- Modify: `supabase/tests/schema_invariants.sql` + its pin
- Create: `tests/integration/security/definer-register.test.ts`, and the declared register it reads (a TS module beside the test, `PRIVATE_POLICY_HELPERS` with a one-line reason each)
- Modify: `docs/launch-gates.md`

- [ ] **Step 1:** G25's assertion and non-vacuity control in `schema_invariants.sql`; mutant inside a rolled-back block per the row. Move the pin.
- [ ] **Step 2:** G26's register test per the row: the classified union (matrix lists, triggers, no API grant, `PRIVATE_POLICY_HELPERS`) equals the live `pg_proc` set; a planted `private.zz_probe()` definer granted to `authenticated` goes red naming itself (create and drop it inside the test).
- [ ] **Step 3: Gates.** Fresh reset + full runner; `pnpm test:rls` and the new integration file. Commit, push.

---

### Task 13: Source censuses (G7, G9, G18, G27, Medium/Low)

**Files:**
- Create: `tests/unit/list/unbounded-read-census.test.ts`, `tests/unit/list/postgrest-interpolation-census.test.ts`, `tests/unit/security/raw-html-sink-census.test.ts`, `tests/unit/security/admin-client-census.test.ts`, `tests/unit/security/service-key-readers.test.ts`
- Modify: `docs/launch-gates.md`

**Coordinator decision:** all five use the TypeScript compiler API already in the repo's dev dependencies (the existing AST helper `moduleReferences()` shows the house pattern; reuse it, do not add a parser). Each has a planted-positive self-test proving the detector bites. The unbounded-read census's allowlist starts from the hand-read dispositions in `task-1-report.md` and `docs/launch-gates.md`, one reason per entry; the six G5 reads and two G6 reads stay listed until Task 14 bounds them (Task 14 removes them).

- [ ] **Step 1:** Each census per its gap row's proposed test, red-then-green on its planted positive.
- [ ] **Step 2: Gates.** `pnpm exec vitest run tests/unit`. Commit per census, push.

---

### Task 14: Bound the remaining reads, and tell a storage blip from a missing export (G5, G6, G8, G20, Medium/Low)

**Files:** per the four gap rows (`lib/crm/custom-field-queries.ts`, `lib/crm/dedup.ts`, `lib/network/entities.ts`, `app/(app)/[orgSlug]/members/page.tsx`, `lib/export/download.ts` / `issueExportDownloadUrl`), their proposed tests, and Task 13's allowlist (remove each bounded read).

**Coordinator decisions:** G5's ceiling is 500 with fail-loud, no creation ceiling (founder question queued: what "unlimited custom fields" means; default as stated). G6 takes the anti-join view if it can be `security_invoker` and stays inside the tenant's RLS (prove with a psql assertion that a foreign tenant's records never appear); otherwise the bounded `not.in` page. Also `lib/network/entities.ts:85-92`: its comment says a failed read should "treat every record as already published (offer none)", but the code returns `[]`, which offers every record (fail-open, Task 1 re-review); make the code match the comment, test first. G20 per its row; FOLLOW-UPS M2 is the history (local storage returns 400 for a missing object, so the fix must distinguish by reading the error's status or using `info()`, and must be proved against the local stack, not only a mock).

- [ ] **Step 1:** Each gap's proposed test, red; the fix; green. G20 also gets an integration check against local storage: a genuinely missing object still renders not-found.
- [ ] **Step 2: Gates.** Unit + the touched integration files + `exports*.spec.ts` and the network spec with `--workers=1`. Commit per gap, push.

---

### Task 15: Every UI route scanned by axe, or exempt with a reason (G21, Medium)

**Files:** `tests/e2e/support/axe-routes.ts` (new), `tests/e2e/accessibility.spec.ts`, `tests/unit/design/axe-route-census.test.ts` (new), `CLAUDE.md` (the scan count in the gates table), `docs/launch-gates.md`

- [ ] **Step 1:** G21's census test, red (it lists the 42 unscanned routes).
- [ ] **Step 2:** Move the page list to `axe-routes.ts` per the row; add every unscanned route shape; `EXEMPT` entries carry a reason. Census green.
- [ ] **Step 3:** `npx playwright test tests/e2e/accessibility.spec.ts --workers=1` (fresh dev server; split into two runs by label if memory runs short). Each new violation is fixed in the page (token-correct, per `DESIGN.md`), not suppressed. Update `CLAUDE.md`'s scan count. Commit, push.

---

### Task 16: List reads index-backed at volume (G29, Medium)

**Files:** `supabase/tests/perf/seed-volume.sql`, `supabase/tests/perf/list-plans.sql`, `supabase/tests/perf/run.sh` (all new), additive index migrations as the plans require, `docs/launch-gates.md` (a budget per endpoint class)

- [ ] **Step 1:** Per G29's row: seed 50,000 rows per hot table in one tenant and 20,000 published profiles (after a fresh reset; never inside the RLS runner); assert per hot list query that the plan has no Seq Scan over the seeded table and stays under a recorded cost ceiling, run as the `authenticated` role with a real member's claims so RLS is in the plan. Red where indexes are missing.
- [ ] **Step 2:** Additive `gin_trgm_ops` (or btree) indexes where the plans say so. Green. Mutant: drop `contacts_name_trgm_idx` → the contacts search plan red.
- [ ] **Step 3:** Trigram census assertion per the row. Reset afterwards (the seeded volume must not leak into other runs). Fresh reset + full runner to prove the new migrations break nothing. Commit, push.

### Task 19: Close the readable network base table (Task 2 F1, Critical)

Numbered 19 because it was appended after Part C was numbered; it runs **immediately after Task 4**, before Task 2's fix phase (see the execution order above).

**The finding (verbatim from `.superpowers/sdd/2026-10-16-launch-hardening/task-2-findings.md` row F1; read the whole row first):** `public.network_profiles` carries a table-wide `grant select ... to authenticated` (`supabase/migrations/20260904000000_network_tables.sql:633`) and the cross-tenant ROW policy `network_profiles_select_published_directory` (last altered in `supabase/migrations/20260908031000_network_presence_wind_down.sql:150-161`). Any account with an active membership anywhere (a free sign-up plus `create_organisation`) can send `GET /rest/v1/network_profiles?select=display_name,contact_email,bio,headline,city,field_visibility,organisation_id,entity_id&status=eq.published` with the anon key and its own JWT. It gets every published, live profile with every `connections`-level value unmasked, plus `organisation_id` and `entity_id`. No connection request is needed and no rate limit applies. `hidden` values are NULL in the base column (N3), so they are not exposed. The repository asserts this as "by design" in `supabase/tests/network_leakage_phase6.sql:319-321` (LB6c) and `supabase/tests/run-rls-tests.sh:3607-3610` (LEAKAGE #1a). `FOLLOW-UPS.md` § Phase 6, "The readable base table, and the column-level-grants alternative not taken", reason (2), argues the app never reads the base table for a foreign organisation. That premise is false, because PostgREST is a present path (`SECURITY.md` § 4). The founder rule in `CLAUDE.md` is that `connections`-level data resolves "for the other side" only after both sides accept.

**Files:**
- Create: `supabase/migrations/<next timestamp>_network_base_table_is_not_a_read_path.sql`
- Modify: `supabase/tests/network_leakage_phase6.sql` (LB6c flipped to a refusal) and its `run_suite` pin, `supabase/tests/run-rls-tests.sh` (LEAKAGE #1a flipped to a refusal), `supabase/tests/rls_phase6_network.sql` § ND if the views' dependency assertions change, `SECURITY.md` § 2 (as-built) and § 10 ("Network privacy leakage" residual 1 closed), `FOLLOW-UPS.md` § Phase 6 (the entry above closed with this task's sha), the `CLAUDE.md` paragraph "The base table is readable and the VIEW is the mask, not the policy" (rewritten to the new as-built), `docs/launch-gates.md` (a new gap row **G32, Critical**, "Closed in <sha>", and the gate 3 row's evidence)
- Test: the two suites above, and `tests/e2e/network.spec.ts` (must stay green unchanged)

**Interfaces:**
- Consumes: `public.network_directory` and `public.network_connected_profiles` as last defined (rebuild from the live `pg_get_viewdef` and diff against `20260904004000_network_discovery_views.sql` and `20260908031000` first); every policy, trigger or function that subqueries `public.network_profiles` under the caller's rights for a FOREIGN profile (the connection-request insert path in `20260904006000`, `20261017000000`, `20261019000000`; `network_links`; the notice queue in `20261016000000`/`20261018000000`). Find all of them with `grep -n "network_profiles" supabase/migrations/*.sql` plus a live `pg_policies`/`pg_proc` scan, not just this list.
- Produces: the base table answers only its own organisation's members (`network_profiles_select_view_network` or its current equivalent). A foreign row reaches a caller only through the two views. Task 5 adds the server request mark to those same two views, so keep their WHERE clauses in one place each.

**Coordinator decisions:**
1. **Drop `network_profiles_select_published_directory`.** Move its four terms (published, live, the caller has an active membership, the presence clock disjoined with own-membership) into the two views' own WHERE clauses, unchanged. The views then read the base table with the view owner's rights (`security_invoker = false`). This is the default. It keeps both views' `pg_depend` dependency sets (N2) exactly as they are. Supabase's advisor flags definer views (lint `security_definer_view`). Record in each view's `comment on view` why this one is intentional and what its WHERE clause guarantees. Check whether `network_profiles` has `force row level security` and what the view owner's `rolbypassrls` is, and prove the view still returns rows to a foreign caller (the positive controls below). If a definer view cannot be made to work on this stack, the fallback is a `private` SECURITY DEFINER SQL function (`stable`, `set search_path = ''`) that returns the masked rows, with the views selecting from it. Record which one shipped and why.
2. **Column-level grants are not the fix.** The owner's own reads need every column, and column grants are not row-conditional. Phase 6's reason (1) still holds.
3. Every caller-rights read of a foreign profile found under Interfaces must keep working. Route each one through a `private` definer predicate (for example `private.network_profile_is_discoverable(p_profile_id uuid) returns boolean`), with the same four terms in exactly one place. The views and the predicate must not drift: assert in the suite that both give the same answer for a published, a draft, a soft-deleted and a wound-down profile.
4. The founder question: queue "F1: the network base table was readable cross-tenant over PostgREST; the views are now the only foreign read path (default: implemented)" as the next free Q in `DECISIONS-QUEUE.md`.

- [ ] **Step 1: Reproduce over HTTP before changing anything.** Fresh reset (check for other sessions first). As an unconnected counterparty with its own JWT, run the exact `GET` from the finding against the local PostgREST. Record in the report the row count and one `connections`-level value it returned. If it does not reproduce, stop and report DONE_WITH_CONCERNS with the evidence.
- [ ] **Step 2: Flip the two "by design" assertions to failing refusals.** First, LB6c: as an unconnected counterparty, `select contact_email, organisation_id, entity_id from public.network_profiles where id = <foreign published profile>` returns zero rows. Second, LEAKAGE #1a: the HTTP `GET` returns `[]`. Add the positive controls alongside them, all in the suites' own assertion style:
  - the same caller reads the profile's `network` field through `network_directory`
  - after an accepted connection, it reads the `connections` field through `network_connected_profiles`
  - the publisher's own member reads every column, `organisation_id` included, from the base table
  - the drift check from decision 3

  Move each suite's pin. Run the runner on a fresh reset: the flipped assertions are red.
- [ ] **Step 3: The fix.** The migration per decisions 1 and 3. Green on a fresh reset with the full runner ("All suites passed").
- [ ] **Step 4: Mutant.** Inside a transaction, re-create `network_profiles_select_published_directory` with its old USING clause. Both flipped assertions go red. Roll back. Record in the report.
- [ ] **Step 5: Gates.** `pnpm lint`, `pnpm typecheck`, `pnpm test` (the network integration tests read the views), `tests/e2e/network.spec.ts` plus every spec that `grep -l "network" tests/e2e/*.spec.ts` names, in groups with `--workers=1`. Then update the docs listed under Files. Commit per logical change, push.

---

### Task 20: A password chosen after the proof: close G11's residual (Q245, Critical)

Numbered 20 because it was appended after Part C was numbered. It runs **after Task 19**, before Task 2's fix phase. It implements Q245's queued default ("yes, as a follow-up remediation task"). Read G11's row in `docs/launch-gates.md`, residual (1) of the "Account pre-hijacking through invites (G11)" row in `SECURITY.md` § 10, Q245 in `DECISIONS-QUEUE.md`, and `.superpowers/sdd/2026-10-16-launch-hardening/task-4-report.md` before starting.

**The residual (measured on GoTrue v2.196.0 by Task 4):** GoTrue keeps the FIRST password on an unconfirmed re-sign-up, and confirming does not replace it. Sign up as X with P1, sign up as X again with P2, confirm with the newest link: P1 signs in and P2 does not. So if a squatter signed up first, the real owner gets an account that opens with the squatter's password. That happens whether the owner clicks the squatter's original confirmation email or signs up themselves and confirms. The squatter signs in after the owner confirms and sees everything the owner's workspaces hold. `tests/e2e/invite-pre-hijack.spec.ts` pins this today as a RESIDUAL test. This is an auth bypass, so it is graded Critical under the Phase 10 rubric. G11 stays open until this task lands.

**Files:**
- Create: `supabase/migrations/<next timestamp>_first_proof_of_an_address.sql` (the marker below), the forced set-password page and its Server Action (under `app/auth/` or `app/(auth)/`, matching where the sign-up and reset pages live), `tests/e2e/first-proof-password.spec.ts`
- Modify: `app/auth/callback/route.ts` (the `verifyOtp` branch and the PKCE `code` branch, if a sign-up confirmation can arrive through it), the sign-up Server Action in `lib/auth/actions.ts` (the same-browser binding below), `middleware.ts`/`proxy.ts` (the gate), `tests/e2e/invite-pre-hijack.spec.ts` (the RESIDUAL test flips to a refusal), `SECURITY.md` § 10 (residual 1 closed) and § 4, `docs/launch-gates.md` (G11's row: residual closed, "Closed in <sha>"), Q245's line in `DECISIONS-QUEUE.md` ("implemented in <sha>")

**Interfaces:**
- Consumes: Task 4's invite-step lookup and `accept_invite` refusal (unchanged); `verifyOtp` in `app/auth/callback/route.ts:131`; the e2e mail-catcher helpers Task 4 added to `tests/e2e/support/fixtures.ts`.
- Produces: an account's first proof of address leaves no pre-proof password alive and no other session open. A user carrying the "must choose a password" mark reaches nothing but the set-password page and sign-out.

**Coordinator decisions (defaults; record any change and why in the report):**
1. **Do not force every new user to set their password twice.** The password typed at sign-up survives confirmation only when the app can prove that the browser confirming is the browser that created the account. When the sign-up Server Action creates a NEW user, it sets an httpOnly, `Secure` (in production), `SameSite=Lax` cookie. The cookie binds the new user id to a random nonce, and the nonce's SHA-256 is stored server-side. A sign-up that returns an EXISTING unconfirmed user (a re-sign-up: compare `created_at` with the request's start, or use whatever signal Task 4 measured) sets no binding.
2. **At an address's first proof**, meaning a callback whose `verifyOtp` (or code exchange) yields a user with no first-proof marker yet: if the binding cookie matches that user, keep the password. Otherwise:
   1. replace the password with a long random one through the Admin API, which kills the squatter's P1
   2. sign out every other session (`signOut({ scope: 'others' })` from the fresh session, or the Admin API equivalent)
   3. set the "must choose a password" mark
   4. redirect to the set-password page

   Write the first-proof marker in both outcomes. This covers the sign-up confirmation, a magic link that confirms an unconfirmed account as a side effect, and invite verification (an invite-created account has no password, so the mark costs it nothing). Probe and record what GoTrue does when Google sign-in meets an address that has an unconfirmed password account. If that path confirms the account with P1 intact, it gets the same treatment in the OAuth branch.
3. **The marker** is a `private` table `private.address_first_proofs(user_id uuid primary key references auth.users on delete cascade, proved_at timestamptz not null default now(), password_kept boolean not null)`. It has no grants to `authenticated` or `anon`, and the callback writes it through the service-role client (add the call site to the service-role census). The migration backfills one row for every already-confirmed user (`password_kept = true`), so no existing account is gated. Keep "must choose a password" in `app_metadata` (Admin API), so the middleware reads it from the JWT without a database round trip, and clear it in the set-password action after `updateUser({ password })` succeeds, then refresh the session.
4. The set-password page uses the existing password-strength rules (find them in `lib/auth/`). It needs no step-up, because its session is seconds old and was minted by the proof itself.
5. **What Task 4's fix round measured (2026-10-17), which this task must cover:**
   - On a squatter's unconfirmed account, the login page's emailed sign-in link makes GoTrue send a SIGN-UP confirmation. Following it confirms the account with P1 still working, so the magic-link route is a third way into the residual. Cover it with an e2e case (c2) alongside (a) and (b).
   - GoTrue's recovery flow confirms the account and kills P1, but only once a new password is set. This app has no "Forgot password" page.
   - In the invitation-first order (invite X, then a squatter signs up X straight to GoTrue), GoTrue stores no password (e2e test 5 in `invite-pre-hijack.spec.ts`). Keep that test green.
   - The invite refusal at `lib/org/actions.ts` is now deliberately neutral ("We can't invite that address yet: it has an unfinished GetSetPaid sign-up. ...") because confirming handed the account over. Once this task's forced password makes confirming safe, the message may tell the inviter to ask the owner to finish signing up. Decide, and keep `SECURITY.md` § 15's quotation of it in step.

- [ ] **Step 1: Failing e2e** `tests/e2e/first-proof-password.spec.ts` (confirmations ON, the local mail catcher):
  - **(a)** The squatter signs up X with P1 (straight to GoTrue `/auth/v1/signup` with the anon key, as an attacker would). The owner signs up X with P2 through `/signup` in a fresh browser context and confirms from the mail catcher. Then: the owner lands on the set-password page; `/orgs` and one workspace route redirect back to it; a P1 sign-in fails (it opens the account today); the owner sets P3; P3 signs in; P1 and P2 do not.
  - **(b)** The squatter signs up X with P1. The owner clicks the squatter's original confirmation email in a fresh context. Same assertions.
  - **(c) Positive control.** A normal sign-up confirmed in the SAME browser context lands signed in, with no set-password page, and its own password works.
  - **(d)** An already-confirmed account (the fixtures' normal users) never sees the page.

  Flip the RESIDUAL test in `invite-pre-hijack.spec.ts` to assert P1 fails. Run it: (a), (b) and the flipped test are red.
- [ ] **Step 2: The fix** per the decisions. Green: the spec and `invite-pre-hijack.spec.ts`.
- [ ] **Step 3: Unit tests** for the binding-cookie check and the gate's path allowlist, wherever the codebase's unit tests for `lib/auth/` and the middleware live.
- [ ] **Step 4: Mutant.** Skip the password replacement in the callback, and (a) and (b) go red because P1 signs in. Record it. A second mutant: drop the gate's redirect, and the `/orgs` assertion goes red.
- [ ] **Step 5: Gates.** Fresh reset + full psql runner (the backfill must not disturb any suite); `pnpm lint`, `pnpm typecheck`, `pnpm test`; e2e in groups with `--workers=1`: the new spec, `invite-pre-hijack.spec.ts`, and every spec that `grep -l "signup\|sign-up\|magic\|callback\|login" tests/e2e/*.spec.ts` names. Update the docs listed under Files. Commit per logical change, push.

---

### Task 21: Owners and Admins can remove a member and change a role (audit finding 4, High)

Added 2026-10-18 from the whole-repo audit the founder ran ("fix all"). It runs **after Task 2's fix phase**, because that phase fixes F2 (an Admin can grant or remove the Owner role). Shipping this UI before F2 would hand the takeover to every Admin.

**The gap:** `app/(app)/[orgSlug]/members/page.tsx` lists members and has an invite form, and nothing else. `lib/org/actions.ts` exports only `createOrganisationAction`, `inviteMemberAction` and `acceptInviteAction`. No screen removes a member, cancels an invitation or changes a role. A Booker who leaves the company keeps reading every contact and event until someone edits the database by hand. The PRD (§ roles) gives the Owner "user/role management", and `CLAUDE.md` gives the Owner/Admin "Manage users". The database half already exists: the UPDATE and DELETE policies on `organisation_memberships` (`20260828220000`, with Task 2's F2 terms), the keep-an-owner trigger (`20261001001000`, `20261003006000`) and the `membership.*` audit triggers (`20261006000000`).

**Files:**
- Modify: `lib/org/actions.ts` (two Server Actions), `app/(app)/[orgSlug]/members/page.tsx` (the controls, shown only to a caller holding `manage_members`), one small client component under `components/org/` for the row controls
- Test: `tests/integration/org/member-management.test.ts`, `tests/e2e/members.spec.ts` (with an axe scan of the members page as an Owner)
- Docs: `SECURITY.md` § 2 (member management as built), `docs/launch-gates.md` (new row **G33, High**, "Closed in <sha>")

**Coordinator decisions:**
1. Both actions write through the caller's RLS-bound client (`createClient()`), never service-role. The policies, the keep-an-owner trigger and the audit triggers are the control. The action only maps refusals to sentences: 42501 means "you can't change that member", and the keep-an-owner refusal means "a workspace needs at least one active Owner".
2. **Remove** is the existing hard `DELETE` (audited as `membership.deleted`). The same action cancels a pending invitation, which is a `DELETE` of a `status = 'invited'` row.
3. **Change role** offers `INVITABLE_ROLES` (`lib/org/roles.ts`), plus `owner` only when the caller is an Owner. The database refuses the rest whatever the form sends.
4. No step-up at MVP. Both roles that hold `manage_members` are MFA-required, so these actions already run at aal2. Queue the founder question "does removing a member or changing a role need step-up? (default: no, aal2 already required)" as the next free Q.
5. Removal takes effect on the removed person's next request, because every read re-checks membership in the database. Do not revoke their sessions: they may belong to other workspaces.
6. Not built (name them in the report): self-service "leave workspace", ownership transfer as a separate flow, bulk actions.

- [ ] **Step 1: Failing tests.** Integration, driving the actions directly with `orgSlug` (the house pattern, see `uploadDocumentAction`):
  - an Owner removes a Booker: the row is gone, and the Booker's own client then reads 0 contacts in that workspace
  - an Admin removes a Booker
  - an Admin cannot remove or demote an Owner (refused; relies on F2)
  - the last active Owner cannot demote or remove themselves (the keep-an-owner sentence)
  - a Booker calling either action is refused, with the row unchanged
  - a foreign workspace's slug is refused
  - cancelling a pending invite deletes the row

  e2e: an Owner removes a member through the UI, and that member's next page load in the workspace gets the streamed not-found contract (`DESIGN.md` § Error pages). Red first.
- [ ] **Step 2: The actions and the controls.** Follow `DESIGN.md`. The remove button uses the existing delete-confirmation pattern (focus round-trip, as in `keyboard.spec.ts`).
- [ ] **Step 3: Mutant.** Swap the action's client for the service-role client, and "a Booker calling either action is refused" goes red. Record it.
- [ ] **Step 4: Gates.** `pnpm lint`, `npx next typegen`, `pnpm typecheck`, `pnpm test`, the new e2e spec plus `tenant-breakout.spec.ts` and `accessibility.spec.ts` with `--workers=1`. Update the docs. Commit per logical change, push.

---

### Task 22: Sign out everywhere (audit finding 7, High)

Runs right after Task 21.

**The gap:** `SECURITY.md:198` says "Active-session listing with remote revocation is available to every user." Nothing of the kind exists. `signOutAction` (`lib/auth/actions.ts:359`) ends only the current browser (`scope: "local"`), and its own comment calls "sign out everywhere" a separate action that was never built. PRD § 6.1 asks for "Session management screen showing active sessions/devices with remote revocation". Case: a laptop stolen while signed in stays signed in for up to 12 hours (the timebox), and the user has no way to end it.

**Files:**
- Modify: `lib/auth/actions.ts` (`signOutEverywhereAction`), one account page to host the button (the account area today is `/account/privacy`, `/account/data-requests`, `/account/erase` and `/account/exports`; put it where the account nav makes it findable, and add a nav entry only if no page fits), `SECURITY.md` § 4 (line 198 rewritten to the as-built), `docs/launch-gates.md` (new row **G34, High**)
- Test: `tests/integration/session/sign-out-everywhere.test.ts`, and an e2e case in `tests/e2e/keyboard.spec.ts` or a new small spec

**Coordinator decisions:**
1. `signOutEverywhereAction` calls `supabase.auth.signOut({ scope: "global" })` and redirects to `/login`. It needs no step-up, because signing out cannot harm the account.
2. The per-device LIST is not built at MVP. Reading `auth.sessions` needs a definer RPC and a page, while the button alone answers "a device was stolen". Queue the founder question "is Sign out everywhere enough for PRD § 6.1's session screen at MVP? (default: yes, the device list is deferred)". Rewrite `SECURITY.md:198` to say exactly that.
3. State the residual in § 4: an access token already issued stays valid until it expires (`jwt_expiry` in `supabase/config.toml`; read the value). Only refresh is revoked.

- [ ] **Step 1: Failing tests.** Integration: sign the same user in twice (two clients), call global sign-out from one, and the other's `refreshSession()` fails (`refresh_token_not_found` or the pinned GoTrue's equivalent). e2e: two browser contexts signed in as one user; context A clicks "Sign out everywhere"; context B's next navigation after its access token is refreshed lands on `/login`. Use the fixtures' existing way to force a refresh if there is one, otherwise assert at the integration layer only and say so.
- [ ] **Step 2: The action and the button.**
- [ ] **Step 3: Mutant.** Change `global` to `local`, and the integration test goes red.
- [ ] **Step 4: Gates.** lint, typecheck, `pnpm test`, the touched e2e spec. Docs. Commit, push.

---

### Task 23: The storage quota is enforced (audit finding 11, Medium), plus the custom-field limit race

**The gap:** `subscription_plans.storage_limit_gb` (5 for Starter, 20 for Pro, `20260826151656_foundation_schema.sql:130`) is read by nothing except the tier tests and the health page. `uploadDocumentAction` (`lib/crm/documents.ts:148-170`) stores bytes with no quota check. One Starter user can upload 10 files of 25 MiB per hour, about 6 GiB a day, and nothing refuses. `SECURITY.md:246` relies on this quota as the bound on upload abuse.

**Files:**
- Create: `supabase/migrations/<next timestamp>_storage_quota_is_enforced.sql`
- Modify: `lib/crm/documents.ts` (map the new refusal to a sentence), a psql suite (the documents/file suite that already covers `public.documents`, with its pin), `SECURITY.md` § 5 (line 246) and § 6, `docs/launch-gates.md` (new row **G35, Medium**)
- Test: the psql assertions, and `tests/integration/documents/upload-quota.test.ts`

**Coordinator decisions:**
1. **One `BEFORE INSERT` trigger on `public.documents` is the control.** It binds every writer, and `uploadDocumentAction` already removes the stored bytes when the row insert fails. The trigger:
   - takes `pg_advisory_xact_lock` on the organisation, so two parallel uploads cannot both pass the last free bytes
   - compares the workspace's existing `size_bytes` total plus `new.size_bytes` against the EFFECTIVE plan's limit (`private.effective_organisation_plan()`, so billing overrides count)
   - raises 42501 with hint `storage_quota_exceeded` when the total would pass the limit
   
   Count soft-deleted documents too, because their bytes stay until the retention sweep (Q52). A NULL limit means unlimited.
2. No app-side pre-check. An over-quota upload still sends its bytes to Storage once and then removes them, which is bounded by the 10-per-hour upload budget. Mark this in the action with `shortcut: an over-quota upload transfers its bytes once before the refusal, bounded by the 10/hour budget; add a pre-check RPC if storage egress cost shows up`.
3. A downgrade never deletes. An organisation over its new limit keeps every file, and only new uploads are refused. Feedback screenshots and export archives are not counted (they are platform-scoped and short-lived).
4. **The custom-field limit race, in the same task:** `private.enforce_custom_field_limit()` (`20260829010500`, whose header says "IT DOES NOT SERIALISE") gets the same per-organisation advisory lock before its count. Rebuild it from the live `pg_get_functiondef`.

- [ ] **Step 1: Failing tests.** psql: a Starter workspace at (limit − 1 byte) inserting a 2-byte document is refused with the hint; at the limit exactly, a 0-byte insert is accepted; a Pro workspace (or a billing override to Pro) is accepted; a soft-deleted document still counts. Integration: the real `uploadDocumentAction` over quota returns the quota sentence, and neither a row nor an object remains. Red first.
- [ ] **Step 2: The migration and the sentence.**
- [ ] **Step 3: Mutants.** Drop the trigger, and the psql refusal goes red. For the lock: if a concurrent test in the house style (see the rate-limit concurrency test cited in `20260909090000`) can show the race without the lock, use it as the mutant. Otherwise assert the lock's presence from `pg_get_functiondef`, and say so in the report.
- [ ] **Step 4: Gates.** Fresh reset + full psql runner, lint, typecheck, `pnpm test`, `documents.spec.ts` with `--workers=1`. Docs. Commit per logical change, push.

---

### Task 24: Any export, any size: build every export in parts (audit finding 12, Medium)

**The gap:** an ordinary export is one zip under a 40 MiB ceiling (`private.export_limits()`), and passing it FAILS the job (`lib/export/runner.ts`, `lib/export/zip.ts:323`). A workspace export carries every clean document's bytes, so two 25 MiB riders make every export of that workspace fail. An account export carries the person's feedback screenshots (up to 5 MiB each, 10 an hour), so a heavy feedback submitter's statutory access export can fail for ever. Q228 already built a parts builder for closure backups (`lib/export/parts.ts`, `20261101000000`, spec `docs/superpowers/specs/2026-10-10-closure-backup-parts-design.md`).

**Files:** `lib/export/runner.ts`, `lib/export/parts.ts`, a migration widening the closure-only checks in `20261101000000` (`export_jobs_part_count_shape`, the running→queued transition, `export_job_parts` inserts) to every kind, the download pages that today show one archive (`app/(app)/account/exports/[jobId]`, `app/(app)/[orgSlug]/settings/export`), and their tests: `tests/e2e/exports.spec.ts`, `closure-backup-parts.spec.ts`, and the export integration and unit tests.

**Coordinator decisions:**
1. Read the Q228 spec first. Prefer making parts the ONLY build path for every kind, if that gives the smaller diff (one path instead of two). Otherwise route the workspace and account kinds through the existing parts path. Record which, and why.
2. The per-part ceilings stay exactly as declared (`private.export_limits()`). The number of parts is uncapped, as for closure backups. A single file larger than an empty part is still a refusal, as Q228 states.
3. Fold in the mislabel: `addDocumentBytes` records a storage read failure under reason `document_not_clean`. Give it its own reason (for example `document_unreadable`), in the TypeScript contract and the manifest copy.
4. The DSR fulfilment seam (`recordFulfilment`) records the job, not a part. Keep it that way.

- [ ] **Step 1: Failing tests.** Integration: a workspace export whose clean documents total more than one part's ceiling (lower the ceiling through the test override `effectiveLimits` already honours, rather than uploading 40 MiB) SUCCEEDS with two or more parts. Every part is a valid zip, and the last part's manifest indexes them all. Same for an account export with screenshots. Unit: an unreadable object is withheld as `document_unreadable`. Red first.
- [ ] **Step 2: The change.**
- [ ] **Step 3: Mutant.** Restore the fail-at-ceiling branch for the workspace kind, and the workspace test goes red.
- [ ] **Step 4: Gates.** Fresh reset + full psql runner (the export suites), lint, typecheck, `pnpm test`, `exports.spec.ts` and `closure-backup-parts.spec.ts` with `--workers=1`. Update `SECURITY.md` § 3's "Exports are async and bounded" paragraph and `docs/launch-gates.md` (new row **G36, Medium**). Commit per logical change, push.

---

### Task 25: One runner credential check, not four (audit finding 15, Low, lean)

**The gap:** `app/api/exports/run`, `app/api/erasure/run`, `app/api/retention/run` and `app/api/incident-alerts/deliver` each copy `configuredSecret()`, `bearerMatches()` and the 404 refusal. That is security code that must change together.

**Files:** create `lib/security/runner-auth.ts`, exporting `refuseUnlessRunner(request: Request, envName: string): NextResponse | null`; modify the four routes; test with `tests/unit/security/runner-auth.test.ts`. Keep `tests/unit/email/delivery-route.test.ts` and `tests/unit/security/public-paths.test.ts` green unchanged.

- [ ] **Step 1: Failing unit test:**
  - secret unset → 404
  - secret shorter than 32 characters → 404
  - no `Bearer ` prefix → 404
  - wrong secret → 404, including one of a different length
  - right secret → `null`
  - every refusal carries `Cache-Control: no-store`
- [ ] **Step 2:** Move the code into the helper verbatim, and replace each route's copy with one call. Each route keeps its own env name, and its header comment loses only the paragraph restating the shared credential rules, which moves to the helper once.
- [ ] **Step 3: Mutant:** make the helper return `null` always, and the refusal cases go red.
- [ ] **Step 4: Gates.** lint, typecheck, `pnpm exec vitest run tests/unit`. Commit, push.

---

## Part C — close the phase

### Task 17: Founder actions and the final gate document

- [ ] Queue each founder action from `docs/launch-gates.md` § "Founder actions" as one numbered question from Q244 in `DECISIONS-QUEUE.md`, with its lead time and default ("founder to book/sign/register; launch blocked until done").
- [ ] Re-run every gate's re-measure command, update each row's status and date, commit, push.

### Task 18: Final whole-branch review, then the PR

- [ ] Dispatch an independent reviewer over the whole branch range with the five gates to reproduce; fix Critical/Important findings; then open the Phase 10 PR (base `q228-closure-backup-parts` while #32 is open, `main` once it merges).

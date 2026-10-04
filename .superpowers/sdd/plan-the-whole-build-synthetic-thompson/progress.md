# SDD ledger — plan: C:\Users\archi\.claude\plans\plan-the-whole-build-synthetic-thompson.md

Phase 8 — Legal/Privacy. Worktree `.claude/worktrees/legal-phase`, branch
`worktree-legal-phase`, BASE `9e8e292` = the Phase 7 tip (PR #25, open,
unmerged — so this phase's PR targets `worktree-admin-phase` until #25
merges, then rebases onto `main`). 126 migrations at base.

Phase 7's ledger stays in the admin-phase worktree. Its lessons carry over
and are binding here (see "Standing lessons" at the bottom).

## Inputs

Inventory report (2026-09-16) established, among other things:
- **Nothing of Phase 8 exists**: no legal routes, no `consents`, no
  `data_subject_requests`, no cookie UI, no export, no erasure.
- **Deleting an `auth.users` row is BLOCKED for almost every real user.**
  No-ON-DELETE foreign keys: `audit_events.actor_user_id` (everyone who
  ever wrote a CRM row, accepted an invite or created an org),
  `merges.merged_by`, `merge_candidates.resolved_by`,
  `impersonation_sessions.{superuser_user_id, admin_accepted_by,
  declined_by}` (ORDINARY CUSTOMER ADMINS), `organisation_*_overrides.
  {granted_by, revoked_by}`, `incident_alerts.resolved_by`. FOLLOW-UPS
  already says the audit/merge columns are ONE decision: anonymise, not
  delete.
- Erasure ordering traps: `custom_field_values` is polymorphic with no FK,
  so it must be swept BEFORE its entity (all six entity types);
  `merges.field_resolution` holds a discarded record's values verbatim;
  a private note whose owner is set null becomes unreadable by everyone
  but is still stored — it must be hard-deleted; document bytes survive a
  soft delete (Q52); DSR export must include soft-deleted rows.
- No member removal, no self-delete, no last-owner guard exist anywhere.
- `PUBLIC_PATHS` (`lib/supabase/middleware.ts:37-43`) must gain the legal
  routes or they redirect to /login.
- All browser storage today is strictly necessary (Supabase auth cookies,
  `gsp_current_org`, the idle-timeout localStorage key,
  `gsp:sidebar-pinned`); no analytics.
- Reusable: the lifecycle correlation-thread + one-summary-row pattern
  (`20260908030000:320-355`, and SECURITY.md:182 says Phase 8's purge and
  DSR erasure must reuse it); `pg_cron`/`pg_net` already in use;
  `private.organisation_retention_days()`,
  `private.feedback_retention_cutoff()`; step-up helpers in `lib/auth/`;
  the `exports` rate budget (5/hour/org, "mechanism built, no endpoint").
- **The master plan's Phase 8 list omits all retention/GC work** that the
  Phase 7 queue routed here (Q52, Q110, Q120, the audit 30d/1y purge,
  Q88's 60-day org purge, the Q117 incident-alert purge) and Q122. Added
  below as extra-plan tasks; the augmentation is plan-consistent, not a
  contradiction (noted per SDD pre-flight).

## Task order

- **Task 1 (plan 1): versioned legal documents + the 15 public pages.**
  Counsel-editable without a deploy (Q128), every page visibly a DRAFT
  until counsel signs its version off, signed-out reachable, footer-linked.
- **Task 2 (plan 2+3a): consents + the storage census.** `consents` table
  (timestamp, policy version, mechanism, technical context), marketing
  preferences as withdrawable consent, NO cookie banner (Q129) but a
  census that fails the moment non-essential storage appears.
- **Task 3 (plan 3b+4): data subject requests.** Schema + RLS (own data +
  superuser metadata-only oversight), submit/track UI, fulfilment
  workflow with a real 30-day `due_by`, overdue surfaced to the operator,
  the controller/processor split made explicit (Q132).
- **Task 4 (plan 5a): account export.** Async, bounded, step-up gated,
  on the `exports` budget; every table in the inventory including
  soft-deleted rows; delivered through the private-bucket pipeline.
- **Task 5 (plan 5b): account erasure.** The tombstone anonymisation
  (Q130), the last-owner guard (Q131), the ordering traps above, bytes
  purged, one correlation thread + one summary audit row.
- **Task 6 (extra-plan, routed by Phase 7): the retention/GC job.**
  pg_cron-scheduled: Q52 document bytes, Q110 counters, Q120 feedback +
  screenshots, the audit 30d-hot/1y purge, incident alerts (Q117), Q88's
  60-day org purge. Periods pending counsel (Q133).
- **Task 7 (extra-plan, Q122): CRM write auditing for the Phase 3–6
  tables.** Before launch (Q134).
- **Task 8 (plan-implied): Phase 8 permission tests.** Extend the Phase 7
  matrix and censuses to every surface this phase adds, with positive
  controls and a red mutation.

## Standing lessons (from Phase 7 — binding)

1. **The denominator is invisible.** Four Phase 7 tests passed because
   their subject was never exercised. Before asserting anything, prove the
   subject is rendered / reached / non-empty. Ask of every assertion:
   what would make this pass while the thing is broken?
2. **Mutation-test every guard** and record which assertions went red,
   across which layers.
3. **Record the MIGRATION COUNT before and after every long run** — a
   sibling's `db reset` does not restart the container, so `StartedAt`
   will not catch a schema swap.
4. **Rebuild a function from its LATEST definition**, never from the
   migration that created it (Phase 7 lost a check that way twice).
5. **Committed migrations are immutable**; correct a header by reissuing
   `comment on`. `pg_catalog.<construct>` is a trap (CI guard exists).
6. **Enforce at the chokepoint every writer passes** (a BEFORE trigger /
   the DB), never only in a server action.
7. **Attribution must be non-forgeable by construction.**
8. **Docs drift is a finding.** Every task corrects the CLAUDE.md /
   SECURITY.md / FOLLOW-UPS sentences it makes false, with measured
   counts.
9. Shared stack: ports 3000–3010 (`:300[0-9]\s`), no playwright/vitest
   anywhere, own orphans killed; curl the API after any docker restart;
   e2e detached and polled; kill background jobs before reporting.
   See memory `shared-local-supabase-stack`.

## Progress

- **Task 1 implemented (2026-09-16)**, commits 9e8e292..23a7ec6 on
  worktree-legal-phase (pushed). Migrations 126 → 129 (20260922000000 store,
  001000 seed, 002000 set_updated_at). Gates: lint and typecheck clean; RLS all
  16 psql suites pass (legal 137/0), HTTP 378/0; vitest 120 files / 2476 tests.
  **e2e was NOT completed**: 150 listed, stopped at 16/150 with 0 failures when
  the hand-back was forced. legal.spec.ts and super-permissions have not run.
  Mutations: guard 24/137 psql red and 0 in the matrix; policy 11/137 psql red
  and 8/290 in the matrix. Census hole fixed: column-level grants were
  invisible. New questions Q136–Q141. See task-1-report.md.

- Task 1 fix round 1: 52088d0..3c7645a; gates 1-3 green (legal 157/0, HTTP 378/0, 132 migrations); gates 4-5 owed (handback forced).
- Task 1 fix round 2: 13141f0..7ab1922; gates 1-4 green (legal 159/0, HTTP 378/0, vitest 123/2594, 133 migrations); gate 5 started, 21/150 ok with 0 failures, stopped at forced handback -- OWED.
- **Task 1 review → fix round 1 → scoped re-review → fix round 2.** Review
  was MAJOR (I1 editor lost every success message → e2e 149/150; I2 the
  Security page stated hosted-config controls as fact). Fix round 1
  `52088d0..3c7645a` closed I1/I2 and M2-M9; re-review MINOR (gates 4/5
  finally green, 300k-body differential fuzz agreed across all three
  placeholder layers) but found a SECOND quadratic regex on the public
  render path and the public site contradicting itself. Fix round 2
  `13141f0..7ab1922` (migration 20260922006000, 132→133): four more
  backtracking regexes replaced by linear helpers, each proven by a timing
  mutation (4-6 s red); Subprocessors v2 + Privacy/DPA v3 with one
  consistent "(deployment setting)" treatment; stale outcome message on a
  throw; repeated outcomes re-announced. Q145/Q146 queued.
- **Task 1: COMPLETE (tip 7ab1922).** Gate 5 run by the coordinator on
  7ab1922 after a fresh reset: **150 passed (16.6m), exit 0, 133 → 133
  migrations.** Gates 1-4 from fix round 2: lint/typecheck clean; RLS all
  passed, legal 159/0, HTTP 378/0; vitest 123 files / 2594. **Fix round 2
  was not independently re-reviewed — cover it in the Phase 8 final
  review.** Known pre-existing flake M10 (rate-limit-network-discovery
  20s timeout) untouched. Next: Task 2.

- **Task 2 implemented (2026-09-16)**, commits 7ab1922..9b0a8b9 (pushed).
  Migrations 133 -> 135 (`20260923000000` consents, `20260923001000`
  marketing-preferences v2). Gates: lint/typecheck clean; RLS all passed
  (17 psql files; legal 161/0, consents 117/0), HTTP 390/0; vitest 128 files
  / 2662; e2e 152 passed; 135 -> 135 on every run. Mutations: attribution
  guard 15/117 psql red, own-row policy 6/117 psql + 5/311 matrix, append-only
  guard 11/117; storage census 3/1/1 unit red (new key / next/script /
  undeclared dependency), browser census red on an injected cookie and key.
  Browser census found Next's dev-only `__next_debug_channel` IndexedDB
  (excused only while absent from prod runtimes). Q147-Q153. Not
  independently reviewed yet. See task-2-report.md.
- Task 2 fix round 1: 9b0a8b9..f239ed7 (I1 AST source census over every shipped file; I2 guard requires the account gone; M1 wording pinned in DB; M2 unique withdraws_id + real RR race; M3 LI22/LI23 name their raiser; M4 parsed sender census + direct-provider check; M5 browser census widened; M6/M8 docs; M7 reserved workspace slugs). Migrations 135 -> 139. Gates 1-4 green (foundation 156/0, legal 162/0, consents 143/0, HTTP 390/0, race green; vitest 129/2741). Gate 5: 152 passed (15.4m), 139 -> 139. See task-2-report.md "Fix round 1". Q154, Q155 new; Q148 corrected; Q151 done.
- Task 2 fix round 2: `f239ed7..c545f7e` (migration 20260923006000, 139 -> 140) closed the scoped re-review's eight minors. N2: the workspace-slug grammar is enforced on every write by the re-created trigger, with reserved names compared on an NFKC/trim/lower key (25 new psql assertions, § W16-W40, covering every input the reviewer got accepted; foundation 156 -> 181). N7: Q154's pre-launch query uses that same key. N8: both catalogue bindings (and the reserved list) read each function's latest definition through a parsed, ordered walk of the migrations, bound to `pg_proc.prosrc` by a new integration test. N4: top-level metadata route files (Next's own classifier) and intercepting folders count as top-level routes; nothing new is reserved. N3: the email provider's host is matched case-insensitively. N1/N5/N6: cross-module `cookies` re-exports, destructuring/for-of writes, Object/Reflect writes on `document`, `Function()` without `new`, non-function timer arguments and runtime-built header names are all found (the last declared one real site in the middleware); the census fails on any parse diagnostic; `server-only` is checked through the compiler API plus a client-component reachability walk. Nine mutations red, each reverted. Gates: lint/typecheck clean; RLS all passed (foundation 181/0, legal 162/0, consents 143/0, HTTP 390/0); vitest 130 files / 2771; e2e 152 passed (16.0m); 140 -> 140 on every run. Q156 new; report's 10/70 corrected to 10/73.
- **Task 2: COMPLETE (tip c545f7e, 140 migrations).** Review -> fix round 1
  -> scoped re-review -> fix round 2, all five gates green at the tip.
  **Fix round 2 was not independently re-reviewed** (same as Task 1's) --
  the Phase 8 final review must cover BOTH `13141f0..7ab1922` and
  `f239ed7..c545f7e`. Next: Task 3 (data subject requests).

- **Task 3 implemented (2026-09-18)**, commits `c545f7e..33e906a` on
  worktree-legal-phase (pushed). Migrations 140 -> 144 (`20260924000000`
  data_subject_requests + notes + state machine + 4 RPCs, `20260924001000`
  the two deadline alert types and the SAME cron job re-pointed,
  `20260924002000` Data Subject Rights v2, `20260924003000` a comment-only
  correction). All five gates green at the tip: lint/typecheck clean; RLS all
  passed (18 psql files; foundation 181/0, legal 162/0, consents 143/0,
  **data subject requests 113/0**), HTTP **404/0**; vitest **131 files /
  2861**; e2e **155 passed (15.9m)** in 25 files; 144 -> 144 on every run.
  Mutations: attribution guard 7/113 psql red (and the finding that the
  INSERT POLICY, not the grant, is the gate); transition table 5/113; the
  who-may-do-it check **0/110 -- a real hole**, closed by DT13a/b/c, which the
  same mutation now reds 6/113; notes-privacy policy 2/113. Gate 3's first run
  was red in three kinds of way and gate 4's in one (an audit-action census I
  had not found); gate 5's first run found a REAL product bug -- the
  withdrawal confirmation was rendered by a component the revalidated page
  removed, so nobody ever saw it (Task 1's I1 on a new surface). Q157, Q158
  new. Not independently reviewed yet. See task-3-report.md.
- **Task 3 review 2026-09-18: MAJOR** (0 Critical / 7 Important / 9 Minor);
  all five gates reproduced at the tip, e2e 155 (first run AT the tip).
  Core held under real attack: attribution non-forgeable three layers deep,
  every illegal transition refused from every principal, notes privacy holds
  over PostgREST, no free text in any audit or alert payload, rate limit
  enforced at the DB, the Phase 7 cron command preserved verbatim.
  Importants: I1 the fulfilment-seam guard is DEAD CODE (`row_security_active`
  never fires in a definer trigger; the suite stayed 113/0 with it deleted, and
  DF9 passed only because a grant was absent); I2 both delete guards carry
  Task 2's pre-fix `pg_trigger_depth() < 2` shape (a throwaway trigger emptied
  the register with the account alive); I3 `dsr_overdue` fires once ever — a
  resolved alert leaves an open request forgotten (measured 75 days overdue,
  0 alerts); I4 the routed-org FK's ON DELETE SET NULL can never execute, which
  will block Task 6's 60-day purge; I5 one boolean guards both export and
  erasure jobs, and the seam-only early return skips every later invariant
  (terminal stamps were movable as postgres); I6 the operator never sees the
  reject/fulfil confirmation — THIRD instance of the unmounted-outcome bug, and
  neither transition had browser coverage; I7 "Pass it on" claims a delivery
  the product never performs.
- **Coordinator rulings (recorded in DECISIONS-QUEUE.md):** **Q158 CHANGED**
  from cascade to **keep-the-register-row-anonymised** — under cascade the
  erasure job deletes the row its own outcome must be recorded against, and the
  request plus outcome is the evidence a statutory deadline was met; Task 5
  re-points to the Q130 tombstone and clears email/detail/reason. **Q159** =
  uniqueness among UNRESOLVED alerts only + weekly re-raise while open +
  auto-resolve on close. **Q160** = the routing form says in words that nothing
  is sent, shows the resolved workspace NAME before the write, and requires a
  handover note; the requester copy names the business; `routed → routed` is
  allowed so a mistake is correctable; step-up the day routing notifies
  in-product.
- **Task 3 fix round 1: INTERRUPTED** (session limit, 2026-09-19). Four
  migrations and the shared outcome component were on disk uncommitted;
  preserved in LOCAL-ONLY WIP commit `e1f7f7e` (NOT pushed — branch remains at
  `33e906a`, 144 migrations pushed, 148 on disk and in the DB).
  `20260925000000` register integrity, `001000` delete guards, `002000` alert
  re-raise/auto-resolve, `003000` bounded note reads, plus
  `components/ui/action-outcome.tsx` (the shared fix for I6's bug class).
  **Resume by continuing the fix round on top of `e1f7f7e`**, or
  `reset --soft 33e906a` to redo it. Still owed: all five gates, and the M10
  flake root-cause (`rate-limit-network-discovery`, 20 s timeout, cost two
  phases a re-run).
- **Briefs written ahead (2026-09-19):** `task-4-brief.md` (export — two
  exports per Q132; async, bounded, private bucket, completeness census derived
  from the catalogue, another member's private notes must NOT appear in an
  Owner's export, wakes the export half of the DSR seam), `task-5-brief.md`
  (erasure — Q130 tombstone, Q131 last-owner guard, the ordering traps, wakes
  the erasure half), `task-6-brief.md` (retention/GC — ONE cron job, every
  period in one declared place, the audit purge treated as the most dangerous
  code in the phase, calls Task 5's primitive rather than reimplementing it),
  `task-7-brief.md` (Q122 audit for Phase 3–6 tables — structural columns only,
  a sentinel no-leak test per table), `task-8-brief.md` (permission tests —
  mutation-test every guard; a guard whose removal reds nothing is a CRITICAL
  finding, not a gap).
- **Task 3 fix round 1 CODE-COMPLETE 2026-09-19/20, gates NOT run** (a peer
  session held the shared stack and port 3000 for a live demo all session).
  Branch `worktree-legal-phase` pushed at `28e6d21`: the WIP commit `e1f7f7e`
  was re-committed as ten logical commits (`1e3b976..28e6d21`), 149
  migrations on disk against a live DB at 148 — `20260925004000` (rights page
  v3) is unapplied anywhere, which is expected. Closed I1-I7 and M1-M9; M10 is
  diagnosed by reading with a precedented fix proposed and NOT applied (the
  test sleeps up to 25 s inside its own 20 s timeout; the sibling
  `connection-request-budget.test.ts` already does it from `beforeAll` with an
  explicit hook timeout, and `feedback-budget.test.ts:149` has the same bug).
  **Owed:** all five gates, the psql per-suite counts after a reset, and the
  mutation runs (the seam guard must now go red where it was 0/113).
  `task-3-report.md` § "Fix round 1" has the detail and every number that
  could not be measured. Q161 queued.

- **Task 3 fix round 1 GATES RUN AND GREEN 2026-09-20** (the peer session
  released the shared stack). Branch `worktree-legal-phase` at `e19083d`, 149
  migrations on disk and applied, count unmoved across every run. All five:
  lint clean; typegen + typecheck clean; psql **18 suites / 2 985 assertions /
  0 failed** plus **409 HTTP PASS / 0 FAIL**; `pnpm test` **133 files / 2 910
  tests**; `pnpm test:e2e` **155 passed** cold. Mutations: the fulfilment-seam
  guard is **5/216 red** where the review measured 0/113 (I1 closed); both
  delete guards **12 red**, with the throwaway-trigger attack refused 42501 and
  a guards-dropped denominator emptying the register 4 → 0; terminal stamps and
  routing on an open row refused (22023); Q159 re-raise and auto-resolve 9/9.
  **M10 root-caused by measurement and the reading was half wrong:** the burst
  costs 1.0–1.2 s wherever it runs, so the sleep-in-a-test was the whole flake;
  both files now take the wait in a `beforeAll` with an explicit hook timeout,
  the head-room is measured rather than guessed, and five consecutive
  integration runs are green. **Two real defects the gates found:** the legal
  suite never counted the rights page's version 3 (four fixtures and one HTTP
  check), and — the one that mattered — `lib/dsr/admin-actions.ts` carries
  `"use server"` and this round gave it two `const` exports, so Next dropped
  EVERY export from the module and `/super/data-requests` did not compile;
  lint, tsc and 2 910 unit tests all passed over it. The constants moved to
  `lib/dsr/contract.ts` and
  `tests/unit/forms/use-server-exports-census.test.ts` (33 modules) is the
  census that bug class earned.

- **Task 3 fix round 2 (2026-09-20).** The independent scoped re-review of fix
  round 1 graded it MINOR — all eighteen original findings verified closed, by
  the reviewer's own mutations rather than by reading the report — and found
  2 Important and 7 Minor new defects. Fixed in the reviewer's recommended
  order. **R2** first, because it protects every later task and Task 8 is
  about exactly this bug class: the `"use server"` census matched the
  directive WITH its semicolon, so dropping the semicolon (valid, and what
  Next accepts, and no Prettier runs in any gate) took a file out of the
  census entirely and the suite went green with a planted export — 34 tests to
  33, unnoticed, because the only denominator was `> 20`. It now tolerates the
  semicolon, sees an indented export, and **pins its membership to a literal
  roll**, so a file LEAVING is red; ten planted export shapes, three of which
  the old census passed. **R1**, a regression of the finding it closed: Q159's
  7-day re-raise decides on `incident_alerts.resolved_at`, `authenticated`
  holds a column-level UPDATE on it and the app filled it from the operator's
  BROWSER clock, so one resolution dated 2999 put an open request back at
  "75 days overdue, 0 unresolved alerts" — the original I3 sentence verbatim.
  The guard now stamps `now()` for every client resolution (`20260926000000`),
  the action stops sending the column, and § DD grows six assertions with a
  denominator proving the column still takes a future value from a session the
  guard exempts. Then **M-R7** (a one-week snooze and a system closure both
  read "resolved" on /super/health; the row now says which), **M-R6** (the
  report claimed a binding between the alert-type labels and the database
  CHECK that did not exist — built rather than softened), **R3** (the routing
  confirmation compared two fields of the SAME POST and bound the typed slug,
  not the resolved organisation id; it is now a server-minted HMAC token over
  the request and the organisation), and the documentation Minors M-R1
  (decided: Task 4 adds the `service_role` grant, column-level, and rewrites
  the guard's closed-list role leg — written into its brief), M-R3 (Task 6's
  purge must never run under `session_replication_role = replica`, written
  into the inventory and that brief), M-R4 and M-R5. Q162 and Q163 queued with
  their shipped defaults.
- **Task 3: COMPLETE (tip `30e18e7`, 150 migrations).** Implement -> review
  (MAJOR) -> fix round 1 -> scoped re-review (MINOR, all 18 closed by the
  reviewer's own measurement) -> fix round 2 (all 9 closed). All five gates
  green at the tip: 18 psql files / **2991 assertions** / 0 failed, API
  **409 PASS / 0 FAIL** (DSR suite 113 -> **222**); vitest **135 files /
  2952**; e2e **155**; 150 -> 150 around every long run.
  Fix round 2 `0a3dc58..30e18e7` (5 commits, migration `20260926000000`):
  **R2** the `"use server"` census could not see its own subject (the regex
  required the directive's semicolon) — now matches `\s*;?`, trims indented
  export lines, and **pins a 33-file membership roll** so a file LEAVING is
  red; ten planted shapes, the three previously-missed ones now caught.
  **R1/Q162** the Q159 re-raise read `incident_alerts.resolved_at`, which
  `authenticated` could write and which the BROWSER supplied — the guard
  now overwrites it with `now()` (corrects rather than refuses, so a skewed
  laptop still resolves); 6 new § DD assertions including a denominator that
  proves the pin and not the column; mutation = 2 red. **M-R6** the claimed
  label-map-to-CHECK binding did not exist — built it against the live
  catalogue (mutation 1 red each for three types). **R3/Q163** the routing
  interlock is now a server-minted HMAC token over (requestId, organisationId)
  with a 15-min TTL that fails CLOSED, not two fields of one POST; the old
  same-POST gate reds 2, binding to the typed slug reds 1. M-R7, M-R4, M-R5
  done. **M-R1 DECIDED: do not grant `service_role` UPDATE now** — a grant
  with no consumer is a standing write path on the table this task spent a
  round making unwritable; Task 4 adds it column-level, rewrites the guard's
  closed-list role leg, and adds a § DF positive control (written into
  `task-4-brief.md`). **M-R3** the no-`replica` rule written into
  `phase-8-inventory.md` and `task-6-brief.md` § Constraints.
  **PROCESS WARNING worth keeping:** the fixer nearly reported a false gate 5
  — a `gate5.log` left in the scratchpad by ANOTHER session, dated two days
  earlier, held a plausible "155 passed" while its own run had not yet
  redirected. **Check the mtime of any log you did not watch being written.**
  Next: Task 4 (export).

- **Task 4 implemented (2026-09-20)**, commits `30e18e7..53507a5` (16 commits,
  pushed). Migrations 150 → **159** (`20260927000000` catalogue + permission
  key + limits, `001000` the register/bucket/budgets, `002000` the read
  engine, `003000` the DSR seam wakes + the `service_role` two-column grant +
  the guard's inverted role leg, `004000` the runner's clock folded into the
  ONE cron tick, `005000` the download audit RPC, `006000` the plan and the
  ceilings, `007000` **the corrective one** — `SET role` is refused inside a
  `SECURITY DEFINER` caller, so the shipped read-as-the-requester mechanism
  could not run at all; replaced by a function owned by `export_reader`, a
  role that is a member of `authenticated`, owns no table and has no
  `BYPASSRLS` — `008000` three new unreviewed legal versions).
  **All five gates green at the tip**, 159 migrations before and after every
  long run: lint clean; typegen + typecheck clean; psql **19 files / 3122
  assertions / 0 failed** plus **API 409 PASS / 0 FAIL**; `pnpm test`
  **139 files / 3037 tests**; `pnpm test:e2e` **158 passed (28.5 m)** cold.
  Permission matrix **368 → 398**.
  **Ten mutations**, each on a fresh reset: the sessionless-insert refusal
  1/124; the INSERT grant widened to the table 8/124; the permission check
  2/124; the job-progress server-only leg **0/121 → 2/124 once XJ1b existed**;
  the download IDOR term 4/124; the expiry gate 2/124; the read engine's
  server-only leg 1/124; **the DSR seam's inverted role leg 1/124 + DF9a–DF9e
  5/225**, which is exactly what the brief asked to be measured; the inner
  read function re-owned by `postgres` 2/124 (a colleague's private note
  appears); one table removed from the catalogue 9/124 + 3/13 in the census.
  **Two defects this task found in itself and the mechanism that found each:**
  the read engine could not run at all and every "X is absent from the export"
  assertion passed — XP2, the positive control, is what went red; and the
  job-progress guard reddened NOTHING under mutation, because every assertion
  aimed at it was answered by a missing privilege (the `row_security_active()`
  class, found by mutation rather than review). Q164–Q166 queued.
  **PROCESS: the stale-log trap fired for real.** Gate 4's first read was of a
  `/tmp/gate4.log` four hours old and left by another session, reporting a
  plausible "134 files / 2944 tests"; the mtime caught it. Every gate above
  was read from a log whose mtime is inside its own run.
  Not independently reviewed yet. See `task-4-report.md`.

- **Phase 8 Task 4 — export. FIX ROUND 1, 2026-09-21.** Review verdict MINOR
  (0 Critical, 2 Important, 9 Minor); all eleven closed. `53507a5` →
  migrations **159 → 163**, four additive, each rebuilt from the LATEST
  definition. **I1**: the ACCOUNT half of the completeness census had no
  excused roll and no denominator, so a table leaving the derivation AND the
  catalogue was silently green — the reviewer's reproduction measured
  **13 passed / 0 failed**; with `ACCOUNT_EXCUSED` and an account denominator
  it is **3 of 20 red**. **I2**: the FK walk cannot see a tenant-scoped table
  with no foreign key and the schema has one (`rate_limit_counters.subject_id`
  is a user id *or* an organisation id chosen by `subject_scope`); the walk
  stays and the six unseen tables become a pinned disposition, with a
  **fourth planted table** — a bare `uuid organisation_id`, no FK — proving a
  seventh arrives red. **M1** the job-progress guard was the one closed-list
  server-only gate in a task briefed to invert exactly that shape; measured
  on a role neither list names, holding the runner's own grant and a policy:
  ADMITTED before, refused by hint after. **M2/Q167** `impersonation_sessions`
  was elevated with no projection, so an account archive carried the
  operator's break-glass `reason` and a staff user id; projected, and
  "elevated ⇒ projection" is now a rule of `export_catalogue_is_sound()`
  (mutation: `sound` → `elevated without a projection: …`, census 2 of 20).
  **M7** the read blanked two claim GUCs and restored one — and writing the
  assertion measured that `auth.uid()` reads the per-claim `sub` FIRST on this
  stack, so the blanking is load-bearing rather than vestigial and the
  reviewer's "or drop them" alternative would have been wrong. **M9** the
  runner's cursor is the catalogue's declared key column now, carried by
  `export_plan()`; the review's second half of M9 was already closed in
  `20260927002000`. **M3/M4/M5/M6/M8** hygiene, the ZIP central directory
  under the archive ceiling, the total offset ban restored with one file
  excluded by path, step-up recorded in `SECURITY.md` as an app-layer control
  at every gate, and the page's exclusions derived from the catalogue's five.
  **Checked and not changed:** the three legal versions this task published
  assert no company identity, no controller identity and no signatory, and
  all their bracketed counsel gaps survive — measured on the live store, so
  the 2026-09-21 founder answer needs no further version.
  **Gates:** lint 0; typecheck 0; psql **19 files / 3135 / 0** and API
  **409/0** (3122 at `53507a5`, +13); vitest **140 files / 3053**, matrix
  **398**; e2e **158 passed**. Q167 implemented-as-recommended; **Q170/Q171**
  queued (Q168/Q169 were taken by a peer session).
  **PROCESS:** two false-greens were met while writing § XJ1e itself — an
  UPDATE-only policy left the probe matching no rows and answering `ok`, and
  a missing SELECT privilege answered 42501 with no hint. Both are recorded
  in the suite rather than smoothed over; the second is why XJ1e2 exists.
- **Task 4: COMPLETE (tip `4074565`, 163 migrations).** Implement -> review
  (MINOR, 2I/9M) -> fix round 1 (all 11 closed) -> scoped re-review
  (**MINOR, 0 Critical, 0 Important, 5 Minor**; all eleven verified closed by
  the re-reviewer's own measurement, two closures STRONGER than claimed).
  Gates at the tip: 19 psql files / **3135 assertions** / 0 failed (exports
  suite 124 -> **137**, the only one that moved); API **409 PASS / 0 FAIL**;
  vitest **140 files / 3053**; e2e **158** (17.0m); matrix **398**; 163 -> 163
  around every long run, every number reproduced exactly.
  The headline claim held under attack: a real archive was built, downloaded
  and opened with an independent parser — a colleague's PRIVATE note absent,
  their COMPANY note present, another tenant absent, the requester's own
  private note present as the positive control. Re-owning the read function
  to `postgres` makes the private note APPEAR, so the mechanism is
  load-bearing. RR1-RR5 routed to **Task 8a** rather than a third round.

- **Task 8a (extra-plan, census hardening) implemented (2026-09-21)**, commits
  4074565..(tip) on worktree-legal-phase (pushed). Migrations 163 -> 164
  (20260929000000, an additive re-issue of
  `private.export_catalogue_is_sound()` with three non-emptiness terms and
  `relkind in ('r','p')`). Closes the 17 HOLED checks in `census-audit.md` and
  the five Minors routed from Task 4's re-review (RR1-RR5). Every fix ships
  with its evasion measured; the full list is in `task-8a-report.md`.
  The largest piece is one `run_suite()` in `run-rls-tests.sh` used by all
  nineteen psql suites, which fails on any `psql ... ERROR:` line and asserts
  each suite's RECORDED ASSERTION TOTAL against a pinned number (3135 in
  total, measured on a clean reset). Gates: lint and typecheck clean; psql 19
  suites, 3135/3135 as pinned, 0 failed, API 409 PASS / 0 FAIL; vitest 141
  files / 3096 tests; permission matrix 398 -> 400; e2e 158 -> 160.

- **2026-09-21 — Task 5 (erasure) FIX ROUND 1, `7552f91..HEAD`, migrations
  174 -> 181.** Review graded MAJOR (2 Critical, 5 Important, 6 Minor); every
  finding is closed and each of the two Criticals has a test that failed
  against the tree the review read. **C1** (a `merge_candidates` owner-id
  snapshot surviving a completed erasure, in a column family the function's
  own comment claimed it handled) is fixed by DERIVATION rather than by four
  more lines: `private.fkless_identifier_columns()` is a pinned roll of every
  FK-less uuid column in public/private, classified and given a treatment, and
  `private.assert_fkless_identifier_roll()` refuses the erasure when the
  catalogue has grown one the roll does not classify. **C2** (two concurrent
  erasures both passing an unlocked Q131 guard, reproduced with two psql
  sessions) is fixed with an advisory lock plus FOR UPDATE over every live
  workspace the subject is an active member of, and a post-delete
  re-assertion; `supabase/tests/erasure_concurrency_probe.sh` is the standing
  proof, red before and green after. **I1/Q176** re-founds the guard on "would
  this leave no active Owner" and adds the last-owner trigger
  `organisation_memberships` never had. I2/I3 close a grant that granted
  nothing and pin the whole class as a schema invariant; **I4** gives the
  out-of-transaction runner a unit and an integration suite, and the
  integration one found a real defect on its first run (the rethrow dropped
  `hint`, so every chokepoint refusal was recorded with the generic sentence).
  M1-M6 all closed; Q176/Q177 queued. Gates: lint and typecheck clean; 20 psql suites, 3325/3325 as pinned, 0 failed, API 409 PASS / 0 FAIL; vitest 143 files / 3144 tests, permission matrix 409; e2e 163 passed (its first run found a real stale assertion -- the refusal's wording changed with the guard). Two lessons for the phase: a fixture
  that avoids the bug is how C1 shipped green, and the erasure's evidence was
  almost entirely single-session psql, which is why C2 was invisible.

- **Task 5 FIX ROUND 2 (2026-09-21).** The scoped re-review graded fix round 1
  MINOR: thirteen findings closed, five new. **N1** (the classification roll
  was blind to a natural uuid primary key, a uuid in a composite key and a
  `uuid[]` -- `census-audit.md`'s bug class in the one guard the phase most
  needs) is closed by widening the catalogue query: domains resolve to their
  base type, `uuid[]` and matviews are matched, and the primary-key exemption
  narrows to the single-column key named `id`. Eight of the re-reviewer's ten
  planted shapes now refuse; the three left open (a uuid inside jsonb or text,
  and any schema but public/private) are stated limits with their reasons in
  the migration header. **N5** is the same bug class in the test written to
  close I4 -- a hand-written array of eight claiming to be derived -- and is
  closed by actually deriving it from `public.run_erasure_job()`'s transitive
  call graph, which found `reference_survived_the_purge` answering with the
  exact wrong sentence I4 existed to remove. **N2/Q178**: the refusal branches,
  so a member who can perform neither remedy is told the one that is available
  (support closing the workspace) instead of two that are not. **N3** and
  **N4** are written down rather than coded -- a direct `auth.users` delete
  still strands a workspace and nothing in the product can do it (Q179 carries
  the proper fix), and the C2 lock costs 1.22 ms to take over 5 workspaces /
  250 rows and is held for the 29 ms an erasure takes. Gates: lint and
  typecheck clean; 20 psql suites 3341/3341 as pinned, 0 failed, API 409 PASS /
  0 FAIL; vitest 144 files / 3157; e2e 163 passed. The lesson worth keeping:
  **a derived set is only as good as its matching surface, and the surface is
  the thing to attack** -- both N1 and N5 were derivations that looked complete
  and were matching on the wrong column shape and on nothing at all.

- **Task 5: COMPLETE (tip `7be2e34`, 185 migrations).** Implement -> review
  (**MAJOR, 2 Critical**) -> fix round 1 (all 13 closed) -> scoped re-review
  (MINOR; all 13 verified closed by the re-reviewer's OWN reproductions, five
  new N1-N5) -> fix round 2 (all 5 closed). Gates at the tip: 20 psql suites
  at pinned totals = **3341 / 0 failed**, API **409 PASS / 0 FAIL** (erasure
  suite 143 -> 179 -> **195**); vitest **144 files / 3157**; e2e **163**
  (17.2m, first run, no flake); matrix 409; 185 -> 185 around every long run.
  **C1** a stable identifier survived a "completed" erasure --
  `merge_candidates`' two owner-id snapshots, written on EVERY flagged
  duplicate, invisible to the FK walk, and **the fixture planted them null**.
  Fixed by DERIVATION: `private.fkless_identifier_columns()` classifies every
  FK-less uuid column (22 rows) and the erasure REFUSES at step 0 when the
  catalogue grows an unclassified one. **C2** two concurrent erasures raced
  past the Q131 guard and stranded a workspace (both co-Owners gone, records
  live); fixed with per-workspace advisory locks in id order + `FOR UPDATE` +
  a post-delete re-assertion -- and the fixers stated plainly, measured, that
  the re-assertion **alone does not catch it** under READ COMMITTED.
  **I1** an Admin could demote the last Owner (no guard existed anywhere on
  `organisation_memberships`), after which the erasure guard stopped firing
  for everyone -> new `private.membership_keeps_an_owner()` trigger.
  Fix round 2 closed the roll's blind spots: of the re-reviewer's ten planted
  shapes **8 now refuse** (uuid PK, composite PK, `uuid[]`, matview, domain);
  E5/E6/E9 left open with stated reasons (jsonb/text need a content scan;
  E6 would mean refusing on `auth`/`storage`/`vault` catalogues this product
  does not own). The hint roll is DERIVED now -- 17 hints over 32 functions
  against a hand-written 8, and the missing one was
  `reference_survived_the_purge` reading "It will be retried" where its twin
  reads "This needs a person to look at it".
  **RECURRING LESSON, now four instances:** a fixture that avoids the bug, a
  hardcoded roll claiming to be derived, a regex whose `\s` vanished in a
  template literal, a census keyed on a semicolon. Q179 (transaction-local
  marker so a direct `auth.users` delete refuses) routed to Task 6.

- **Task 6 implemented (2026-09-21)**, commits `7be2e34..<tip>` on
  `worktree-legal-phase` (pushed). Migrations **185 -> 196**
  (`20261003000000` periods + roll, `001000` run log + kill switches,
  `002000` the seven sweeps + the object manifest, `003000` the audit purge's
  five rails, `004000` the three runner RPCs + one summary row, `005000` the
  FIFTH half of the one tick, `006000` Q179, `007000`/`008000`/`010000` three
  defects the new tests found, `009000` /legal/data-retention v5). The
  twenty-first psql suite, `rls_phase8_retention.sql`, at **116**; the
  permission matrix **409 -> 447**; e2e **163 -> 164**; Q126's storage-client
  census BUILT.
  **Three defects the tests found, and all three are derivations doing their
  job:** (a) `public.retention_runs.correlation_id` is an FK-less uuid column,
  so Task 5's C1 roll refused EVERY account erasure and EVERY workspace purge
  in the product from the moment the table existed; (b) the runner's
  server-only gate tested `request.jwt.claims`, which PostgREST sets on every
  request including the runner's own, so the job refused its own runner and
  all thirteen psql § RR assertions passed against it (found by the one test
  that calls it over PostgREST); (c) four house invariants — an unindexed FK,
  a missing `updated_at` trigger, a CHECK function unreachable by
  `authenticated` (Task 5 § 5(a)'s lesson, pre-empted) and the export
  completeness census — each answered in the invariant's direction rather than
  by editing the check.
  **RECURRING LESSON, now EIGHT instances** (four inherited, four added by
  this task's own suite and each recorded rather than quietly fixed): a
  duplicate-injection probe that matched nothing and passed; a floor probe
  answered by a const-folded cached plan; a count sharing a statement with the
  delete it was measuring; a transaction-local marker discarded by psql's
  autocommit. **And one mutation that found NOTHING** — the feedback sweep's
  bytes-first gate reddened zero assertions in either layer, because psql
  cannot plant a storage object it can remove again; the assertion that closes
  it is in `tests/integration/retention/runner.test.ts`.
  Q180/Q181/Q182 queued. See `task-6-report.md`.

- **Task 6 review -> fix round 1 (2026-09-21).** Review was MAJOR: 2 Critical
  (C1 the document retention clock and `bytes_purged_at` were writable by the
  tenant -- standing lessons 6 and 7 verbatim; C2 step 0 ran AFTER the runner
  had deleted the objects), 5 Important, 8 Minor. Fix round 1
  `9673f08..0f77d4a` on `worktree-legal-phase` (pushed), all five gates green at that tip (3562/0, 409/0, 148/3251, 164 passed 17.4m, 203 -> 203 throughout), migrations **196 ->
  203** (`20261004000000` documents guard + column grants + CHECK, `001000`
  the DERIVED clock-column roll and its refusal, `002000` every refusal asked
  in `start_retention_run()` and in a manifest that now takes the run id,
  `003000` one-running index, `004000` the refused-run alert (Q182) and the
  preview-safe throttle, `005000` the roll sees matviews and `private`,
  `006000` /legal/data-retention v6 (Q183)). Retention suite **116 -> 221**,
  psql total **3457 -> 3562**, no other pinned total moved, none lowered;
  vitest 147/3235 -> 148/3251; matrix 447; e2e 164. **All eight of the
  reviewer's zero-red mutations re-run**: MA 1, MC 2, ME 2, MF 2, MG 2, M8 1
  psql + 1 int, MI2 1 psql + 1 int, and MD 0 because as written it is an
  EQUIVALENT mutant (`null < cutoff`); its non-equivalent form reds 6.
  **RECURRING LESSON, now TEN instances:** (9) RC16/RD8/RD10/RZ6 wrapped
  their subject in `where false`, a One-Time Filter the planner never
  evaluates -- four passes against functions nobody called, in the file whose
  own RR6 comment describes that exact bug; (10) a count in the same
  statement as the run it measures reads the snapshot from before it (RA10's
  lesson, made again in RN4b and caught by its own first run). **And psql is
  no longer blind to storage**: a subtransaction that is rolled back can plant
  a `storage.objects` row and carry its answer out in the exception message.
  Q184 (a no-deploy release for the audit ceiling, which cannot drain itself)
  and Q185 (the deleted-documents list offers Restore on a purged document)
  queued. See `task-6-report.md` § Fix round 1.
- 2026-09-22 -- Task 6 FIX ROUND 2 (re-review MINOR: I-N1 + m-N1..m-N7) DONE
  on `worktree-legal-phase`, 203 -> 207 migrations. I-N1 (`20261005000000`,
  Q186 taken): the PERIOD half of the document clock is frozen at deletion,
  in both directions, by the guard that owns the deleted_at transition; the
  sweep and the manifest read the stamp; reproduced red first
  (`operational/1`), green after, four mutations (GF1 9, GF2 21, GF3 1 +
  integration red, GF4 2). m-N4 (`20261005001000`): the audit action
  catalogue in the database, bound both ways; the three-name exemption reds
  2. m-N2 (`20261005002000`): the lifecycle guard's hint, `no_permissive_
  policy`, a trigger that cannot fire refused (G3 3, G5 3, H 1, I 2, NP 2).
  m-N7: legal bodies from the migration walk, denominator pinned, planted
  migration read. m-N1 (`20261005003000`): fixed-point walk, views via
  pg_depend, `private`; four limits stated (WE 1, WA 1, WB 2). m-N3 stated.
  m-N5/m-N6: RC17 against a pre-tick mark (mutation 1), RL3b-d binds
  archive_days (mutation 1). Retention pin 221 -> 267, total 3562 -> 3608.
  **LESSON (11):** a probe that revokes a grant the PRODUCT relies on
  (`usage on schema private` from `authenticated`) passes on its first run
  and breaks every tenant write on the second -- re-run every suite twice on
  one database before pinning it. Q187 queued (v6 wording, with the next
  publish).
- **Task 6: COMPLETE (tip `c72f92e`, 207 migrations).** Implement -> review
  (**MAJOR, 2 Critical** -- a tenant could set a document's retention clock
  and the runner deleted bytes BEFORE its safety checks ran) -> fix round 1
  (all 15 closed) -> scoped re-review (MINOR; both Criticals re-attacked over
  real HTTP, nothing forged; one new Important I-N1 + 7 Minors) -> fix round
  2 (all 8 closed). Gates at the tip: 21 suites at pinned totals = **3608 /
  0 failed** (retention 116 -> 221 -> 267), concurrency probe PASS, API
  **409/0**; vitest **149 / 3267**; e2e **164** (17.6m); matrix 447; 207 ->
  207 every run. I-N1: the PERIOD half of the clock was still tenant-writable
  (retention class recomputed at sweep time from a client-writable FK, one
  hop beyond the derivation) -- now FROZEN at soft-delete, both directions,
  proven over PostgREST with the file still in the bucket. Retention periods
  live in ONE function (`private.retention_periods()`, 11 classes) so Q133 is
  a single migration. The audit purge has five independently-mutated rails
  and a refused run now raises an alert. Q184 (ceiling release valve), Q185
  (Restore on a purged doc), Q187 (v6 wording) open with defaults.
  **Lesson 11 (from fix round 2):** a suite change that revokes a schema
  privilege the product relies on can pass on run 1 and break on run 2 --
  prove every suite RE-RUNNABLE on one DB.
- **Task 7: COMPLETE (tip `502db02`, 210 migrations).**
  - Implement (the implementer died on the rate limit; the controller ran gate 5) → review (**MAJOR**, 1 Critical) → fix round 1 (all 7 closed) → scoped re-review (**MINOR**, N1–N6 minor/nit, no further round).
  - **The Critical, C1:** the new audit payloads copied third-party user ids, such as `invited_by` and `owner_user_id`, and erasure left them behind.
    - The fix: `erase_account()` step 6f scrubs the payloads, and step 10b refuses the erasure if the id survives.
    - A derived guard, `private.audit_payload_person_columns()`, has 19 rows.
    - Reproduced red (2 payloads kept the id), now 0.
  - **Gates:**
    - psql: 22 suites, **3825 / 0** (CRM audit P3-6 186 → 204, erasure 195 → 208), API 409/0.
    - vitest: **151 / 3305**.
    - Permission matrix: 447.
    - e2e: 163/1. The one red was REFUSAL PARITY's 60 s timeout under memory pressure; that spec re-ran **20/20**.
  - **Follow-ups:**
    - **F-T7-1:** the REFUSAL PARITY test runs 50+ s against its 60 s ceiling. Split it or give it its own timeout, never retries.
    - **N1:** accounts erased before `20261007000000` are not revisited. Pre-launch, so the exposure is zero.
    - **N2:** a concurrent writer can land an id after the 10b scan, the same gap 6a already has.
  - Q191 and Q192 queued. The founder answers of 2026-09-30 are folded into the DECISIONS-QUEUE.
  - **LESSON (12):** on this machine a full e2e run takes about 47 min under memory pressure, and background waiter shells get reaped. Launch detached and read the log; never trust a waiter.
- **Task 8: COMPLETE (tip `f0b8467`, 210 migrations).** Implement → review MINOR (I1 export-download parity was a false green: a job with nothing to download; I2 /super raw HTML was a REAL oracle — 67/70/59 KB per route — closed by a middleware rewrite of every signed-in non-superuser /super request to one not-found route, route handlers exempt by census; I3 counts) → fix round 1 → re-review MINOR (N1-N4) → fix round 2 (a parity red that was the test normaliser mis-reading flight ids, case (a) dev-only; N1 page-guard source census, docs) → closed. Full gates after fix round 1: psql 3858/0, vitest 152/3415, e2e 172/1 (the red fixed in round 2; parity+super-permissions then 23/23, parity 9/9 ×3). Round 2 touched tests/docs/a comment only.
  - The first implementer hung ~17.5 h after rate-limit/watchdog stalls; stopped, WIP saved as `24bfb95`. Its "14 red HTTP checks" did not reproduce on a clean reset (a mutant left applied, most likely).
  - Mutation batch run by a detached, resumable driver (`mutation-results/run-all.sh`), not an agent: **36 mutants, 0 false greens**; control green in every layer. Two Important collateral-only kills found and closed with direct assertions (DSR DW4a-c, retention kill switch RR7a-h) plus mutants 05c and 16, each now red.
  - **Gates:** psql 23 suites **3858 / 0**, API all passed; vitest **152 / 3414**; e2e **173 / 0** (21.0 m). Follow-up F-T8-1 (5 s unit-test timeout under load).
  - **LESSON (13):** never hand an agent a multi-hour batch. Long measurement runs go to a detached resumable script that saves each result as it lands; agents get ≤ 60 min jobs; check the tree is moving, not the agent's status.
- **Task 9a: COMPLETE (tip `9af4ad9`, 216 migrations).** Four bounded jobs (Q142/Q145 hosts + 5 legal versions; Q167 export reason; Q184 72h ceiling release, 8 mutants; Q185 purged-restore refusal + Q113 uploads 10/hr) → gates psql green, vitest 154/3457, e2e 175/0 → review MINOR (I1 host comments) → fix round 1 (+2 migrations) → re-review READY. `pnpm test` run twice on one reset: 3460/3460 both. Q193-Q197 queued. NEXT: Task 9b in 3 jobs (Telegram + /super alerts; email base + DSR/erasure/export emails; connection + reminder emails + doc rewrites).
- **Task 9b: COMPLETE (tip `851425b`, 224 migrations).** 3 jobs (Telegram channel + /super check; DSR/erasure/export emails; connection + reminder emails + "silent" docs) → review **MAJOR**: C1 a sender could INSERT an already-`accepted` connection request (pre-existing since Phase 6, PROBED: leaked the target's connections-level field) → fixed `born_pending` trigger + policy; I1 893 lines of FOLLOW-UPS restored; I2 queue poisoning; I3 one-link bypass → re-review MAJOR: **N1 a requester could UPDATE/repoint its own row into "X→T accepted"** (pre-existing, PROBED, leaked) → fixed `bound_update` trigger + status-only column grant → re-review 2 **READY**. Gates after round 2: psql green (4036), vitest 163/3680 (round 1), e2e 174/1 — the red was a DOM-forgery race in documents.spec:202 (React reset the forged hidden input), fixed in the test at 851425b; **its e2e verification is owed to Task 9c's full gate** (the 3x re-run was killed by the low-memory reaper). Q198-Q204 queued. Owed: N4 (erasure test for a user on a request row) → Task 9c job 1.
  - **LESSON (14):** a gate script's `echo "$(date) exit=$?"` records date's exit code, not the test's — capture `rc=$?` first. Always read the log, never trust the logged exit.
  - **LESSON (15):** the two Criticals were found by a reviewer reading policies for a column/status the WITH CHECK never pins. For every tenant-writable table, ask: which columns can the browser INSERT or UPDATE, and does anything pin each one?

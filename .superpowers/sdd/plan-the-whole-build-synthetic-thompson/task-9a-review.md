# Phase 8 Task 9a: founder rulings 2026-09-30. INDEPENDENT REVIEW.

Range `1302fc3..104fe0a` (14 commits), worktree `legal-phase`, branch
`worktree-legal-phase`, reviewed at `104fe0a`. Migrations 210 -> 214 in the
range (`ls supabase/migrations` = 214; `20261008000000`, `20261009000000`,
`20261010000000` and `20261011000000`, all after the previous tip and none
edited afterwards).

**VERDICT: MINOR.** There are no Critical findings. All seven requirements are
met where it matters. Each new guard sits in the database, or at the only
chokepoint that exists, and each mutant is the live definition plus one
change. There is one Important finding: a false sentence that this task added
to SECURITY.md about host assumptions, and the requirement-1 cleanup it claims
is incomplete. The Minor findings are a wrong provenance line in a live
function comment, a misleading "Last changed" line on the panel after a
release, a scope interpretation for Q167 that should be put to the founder,
and standing-lesson 11 not literally met for jobs 3 and 4.

---

## Method and constraints

The dispatch made this review read-only on code. I ran no reset, no psql
runner, no integration vitest, no Playwright and no dev server. The
controller is running the full gates on the shared stack. What I did run:

- `git diff 1302fc3 104fe0a`, read file by file for every product file, every
  migration and every mutant.
- **Mutant validity.** The DB was not mine to query, so I diffed each mutant's
  body against the definition in `20261010000000`, which created each function
  and which no later migration redefines (`grep` confirms). That is the live
  definition at 213/214. `diff -w` results:
  - 17a: `has_platform_permission(...)` becomes `session_is_aal2()`.
  - 17b: it becomes a bare `platform_admins` exists test.
  - 17c: `if false` replaces the reason test.
  - 17g: `'72 hours'` becomes `'30 days'` in the RPC, plus a separate
    `drop constraint` on the shape CHECK.
  - 17h: `if false` replaces the already-active test.
  - 17e: `v_released := false`.
  - 17f: the floor test becomes conditional on no release.
  - 17d: the reader drops `now() < expires_at`.
  - 18a: `drop constraint documents_purged_implies_deleted`.

  Each is exactly the one intended change. **Verified.**
- **The catalogue rebuild (Q167).** I diffed `export_catalogue()` in
  `20261009000000` against the true latest definition,
  `20261003010000_retention_tables_meet_the_house_invariants.sql`, which was
  NOT the `20260930007000` the header names (see m1). The functional diff is
  exactly two columns added to the account `impersonation_sessions`
  projection, plus two reason strings. The `retention_settings` excused row
  that `20261003010000` added is preserved, so lesson 4 held in substance.
  **Verified.**
- `pnpm exec vitest run` on four unit files:
  - `tests/unit/legal/sub-processors-drift.test.ts`: 6/6.
  - `tests/unit/security/rate-limit.test.ts`, `tests/unit/legal/seed-matches-catalogue.test.ts`
    and `tests/unit/crm/documents-list.test.ts`: 127/127 together.

  **Verified.**
- Gate numbers, psql pins and the integration and e2e results are
  **taken from the report**. I did not re-measure them.

---

## Requirement by requirement

### 1-3. IONOS / eu-west-1 / republish

**Published rows are never edited.** `20261008000000` inserts version + 1 for
each of five slugs. It then flips the old row `published -> superseded` and
publishes the new one BY ID. That transition is the one the guard permits,
and it mirrors `publish_legal_document()` (lines 196-218). A version gate on
each slug refuses to run if the page has moved on, and an exact-replace check
on each paragraph refuses if the expected text is gone. A closing count
assertion requires exactly 5 published, unreviewed new versions, with no
`(deployment setting)` and no "not yet listed" (lines 220-243). No body of a
published row is UPDATEd. The migration writes no `legal_document.published`
audit row, but neither did the earlier seed/republish migrations
(`20261004006000`, `20261003009000`), so this is consistent. **Verified.**

**The drift test really binds the two files.** `sub-processors-drift.test.ts`
reads the Markdown table and compares name order, location (after stripping
a trailing parenthetical that contains a backticked path), DPA status and the
verbatim register cells against `SUB_PROCESSORS`. The new test requires an
IONOS SE row in both with `Germany` and `PENDING`. The Supabase cells agree
once the stripping is applied ("data hosted in Ireland (eu-west-1)"). It runs
green. The report's mutation claim (naming a region turns "same location"
red) follows from the code. **Verified by reading and running.**

**The region marker is gone** from the Supabase row in both files and from
all four pages. The closing assertion of `20261008000000` checks this.
**Verified.**

**Q187:** data-retention v7 carries "judged when the document is deleted". The
RL-bound sentence is kept (taken from the report: LF2q and § RL green).

**Remaining host assumptions:** see **I1**.

### 4. Q167: break-glass reason and operator in the account export

- **Scope.** The scope is unchanged: rows where `admin_accepted_by` or
  `declined_by` is the requester. Nothing from a colleague's session or
  another tenant's session is added. The read is elevated and projected, so
  the 13 named columns are all that can leave. `superuser_user_id` is a bare
  uuid with no join. **Verified** in the catalogue diff.
- **Tests.** `runner.test.ts` plants a colleague-decided session and a
  foreign-tenant session and asserts that their reasons appear in no archive
  file. Taken from the report, test file read.
- **Manifest.** v1 -> v2. The only consumers of `schemaVersion` are the
  runner and its tests (`grep`). The workspace manifest also becomes v2,
  although its columns did not change. That is harmless.
  `SUPPORT_ACCESS_NOTE` is written only when the account plan exports the
  table. **Verified.**
- **Erasure.** No new uuid or row-to-user path was added. The two columns
  already existed on the table, so the erasure and export rolls have nothing
  new to classify. **Verified.**
- **Scope interpretation:** see **m3**.

### 5. Q184: the ceiling release

- **Enforced in the DB.**
  - `release_audit_purge_ceiling` gates on
    `private.has_platform_permission('manage_retention')`. That is
    `session_is_aal2() AND platform_admins` (`20260827210000:217-229`).
  - The reason must be non-null and non-blank, and at most 500 characters
    after btrim.
  - The row is taken `FOR UPDATE`, then the call is refused while a release
    is active.
  - `retention_settings` has no client INSERT/UPDATE grant, only SELECT.
    This RPC is the only writer.
  - The audit row goes through `log_audit_event`, which takes the actor from
    `auth.uid()`.

  **Verified.** The server action's `authorise()` adds the app's recency
  step-up (`checkStepUp`) in front, the same as the kill switch. **Verified.**
- **Read-time expiry.**
  - `now() + interval '72 hours'` on a timestamptz is absolute, so a
    timezone or DST change cannot alter it.
  - The reader requires `released_at <= now() < expires_at` and re-checks
    `expires <= released + 72h`. The shape CHECK holds
    `expires = released + 72h` too.
  - REL19 (71h, still active), REL20/21 (72h+1s, expired, purge refuses
    again) and REL24 (a longer window with the CHECK gone does not count)
    cover the boundary.

  **Verified by reading**; the results are taken from the report.
- **Re-arming.** A release cannot be extended while active (REL10, 17h). One
  can be re-recorded straight after expiry (REL26). Each release is a fresh
  audited decision with a new reason, so it is not *silently* permanent. An
  operator pressing every third day could keep it lifted indefinitely. This
  is accepted by design and adjacent to Q195; see "Informational".
- **The other rails are independent of the release.**
  - In `purge_audit_events`, `v_released` is consulted only in the rail-3
    `if`.
  - The kill switch (rail 2) returns before the release is read.
  - The floor (rail 1) is checked before the release is read.
  - The cut and `p_limit` (rail 4) are untouched.

  17f proves that the floor guard is load-bearing under a release. **Verified.**
- **Audit catalogue.** `platform_audit_actions()` was rebuilt and diffed only
  by the one appended action. `lib/admin/audit-actions.ts` and the 163 pin
  were updated. **Verified.**
- **Mutants.** All 8 are valid (see Method). On the 17c nuance: with the RPC's
  reason test removed, the shape CHECK still refuses a blank reason (23514),
  so the behaviour holds and only the hint names the wrong layer. REL7/REL7a
  go red because they pin the hint. This is two layers, and the
  RPC layer is the one that went red. **Acceptable.**

### 6. Q185: purged document, notice and refusal

- **The DB refuses every path.** `documents_purged_implies_deleted` is a
  CHECK, so it binds every writer, service role included. The only restore
  path in the app is `restoreDocumentAction`; documents have no detail page,
  and `grep` finds no other restore RPC or bulk path. The action adds an
  RLS-bound pre-read that refuses in words, and the update keeps its
  `bytes_purged_at is null` filter. 18a shows the DB layer is load-bearing in
  psql. **Verified by reading.**
- **The date.** The column is `bytes_purged_at`, not `deleted_at`. It is
  shown with `formatDate`, which uses `timeZone: Europe/London`. The <time>
  element carries the instant. The integration test pins
  23:30 UTC 14 June -> "15 Jun". **Verified.**

### 7. Q113: uploads 10/hour per user

- **The only byte path.** The only `.upload(` into the `documents` bucket is
  `lib/crm/documents.ts:159`. The others are the exports runner, a different
  bucket written by the service role, and the feedback screenshot, a
  different bucket that already has its own budget of 10/hour per
  submission. `consumeRateLimit("uploads")` runs before that write and after
  the permission, size, allowlist and sniff refusals. **Verified.**
- **Per-user keying.** The policy row is `subject_scope = 'user'`.
  `consume_rate_limit` binds a user category to `auth.uid()` and refuses an
  org argument (22023). `consumeRateLimit` passes none, and the unit test
  pins that. Switching workspace therefore does not reset the budget.
  **Verified by reading.** No integration test uploads from a second org
  (see m5).
- **Refused and failed uploads.** Type, size and permission refusals spend
  nothing. A scan-quarantined upload does spend budget, because its bytes
  WERE stored, which matches the ruling's intent. An over-limit attempt is
  counted too (counter 11), which is the house limiter's existing behaviour.
  **Intended.**
- **Q196 default (metadata-only rows not metered): sensible.** No bytes reach
  Storage, the download gate refuses a row with no object, and storage is
  deny-all for clients.
- **Lesson 6** ("enforce at the chokepoint"): the action IS the chokepoint
  for bytes, because the bucket is deny-all and the row lands after the
  bytes. The migration header justifies this. **Accepted.**

### Registries, docs, commits

- Pins, catalogue and matrix all moved: legal 171, exports 138, retention
  309, rate limits 183, PA6c 163, matrix 557, total 3897 at 214. Taken from
  the report; the CLAUDE.md sentence matches the report's sums.
- Each commit is one logical change, and every commit body cites
  "Founder 2026-09-30". **Verified.**

---

## Findings

### Critical

None.

### Important

**I1 — SECURITY.md now says "Nothing in this repository assumes any other
host", and two code comments still assume a serverless host.**
*Verified.*

Requirement 1 says to remove any assumption about Vercel or another host. The
report says the `lib/email/send.ts` assumption was removed, but only one of
the two mentions in that file was.

- `lib/email/send.ts:25-26`: "undici's default is 300 s, and a serverless
  host kills the function long before that".
- `lib/feedback/actions.ts:109-110`: "after() keeps the function alive on a
  serverless host until the callback settles".

**Failure scenario.** The new SECURITY.md § 15 line (the IONOS item) is false
on the day it lands. The second comment states a deployment property that
does not hold on a long-running Node process on a VPS. The reasoning still
works there, but for a different reason: nothing kills the process, and the
user simply waits. This is lesson 8, docs drift in a sentence this task
wrote.

**Fix.** Reword both comments host-neutrally ("a hosting runtime may kill the
request", "after() runs the callback after the response is sent"). Re-run the
`grep -i serverless` the report should have run.

### Minor

**m1 — The live comment on `private.export_catalogue()` names the wrong
predecessor.** *Verified.*

`20261009000000`'s header ("rebuilt from its LATEST definition
(pg_get_functiondef as left by 20260930007000)") and its `comment on
function` ("Everything else is as 20260930007000 left it") are both wrong.
The latest definition was `20261003010000`, which added the account
`retention_settings` excused row. The body is right, because it carries that
row, so this is provenance only. The function comment is a live object, so
it is correctable.

**Fix.** Reissue `comment on function` in a later migration, naming
`20261003010000`.

**m2 — The panel's "Last changed …" line misattributes after a release.**
*Verified by reading.*

The release's UPDATE fires `set_updated_at`, so `updated_at` moves.
`components/admin/retention-panel.tsx:277-278` renders
`Last changed <updated_at> — "<switches' reason>"`. After a release, the
operator reads the release time paired with the kill switch's OLD reason. If
the switches were never changed, it reads "Last changed <time> (never
changed)". The migration header acknowledges that `updated_at` changed
meaning, but the panel line was not adjusted. The audit log stays correct.

**Fix.** Label it from the switches' own timestamp (derive it from the latest
`retention_settings.changed` audit row, or add a `switches_changed_at`
column), or drop the time.

**m3 — Q167's "touched the data subject" was read as "decided by them" and
not queued as a question.** *Verified.*

The brief says "every impersonation session that touched the data subject".
The implementation keeps the existing decider scope, which is defensible and
leaks nothing. However, a non-admin member whose own records were visible
during a colleague-accepted session gets nothing, and has no other way to
learn of the session, because only admins read `impersonation_sessions`.
Q194 queues only the identity format.

**Fix.** Add a one-line Q, with the current scope as the default, so the
founder sees the reading.

**m4 — Standing lesson 11 (run the psql suite twice on ONE database) was not
literally met for jobs 3 and 4.** *Taken from the report.*

The runner refuses a second run ("public schema is not empty"), so the jobs
did reset-and-rerun, or ran once. That is not what lesson 11 tests: state
left by the first run breaking the second. The new integration fixtures do
tidy up after themselves:
- the matrix's positive control nulls the release;
- `upload-rate-limit` deletes its counters;
- the e2e clears the release and its audit rows.

**Fix.** For the controller: run `pnpm test` (integration) twice back to back
on one reset. Either accept reset-and-rerun as the psql interpretation in
`progress.md`, or give the runner a `--again` mode.

**m5 — No cross-organisation upload test.** The per-user binding is proved
only by reading `consume_rate_limit` and the unit test's no-org assertion.
**Fix:** an 11th upload made into orgB after 10 into orgA should be refused.
That is a one-test addition to `upload-rate-limit.test.ts`.

### Informational (no action required)

- **The DB enforces aal2, not recency.** The RPC accepts any aal2 superuser
  session, and the recency step-up lives only in `authorise()`. This is
  identical to `set_retention_enabled` and is the house pattern, not a
  regression.
- **Release chaining.** One release every 72 hours, each audited with its own
  reason, can keep the ceiling lifted indefinitely. The floor and the 500-row
  run limit still bound the damage. This is consistent with Q195's default.
  A future `audit_purge` alert when releases recur would make it visible.

---

## What I verified vs took from the report

- **Verified myself:**
  - the 8 + 1 mutant diffs;
  - the catalogue diff against the true latest definition;
  - the legal migration's mechanics (no body UPDATE, by-id publish, version
    gates, closing count);
  - the drift-test binding (read and run);
  - the RPC gates, CHECK and reader;
  - rail independence in `purge_audit_events`;
  - the restore paths and the CHECK;
  - the upload byte paths and the call order;
  - per-user scoping in code;
  - the date column and timezone;
  - commit citations;
  - the remaining host mentions;
  - four unit test files green.
- **Taken from the report:**
  - every psql/HTTP pin and result;
  - the integration and e2e results;
  - which REL/RK/RV assertions each mutant turned red;
  - the migration counts during the runs.

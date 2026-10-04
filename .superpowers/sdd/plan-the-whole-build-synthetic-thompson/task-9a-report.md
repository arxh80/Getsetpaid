# Task 9a report

## Job 1 (req 1-3)

Founder rulings 2026-09-30, Q142 / Q145, plus Q187's clause. Tip before: 1302fc3 (210 migrations). Commits (pushed): 2ee09fd, 8cc0688, 8ec4a3a, and this report.

**What changed**
- **Q142:** IONOS SE (Germany) is now in `docs/sub-processors.md` AND `lib/legal/sub-processors.ts`. Its location is "Incorporated in Germany (EU); server region PENDING — the server has not been set up yet". The DPA is not signed, and the transfer basis says "Not yet confirmed". The binding is `tests/unit/legal/sub-processors-drift.test.ts`, which already compared location and DPA status. It gained one test that requires the IONOS row in both lists with PENDING. Mutation: naming a region in the register's IONOS cell turns "gives each the same location" red.
- **Host assumptions removed** (8cc0688): "Vercel box" in `lib/format/date.ts`, "Vercel builds" in `scripts/dev-env.mjs`, "edge/serverless runtime this app deploys to" in `lib/email/send.ts`, and "so Vercel" in FOLLOW-UPS.md. Left alone: shipped migration comments (immutable) and tooling mentions (`.vercel/`, the vercel-* skills, the `@vercel/analytics` tracker pattern).
- **SECURITY.md § 15:** the "Project region" item now reads Ireland (eu-west-1). Verifying it is now what makes the published sentence true. A new item covers the IONOS host, region PENDING, and what must happen when the server is bought.
- **Q145:** the Supabase row now reads "data hosted in Ireland (eu-west-1)", and the "(deployment setting)" marker is gone.
- **CLAUDE.md:** the sub-processor and legal paragraphs, and the psql total, were corrected.

**Versions published** (migration `20261008000000_legal_pages_name_the_hosts.sql`, 210 -> 211). Each version is built by exact replacement and published by id. The migration refuses to run if any of these pages has already moved past the version shown. None of the new versions is reviewed.
- privacy 3 -> 4
- data-processing-addendum 4 -> 5
- security 2 -> 3: drops only the region marker and keeps the other 7 markers.
- subprocessors 2 -> 3
- data-retention 6 -> 7: Q187's "judged when the document is deleted". The sentence `rls_phase8_retention.sql` § RL binds is kept verbatim.

**Pins moved (old -> new)**
- Legal psql suite: `run_suite` 168 -> 171. The 3 new checks are LF2o, LF2p and LF2q: the hosts are named, the 4 superseded versions serve as the denominator, and Q187 is covered.
- LF1: 32 -> 37 rows. LO1: 34 -> 39. LF2: `1=8,2=3,3=1,4=1,5=1,6=1` -> `1=8,2=1,3=2,4=1,5=2,7=1`.
- LF2i: DPA 4 -> 5 and retention 6 -> 7. LF2l: retention 6 -> 7. LF2b: superseded list gains dpa:4, retention:6, privacy:3, security:2, subprocessors:2.
- HTTP block: the version map for "15 current rows intact".
- psql total: 3858 -> 3861.
- `seed-matches-catalogue.test.ts`:
  - The walk's denominator gains the new migration.
  - The hosting rule is stricter. A hosting line must name "Ireland (eu-west-1)" with no marker, and any line naming IONOS must say "pending".
  - It gains a new Task 9a describe block (16 tests).
  - Mutations: an IONOS host "in London" turns 2 tests red, and so does a page that goes back to "UK/EU region".
- `legal.spec.ts`: the Subprocessors table now asserts Ireland, IONOS SE, PENDING, and no "(deployment setting)".

**Results**
- lint and typecheck (after `next typegen`): clean.
- RLS run 1 after a reset: 1 red, LO1, an unmoved pin, fixed.
- RLS run 2 after a fresh reset: all suites passed, HTTP "all checks passed". Migrations 211 -> 211 on both runs.
- vitest `tests/unit` + `tests/integration/legal`: 104 files, 2348 passed.
- e2e `legal.spec.ts` after a fresh reset: 7 passed, 211 migrations.
- The stack was reset at the end.

**Questions:** Q193 is new in DECISIONS-QUEUE.md: "Ireland (eu-west-1)" is now stated as a fact that nothing automated checks. Default: the § 15 pre-launch check covers it.

## Job 2 (req 4, Q167)

Founder 2026-09-30, **Q167 CHANGED**: the account export includes the
operator's break-glass reason and the superuser's identity. Commit `f6201f4`,
migrations 211 -> 212.

**What "touched the data subject" already meant, kept as it was.** The
account catalogue row for `impersonation_sessions` is elevated and scoped to
`admin_accepted_by` / `declined_by` = the requester: the sessions they
DECIDED. `20260928001000` (Task 4 fix round 1, finding M2) had projected it to
11 columns and withheld `reason` + `superuser_user_id` as "not this person's
data". The scope is unchanged; a colleague's session in the same workspace and
any other tenant's session stay out (a current admin reads those through RLS,
and the workspace export carries them).

**Changed.**
- `20261009000000_account_export_carries_break_glass_reason.sql` rebuilds
  `private.export_catalogue()` from its LATEST `pg_get_functiondef` (as left by
  `20260930007000`). The projection is 13 columns: the 11, plus
  `superuser_user_id` and `reason`. The `erasure_jobs` excuse stopped citing
  the overturned argument. The function comment was reissued. The soundness
  check is untouched and reads `sound`.
- `lib/export/contract.ts`: `EXPORT_MANIFEST_VERSION` 1 -> 2, because the
  archive's column set changed. `SUPPORT_ACCESS_NOTE` is new. `runner.ts`
  writes the note into an account manifest only when the plan exports the
  table.
- Superuser identity = **`superuser_user_id`, the account id on the
  session**. It is the narrowest identifier the row holds. An email or name
  would mean joining auth.users/profiles into an elevated read, which the
  engine cannot do, and would export more than the session records. The
  manifest note says the id is the GetSetPaid platform operator. This is
  queued as **Q194**, with that as the default.
- Docs: the CLAUDE.md "Data exports, as built" sentence and the SECURITY.md
  elevated-projection sentence. That sentence was also stale: it said "the
  two that hold more", and four elevated tables are projected. No legal page
  says the reason is excluded (published Privacy/Security only describe
  support access), so **no republish**.

**Tests flipped / added.**
- psql: XC11 is now the EXACT 13-column list. XC14 is new and pins scope =
  `admin_accepted_by,declined_by|elevated`. Exports pin 137 -> 138.
- Census: the exact projection and the exact scope.
- `runner.test.ts` plants 4 sessions: accepted and declined by the requester,
  one decided by a colleague in orgA, and one in orgB. The two decided ones
  are present with the reason and the operator id. The id set is exactly
  those two. Neither of the other reasons appears in any archive file. Every
  row's keys equal the projection. The manifest is v2 and carries the note.

**Mutations (all restored, then a fresh reset).**
- M1, the inclusion removed (the pre-change catalogue re-applied):
  - psql XC11 went red.
  - The census "four elevated" test went red.
  - 2 runner tests went red: POSITIVE reason/identity, and exact keys.
- M2, a session that did not touch the subject included (the engine's scope
  predicate got `or true` for impersonation_sessions): the runner's "NO
  session they did not decide" test went red. The catalogue layer stayed
  green, correctly, because the catalogue was unchanged.
- M3, the catalogue scope widened with `superuser_user_id`: psql XC14 and the
  census went red. It was red only in psql until the census scope pin was
  added. The runner stayed green, because the requester is not the operator.

**Gates.**
- `pnpm lint` and `pnpm typecheck` (after `next typegen`) are clean.
- Unit: 101 files / 2304 tests.
- `tests/integration/export`: 4 files / 50 tests, green. They were also run
  under the mutants.
- psql/HTTP suite, run twice, each after a fresh reset at 212 migrations:
  all suites passed both times, exports 138 as pinned, 0 FAIL. The runner
  refuses a second run without a reset, so "twice on one database" was
  reset + rerun.
- e2e `exports.spec.ts` after a fresh reset: 3 passed (50s). It makes no archive-content checks, so the row-level proof is `runner.test.ts`.
- The stack was reset at the end, at 212 migrations.

**New questions:** Q194 (default: the account id plus the manifest note).

## Job 3 (req 5, Q184)

Founder 2026-09-30: "build the audit-purge ceiling release. It is step-up
gated and lasts 3 days." Commits `85bbfca` (migration + psql/matrix/catalogue),
the PA6c repin + SECURITY.md, the /super/health control + e2e, and the
CLAUDE.md counts.

**What "release" means (decided from the ceiling's implementation).** While a
release is ACTIVE (`released_at <= now() < expires_at`), rail 3 (the sanity
ceiling) is not applied. That is all it does. It does not raise the ceiling,
and it does not move the cut. Rail 1 (the floor, >= 1 year, checked against
the function AND the literal), rail 2 (the kill switch), rail 4 (p_limit, oldest
first) and rail 5 (the totals) are untouched. So the worst case is 72 runs x
500 = 36,000 rows, every one already past a year. The run summary carries
`audit_events.ceiling_released` (a boolean, so the summary CHECK admits it and
`sweptLines()` skips it).

**Shape (`20261010000000`, 212 -> 213 migrations).**
- Three columns on the one `retention_settings` row. A CHECK holds all three
  null, or `expires = released + 72 hours` (hours, not '3 days', so a clock
  change cannot make it 71 or 73) with a non-blank reason of <= 500 chars.
- `private.audit_ceiling_release_active()`: read-time expiry, the override
  pattern. It re-checks the 72 hours itself, so a mutation of the CHECK alone
  does not lengthen a release (REL24). No client role can execute it.
- `public.release_audit_purge_ceiling(p_reason)`:
  - `has_platform_permission('manage_retention')` (superuser AND aal2),
  - the reason is mandatory and <= 500 chars,
  - `FOR UPDATE`, then it is REFUSED while a release is active (no extension),
  - an audit row, `retention.audit_ceiling_released`, carries the reason and
    the window, with the actor taken from `auth.uid()`.
- No user-id column was added on purpose: a new uuid would be a new row -> user
  path for the export and erasure rolls, and the audit row already holds the
  actor non-forgeably.
- `purge_audit_events()` and `platform_audit_actions()` were rebuilt from the
  live `pg_get_functiondef`. `retention_clock_columns()` was rebuilt too: the
  derived roll (RK26) refused every run until the two new timestamps were
  classified.

**UI.** It is on `/super/health`'s retention panel, consistent with the kill
switch: step-up, a "Why release it" reason field, and the RPC as the
enforcement. While a release is active, the form is replaced by when it lapses
and why.

**Registries.**
- psql retention: 275 -> 306 (REL1-REL28 incl. 7a/7b, RC11a; RC9 lists the
  reader). The superuser fixture (67a3) moved up to RL-REL.
- CRM-audit PA6c: 162 -> 163.
- `audit-actions-match-db`: 163.
- The permission matrix probes the new RPC, with an invariant that the row is
  still unreleased: 548 -> 557.
- `lib/admin/audit-actions.ts` is updated.
- The total is 3861 -> 3892 at 213 migrations.
- CLAUDE.md and SECURITY.md (§ 7 rail 3, the § 8 refusal table, the Q190
  paragraph) are corrected.

**Mutations.** Each mutant is generated from the LIVE definitions by
`supabase/tests/mutations/17*.sql`. Each run was reset -> mutant -> the whole
psql/HTTP runner (-> the matrix for 17a/b), and every run stayed at 213
migrations. No mutant turned zero assertions red.

| # | guard / mutation | psql red (retention suite) | integration red |
|---|---|---|---|
| 17a | superuser check removed (aal2 only) | REL5, REL8, REL9, REL11 | matrix 5/557 (orgOwner, impersonated, overridden, suspended; superuserAal1 cascades: the first wrong release made it `already_active`) |
| 17b | aal2 requirement removed (platform_admins only) | REL6, REL8, REL9, REL11 | matrix 1/557 (superuserAal1) |
| 17c | RPC reason check removed | REL7, REL7a (the row CHECK still refuses, now as 23514; behaviour holds, the hint names the wrong layer) | not run |
| 17d | expiry ignored by the reader | REL20, REL21, REL22, REL26, REL27 | -- |
| 17e | purge ignores a release | REL13, REL14, REL19, REL22 | -- |
| 17f | release also skips the hard floor | REL17, REL21, REL22 | -- |
| 17g | 30 days (RPC) + CHECK dropped | REL9-REL14, REL16, REL19, REL22, REL23 | -- |
| 17h | one-at-a-time removed (re-release extends) | REL10, REL11, REL27 | -- |

(5) "the purge does NOT honour an expired one" is 17d's REL21. (6) "the floor
still holds during a release" is 17f's REL17, plus REL15 (inside-the-year and
30-day-hot rows survive a released live run).

**Gates.**
- `pnpm lint` and `pnpm typecheck` (after `next typegen`) are clean.
- Unit: 101 files / 2305 tests.
- `vitest tests/unit tests/integration/retention tests/integration/admin` plus
  the matrix: 106 files / 2888 tests, green. The matrix alone runs 557.
- psql/HTTP after a fresh reset:
  - The first run had 1 red, PA6c (the catalogue pin). It was fixed, then
    reset, then rerun: all suites passed, retention 306 as pinned, HTTP 0 FAIL,
    exit 0.
  - The second run on the same database is refused by the runner by design
    ("public schema is not empty"), as job 2 recorded.
- e2e `platform-health.spec.ts` + `super-permissions.spec.ts`: 20 passed
  (2.4m). The new walk presses the real control, reads the 72h row, the reason
  and 1 audit row from Postgres, and runs an axe scan of the active state. The
  list now reports 174 tests.
- The stack was reset at the end, at 213 migrations.

**New questions:** Q195 (no early revoke and no auto-end on drain; default:
none, because the kill switch beside it stops deletion now).

## Job 4 (req 6-7, Q185 + Q113)

Founder 2026-09-30: "show 'File deleted under the retention policy on <date>'
in place of Restore" (Q185) and "uploads are limited to 10/hour per user. The
25 MiB cap stays, enforced at the write" (Q113). Commits `b27c8ce` (Q185),
`cad6adc` (Q113), then the CLAUDE.md counts with this report.

**Q185.** A purged document is marked by `documents.bytes_purged_at` (Task 6).
The database ALREADY refused its restore for every writer
(`documents_purged_implies_deleted`, a CHECK, not an RPC or policy), so no
migration was needed. Changes:
- `/[orgSlug]/documents/deleted` selects `bytes_purged_at` and renders
  `DocumentPurgedNotice` ("File deleted under the retention policy on" +
  `<time>` with `formatDate`, Europe/London) instead of Restore. The page's
  intro and empty-state copy no longer say the file is always kept.
- `restoreDocumentAction` reads the row through the caller's RLS client first
  and refuses a purged one: "This file was deleted under the retention policy
  on 15 Jun 2026, so it can't be restored." The `bytes_purged_at is null`
  filter and the CHECK stay behind it.
- psql RK13a-c: the aal2 Owner sees 6701 deleted+purged, their restore is
  `denied(23514)`, and the row is unchanged (RK13 is the not-purged control).
  Retention 306 -> 309.
- Integration `tests/integration/documents/restore-purged.test.ts`: the
  sentence (23:30 UTC 14 June = 15 Jun in London), the row unchanged, and a
  deleted-not-purged control that restores.
- e2e `documents.spec.ts`: the notice and `<time>` render, the purged row has
  no button, an axe scan of the state (a new `new AxeBuilder` site), then the
  KEPT row's hidden `documentId` is re-pointed at the purged id and its real
  Restore pressed: the refusal is read in that form's alert, and both rows
  are unchanged in Postgres.

**Q113.**
- `20261011000000` adds the `uploads` row (user, 10, 3600) to
  `rate_limit_policies` (213 -> 214 migrations). `consume_rate_limit` already
  binds a user category to `auth.uid()`, so no function was rebuilt.
- `"uploads"` is added to `RateLimitCategory`. `uploadDocumentAction` consumes
  it after the cheap refusals (permission, empty, 25 MiB, allowlist) and
  immediately BEFORE the service-role storage write. The refusal is "You've
  reached the upload limit for now — nothing is wrong. Try again in N
  minutes." (`formatRetryAfter`).
- Why not a BEFORE INSERT trigger like the other write budgets: the row lands
  AFTER the bytes, so a trigger would refuse too late. The bucket is deny-all
  for client roles, so this action is the only way bytes reach it.
- A metadata-only row inserted over PostgREST is not metered: Q196, default
  "meter the bytes".
- **Feedback screenshots do NOT share this path.** They use
  `submitFeedbackAction`, the `feedback-screenshots` bucket, and the `feedback`
  budget enforced at that table's INSERT. They are not counted under
  `uploads`, so nothing is double-counted.
- Tests:
  - unit: `rate-limit.test.ts` meters `uploads` with no organisation;
  - psql: RV6d `10/3600/user`, and RV7/RV11/RZ5 at 12 rows (rate limits
    182 -> 183);
  - integration `upload-rate-limit.test.ts`: 10 land (10 rows, 10 objects);
    the 11th is refused in words with counter 11, still 10 rows, still 10
    objects, and no row named after it.
- SECURITY.md § 5 has the new row and § 8 the Q185 paragraph.

**Mutations** (each reverted; DB mutant via `run-mutation.sh`, 214/214):

| guard / mutation | red |
|---|---|
| M1 upload consume ignored | integration: upload-rate-limit "the ELEVENTH" |
| M2 consume moved after the storage write | integration: the same test, on the OBJECT count only (expected 10, got 11) -- the row count and message would have passed |
| M3 restore action's purge read removed | integration: restore-purged message (the REFUSED sentence instead); row unchanged |
| M4 purge read AND the update filter removed | integration: message (FAILED sentence, the CHECK refused); row unchanged |
| 18a CHECK `documents_purged_implies_deleted` dropped | psql RK13b, RK13c, RK15, RK16; the integration documents files stay 11/11 green, because the action's read and filter still refuse -- that is the layering, not a hole |

The e2e forged POST was not mutation-run. M3 would change its alert text, so
it would go red the same way the integration test does.

**Gates.**
- `pnpm lint` and `next typegen` + `pnpm typecheck` are clean.
- `vitest tests/unit tests/integration/documents tests/integration/security`:
  110 files / 2944, green.
- psql/HTTP after a fresh reset: all suites passed (rate limits 183,
  retention 309), API surface passed, exit 0, 214 -> 214. Not run a second
  time: the runner refuses a second run on the same database (job 2).
- e2e `documents.spec.ts` after a fresh reset: 5 passed. The first two runs
  were red on the TEST, not the product:
  - `datetime` comes back as `+00:00`, not `Z`;
  - the alert reads "Error. <sentence>".
- The stack was reset at the end, at 214 migrations.

**Docs drift found.** CLAUDE.md listed the exports suite as 137 while its pin
is 138, so the stated total of 3892 at 213 migrations was really 3893. It is
now 3897 at 214 migrations, summed from the pins. The e2e count is 174 -> 175.

**New questions:** Q196.

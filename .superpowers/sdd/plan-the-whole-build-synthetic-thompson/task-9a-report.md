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

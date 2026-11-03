# Q228 final whole-branch review: `q228-closure-backup-parts` (0751e8a..becab13)

Read-only review. No code edited, nothing committed, no db reset, psql, integration or e2e run. Tip confirmed `becab13`, working tree clean. Evidence: the review package plus targeted reads, each named against the risk it checked.

## Verdict: **READY WITH FIXES**

No Critical findings. Two Important findings: one at a seam between features, one in the parts list on the page. Neither is a tenant or privacy leak, and neither deletes a kept backup. Both should be fixed, or explicitly queued for the founder, before the PR merges.

---

### Spec compliance

- ✅ §2/§3 parts bounded by `private.export_limits()` plus 65 535 entries, closed before a ceiling, one part per claim, re-queue with cursor (`lib/export/parts.ts:141-339`, `lib/export/runner.ts:178-232`, `20261101000000:295-305`).
- ✅ §3 reaper judges one claim: the re-queue keeps `started_at` and a claim re-stamps it (`20261101000000:303`, `:339-343`; QK1-QK4).
- ✅ §4 table, PK-as-FK index, RLS before grants, requester-only SELECT reused through the parent's policy (`20261101000000:73-115`). `export_jobs` has exactly one SELECT policy, `export_jobs_select_own` (`20260927001000:495-497`; checked: no other `create policy ... export_jobs`), so parts inherit requester-only reads and nothing wider.
- ✅ §4 every archive-removing path covered: the retention manifest names expired parts and exempts a non-failed job's parts (`20261101001000:225-268`); erasure excludes closure backups (census `export-bucket-functions-census.test.ts`); removal census (`export-bucket-removal-census.test.ts`).
- ✅ §5 `?part=N`, same order, literal 404 for every refusal, `after.part`, `(uuid)` dropped, not overloaded (`route.ts`, `lib/export/download.ts:45-128`, `20261101001000:49-100`).
- ✅ §5/Q238 hold waits for every part, by the requester only (`20261101001000:116-142`; QO1-QO7, mutants 21a/21b).
- ✅ §6 Contact us: Owner only, `owner_closed` + failed, `mailto` with slug and job id or `/legal/contact`, a link, tokens only (`page.tsx:86-95`, `:258-286`; `lib/org/closure-contract.ts:121-125`).
- ✅ §7 delete-without-backup unchanged and asserted (QX1-QX3).
- ⚠️ §1 "the data is stable": asserted, never enforced. See **I1**.
- ⚠️ Plan Global Constraint "every list is paginated, including the parts list on the page": built, but defective and untested. See **I2**.

### Strengths

- **The CRITICAL plan correction landed and is measured.** The orphan sweep exempts parts of any non-failed job (`20261101001000:256-262`). QM2 asserts `-|-|-` for a kept three-part backup, QM5 is the positive control that the orphan half still runs, and mutants 21c/21d/21e red it.
- **The IDOR term is checked before the part check.** `audit_export_download` raises `not_your_export` before it looks at parts (`20261101001000:66-88`), so a part number is never an oracle for another person's backup (QD5). The download path reads the part row through the caller's own RLS client, never the service client (`download.ts:74-89`).
- **Guards are tight, and every one has a named mutant.** Server-only part writes, in order, only while running, deletes only of a failed job's parts, and the cascade admitted first. M01-M18 plus M08a/b/c/M11b all red their named assertions, with clean controls before and after (`mutation-results/q228/results.txt`). The 21a-21f files are diffed against the live definition before they are applied, so none is stale.
- **The key contract is bound in both directions.** The CHECK uses `greatest(4, length)`, so a key never truncates, and `exportStorageKey` is tested against the SQL expression for parts 1, 2, 9999, 10000 and 123456 (`closure-parts.test.ts:447-470`).
- **The builder's correctness is tested end to end.** Five ceiling cases each prove the ceiling actually bound (d), that the union of slices equals the reference rows with no duplicates (e), and byte-for-byte documents (f). The tests also cover parity with `buildAndStore` text (j, Q241), no record content in the captured cursors (i, Q240), failure cleanup with a non-empty denominator (C7), and removal past the 1000-row PostgREST page (C10).
- **The documentation is unusually honest.** Residual bounds, Q237-Q241, the re-runnability debt and the order-dependent matrix test are all recorded rather than hidden. The e2e total of 181 tests in 31 files matches the gate log ("Running 181 tests") and the 31 spec files on disk.

---

### Issues

#### Critical

None.

#### Important

**I1. A workspace reopened while its closure backup is still being built breaks the "one stable state" premise. The backup can then succeed with mixed or silently thinned data.**

- **Where:**
  - `supabase/migrations/20261028000000_lifecycle_transitions_lock_and_recheck.sql:485-505`: `reassign_closed_workspace` reads the latest backup id for the audit row only, then reopens with `update public.organisations set deleted_at = null`. It does not check the backup's status.
  - `supabase/migrations/20261028001000_reinstate_needs_an_active_owner.sql`: `reinstate_organisation` reopens a `deleted` workspace before the purge.
  - `lib/export/parts.ts:141-201` and `lib/export/runner.ts:178-191` never re-check the workspace's lifecycle, or the requester's membership, between claims.
  - `public.export_read_page()` (`20261025000000:156-320`) reads under the requester's RLS, which filters rows rather than raising.
  - The premise is asserted in `CLAUDE.md:314` ("parts built across several claims describe one state"), in Q237 (`DECISIONS-QUEUE.md:1635`) and in spec §1 (`2026-10-10-closure-backup-parts-design.md:32`).
- **Why it matters now:** before Q228 a build was one claim, a few seconds long. Now the build lasts as long as the part count requires. The runner does at most 3 claims per invocation (`runner.ts:56`), and the safety-net tick runs every 10 minutes (`20261003005000:220`). That is at most about 18 parts, or about 720 MiB, per hour unless something else nudges the runner. A 2 GB backup is about 3 hours in `queued`/`running`, and a 20 GB Pro workspace is about a day. The superuser sees the closed workspace on `/super/closures` throughout that window and may reassign at any time.
- **Failure scenario:**
  1. An Owner closes a 4 GB workspace, which is about 100 parts.
  2. Two hours in, the backup has 36 parts stored. The superuser reassigns the workspace to the Admin, and the workspace is live again.
  3. The remaining parts read a workspace that members are editing. Rows inserted with uuids behind the cursor are missed, link rows deleted in the meantime are gone, and slices of one table come from different moments.
  4. If the new Owner removes the old Owner, or changes their role, every later part reads under RLS that now filters to 0 rows, or to fewer rows. No error is raised.
  5. The job is stamped `succeeded`, and its index says "Together they are the whole backup". This is exactly the "partial backup presented as a backup" that spec §3 forbids.
  6. A related, benign case: a "delete without a backup" acknowledged mid-build lets the build finish afterwards. `closure_backup_owed()` then holds the purge it was told not to wait for, up to the backup's expiry.
- **Fix (any one):**
  - (a) At the top of `buildNextClosurePart` (or in the runner before it), read the workspace's `lifecycle_state` and the requester's active `owner` membership, using the service client for ids and status only. If the state is no longer `owner_closed`/`deleted`, or the requester is no longer an active Owner, fail the job with a named reason ("the workspace was reopened while its backup was being built"). The existing failure path then removes the parts. Add a psql or integration case: reassign mid-build, the next claim fails, no parts are left.
  - (b) Make `reassign_closed_workspace` and `reinstate_organisation` fail an unfinished closure backup in the same transaction. This is a new migration and an audited change of their contract.
  - (c) If neither fits this branch, queue it as a founder question (Q242) with default (a). Correct the CLAUDE.md and Q237 sentence so it no longer states as fact a property the code does not enforce.

**I2. The parts list is paginated with one shared cursor, cannot go back, and is untested.**

- **Where:**
  - `app/(app)/[orgSlug]/settings/export/page.tsx:75-83` and `:101-108`: one `?partsFrom=n` is applied to every listed multi-part job.
  - `page.tsx:203`: `partsHref` ignores the job id.
  - `components/account/export-job-list.tsx:178`: `JobPartsList` returns `null` when the page is empty.
  - `export-job-list.tsx:115-125`: the single "Download the archive" link is suppressed whenever `partCount > 1`.
  - Nothing renders a "first" or "previous" link.
  - `rg getExportJobParts|partsFrom|export-parts-next|PARTS_PAGE_SIZE tests/` finds nothing. `getExportJobParts`'s `nextFrom` boundary, the "Show parts" link and `?partsFrom` have no unit, integration or e2e coverage. This is despite the Global Constraint "every list is paginated, including the parts list on the page".
- **Failure scenario 1 (the realistic one):** an Owner has a 3 GB backup, which is about 75 parts. They click "Show parts 51 to 75". The page now offers parts 51-75 and no way back to 1-50 except the browser's Back button or editing the URL.
- **Failure scenario 2:** the Owner's list holds two multi-part closure backups (closed, reassigned, closed again; both unexpired), one with 75 parts and one with 12. On `?partsFrom=51` the 12-part backup renders its status line and no download link at all. A stale or hand-edited `?partsFrom=999` does the same to every job.
- **Fix:**
  - Scope the cursor per job (for example `?parts=<jobId>:<n>`, ignored for other jobs).
  - When `fromPart > 1`, render a "Parts 1 to 50" link.
  - If a requested page comes back empty, fall back to page 1 rather than rendering nothing.
  - Add a test of `getExportJobParts` at 50 and 51 parts (`nextFrom` null versus 51), plus either a component test of `JobPartsList` (next link, first link, empty fallback) or an e2e step on a planted 51-part backup.

#### Minor

- **M1. The build's throughput is undocumented, and the page shows no progress.** The figures are in I1: at most 18 parts per hour from the cron tick alone, so a 20 GB backup takes about a day. During that time the Owner sees "Queued"/"Running" with no count, because `JobPartsList` renders only once the backup is downloadable, and `erase_account` refuses the Owner's erasure (QE1). Fix: state the rate in the CLAUDE.md Q228 paragraph and in FOLLOW-UPS. Consider "n parts built so far" on the page, or a re-nudge after a re-queue.
- **M2. A plausible mechanism for the unexplained cold-start 404 (known item cbp9).** At `lib/export/download.ts:101`, `present.data === false` returns 404. But `storage-js@2.112.4` `exists()` returns `{ data: false, error }` for HTTP **400** as well as 404 (`dist/index.cjs:1263-1267`, read). So a storage service that answers 400 during a cold start (tenant or JWT not ready) produces exactly the cbp9 symptom: a fault reported as a refusal, with the misleading log "no archive object". The shape is pre-existing, but Q228 now relies on it for every part. Fix: treat only status 404 as absent and anything else as 500. If it recurs, check for that log line.
- **M3. FOLLOW-UPS gets impersonation wrong (re-grades a known Task 4 minor).** `FOLLOW-UPS.md:4601` says an impersonating superuser "resolves as the Owner under RLS, so that half is the one the page gate actually adds". That is false. The impersonator keeps their own `auth.uid()` and gets the `read_only` role envelope (`lib/auth/index.ts:369-385`). So `org.role === "owner"` is already false, and `getLatestClosureBackup` returns nothing under `export_jobs_select_own`. The page's own comment says the role is the read_only envelope, and the permission matrix reads 0 parts for `superuserAal2`. The untested `!isImpersonated` half is therefore redundant defence in depth, and its being untested is low risk. Fix: correct the sentence.
- **M4. Q239 misses the email.** `lib/email/workspace-closure-templates.ts:123` repeats the "account's exports" promise. Its "removed once it has been downloaded" now means *every part* (Q238). Fix: name the template in Q239 and FOLLOW-UPS § Q228 so the later branch changes both.
- **M5. Over-fetching the manifest.** `getLatestClosureBackup` selects `COLUMNS`, including `manifest` (`lib/export/jobs.ts:127`), but uses only `id` and `status`. The index of a large backup can be megabytes, and `getOwnExportJobs` already reads it once per render. Fix: `.select("id, status")`.
- **M6. The `resume_cursor` comment overstates its privacy.** The comment (`20261101000000:66`) says "never read by a client". But `authenticated` holds table-level SELECT on `export_jobs` (`20260927001000:512`), so the requester can read their own cursor through PostgREST. It holds only ids and counts read under their own RLS, so nothing leaks. Fix: reword it in a later `comment on column`.
- **M7. `closure_backup_owed()` costs O(parts²).** At `20261101001000:136`, `generate_series` × `not exists` scans each job's download rows once per part. That is fine for hundreds of parts and slow at 10k parts inside the hourly sweep's WHERE. It shares a root with the deferred O(n²) cursor rewrites. Fix later: count distinct `part` values once and compare with `greatest(part_count, 1)`.
- **M8. A false index shape in the e2e fixture.** The planted index manifest uses `{ part, storageKey }` (`tests/e2e/support/fixtures.ts:3182-3190`), not `PartSummary` (`key, bytes, rows, slices, files, closedBy`). It is harmless today because the page never reads `manifest.parts`, but it is a false shape for any future reader. Fix: plant a real-shaped index.
- **M9. Part 1's branch is never downloaded in e2e.** The e2e spec downloads part 2 only (`closure-backup-parts.spec.ts:111-115`). Part 1's `storage_key` branch of a multi-part job (`download.ts:72`) is never taken through the route in a browser. Fix: add a `?part=1` 302 assertion.
- **M10. The CLAUDE.md scan ordinal is stale (pre-existing).** The running axe-scan ordinal stops at "33rd and 34th". Later specs, Q228 included, state "2 axe scans" each instead. There is no Q228 inconsistency, and the test count is correct. Fix: when convenient, replace the ordinal chain with a single measured total.

#### Known items, graded (not new)

- **Task 4, `!isImpersonated` untested:** Minor, low. See M3; the half is redundant.
- **Task 4, `lib/supabase/admin.ts` has no importer census:** Minor. Worth doing, because it is the one client a T7 variant could use unseen.
- **Task 4, cbp9 cold-start 404:** Minor. M2 is a concrete hypothesis that matches the symptom.
- **Task 5, e2e green only across two runs (114 + 67 = 181):** acceptable. The 10 failures were all `beforeAll`, during a container health blip, and each file is its own world. Given cbp9, one cold full `pnpm test:e2e` before merge is advisable when the shared stack is free. It does not block.
- **Task 5, 10 pre-existing psql suites not re-runnable:** Minor and pre-existing. It is correctly recorded and none of those suites is touched by this branch. The Q228 suite itself re-runs clean (114/0).
- **Deferred:** the re-queue clause does not freeze outcome columns, but only `service_role` can write them and the runner sends exactly three columns (Minor). The 21a-21f harness question is closed: Task 5's `mutants.py` applies the committed files after diffing them against live, and every one reds a named assertion, so **no full `run-mutation.sh` run is owed**. QK1 cannot go red, and the `coalesce(started_at, requested_at)` ordering is unindexable while the queue stays tiny (both Minor). Writing the whole cursor on every re-queue costs O(n²) (Minor, tied to M7).

---

### Assessment

**Ready to merge: With fixes.** The tenant and privacy boundary holds at every seam: part rows, keys, the index manifest, the cursor and audit rows are requester-only or server-only, and the download path never authorises through the service client. The data-loss boundary is tested and mutation-proven: kept parts are exempt from the sweep, and the purge hold needs every part. What remains is I1 and I2. I1 is a stability premise the docs state as fact but no code enforces, now exposed for hours per build. I2 is a parts-list pagination that breaks navigation for exactly the large backups the feature exists to serve, with no test. Fix both, or queue I1 explicitly with its doc sentence corrected, and the branch is ready.

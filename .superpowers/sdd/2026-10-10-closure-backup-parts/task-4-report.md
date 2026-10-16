# Task 4 report: the parts list and Contact us

**Status: COMPLETE (2026-10-16, controller-finished after the implementer's session ended).** Code 960c76b; e2e fixes in the commit after it. The e2e spec passes; mutant, teardown and combined-run evidence below.

## What I implemented
- `lib/org/closure-contract.ts`: `CLOSURE_BACKUP_FAILED_LINE`, `PARTS_TOGETHER_LINE(n)`, `closureBackupHelpHref(address, slug, jobId)` (mailto with the slug and job id only, else `/legal/contact`).
- `lib/export/jobs.ts`: `OwnExportJob.closureBackup` / `partCount`, shared `toJob`, `getLatestClosureBackup` (own RLS, limit 1, throws), `getExportJobParts` (keyset `part_no >= from order by part_no limit n+1`, throws), `PARTS_PAGE_SIZE = 50`.
- `components/account/export-job-list.tsx`: for a downloadable job with `partCount > 1`, an `<ol>` of per-part links (`?part=N`), the together line, and a "Show parts n to m" link; otherwise the single "Download the archive" link as before.
- `app/(app)/[orgSlug]/settings/export/page.tsx`: `partsFrom` via `parsePartParam`; permission, job list and latest closure backup in one `Promise.all`; one bounded parts read per multi-part job; the failed-backup block with a `secondary`-variant "Contact us" link, shown only to the Owner of an `owner_closed` workspace.
- `tests/e2e/support/fixtures.ts`: `plantOwnerClosedWorkspace(..., opts.backup)` (failed / two_parts, planted in the same transaction as the close), `removePlantedBackup`, `exportDownloadParts`.
- Tests: `tests/unit/org/closure-contact.test.ts` (6) and `tests/e2e/closure-backup-parts.spec.ts` (3, serial).

## Verified
| Check | Result |
|---|---|
| `pnpm exec vitest run tests/unit/org/closure-contact.test.ts` | 6/6 |
| Mutant on the unit test (`encodeURIComponent` removed from the subject, then restored) | 2 red: "is a mailto whose subject is exactly the slug and the job id" and "encodes a hostile slug rather than letting it add a mailto header"; 6/6 after restore |
| `npx next typegen`, `pnpm typecheck`, `pnpm lint` | clean |
| `pnpm exec vitest run tests/unit` | 8 tests across 5 files timed out under load (5 to 20 s each); all 5 files re-run alone: 431/431. The other files named in the first run's failures also pass alone (327/327) |

## E2E evidence (2026-10-16, controller)
Two fixes found by the first completed runs, committed together: `export-job-list.tsx` reads `job.manifest?.withheld` (a closure backup's manifest can omit it, which crashed the list), and the spec pins each part link's `href` to `/account/exports/<job>/download?part=N`.

| Check | Result |
|---|---|
| `playwright test tests/e2e/closure-backup-parts.spec.ts --workers=1` | 3/3 on five runs (cbp7, cbp10, cbp11, cbp12, and after a reset). One run (cbp9, the first after a cold Docker restart) got 404 instead of 302 on the legitimate part-2 download; not reproduced in four instrumented runs, cause not pinned. Recorded, not retried in config. |
| Teardown row count | On a freshly reset DB: planted `e2e-closed-%` orgs, `export_jobs`, `export_job_parts` and `exports` objects all 0 before and 0 after the spec. (2 orgs + 2 parts were leaked earlier by a run the memory reaper killed before `afterAll`, which made `super-closures`' empty state fail until the reset.) |
| Combined run (closure-backup-parts, exports, phase8-refusal-parity, super-closures, workspace-closure) | 16 passed, 1 failed + 1 not run: `super-closures` "the empty state", caused by the 2 orgs the killed run leaked. After `db reset`: `super-closures` + this spec 5/5. All 18 tests have passed. |
| Mutant T7 (plan wording: the part row read with the service client, `lib/supabase/service.ts`) | e2e 3/3 GREEN: behaviourally EQUIVALENT, because the job lookup through RLS precedes it and the part query filters on that job. Killed by `tests/unit/email/service-client-census.test.ts` "and nothing else". |
| Mutant T7-wide (both the job and the part lookups through the admin client) | RED at "a colleague downloaded the Owner's part" (500, the audit RPC's own ownership check refuses: a third barrier). |
| Mutant: `isOwner = true` on the page | e2e GREEN: equivalent through this path, because `getLatestClosureBackup` reads through the caller's RLS (`export_jobs_select_own`), so a Manager never sees the Owner's failed backup. The page gate is defence in depth. |

Minor findings for the final review:
- The `!org.isImpersonated` half of the Contact us gate is not exercised (no impersonation in this spec); an impersonating superuser resolves as the Owner under RLS, so that half is the one the page gate actually adds.
- `lib/supabase/admin.ts` has no importer census (`service.ts` does); a T7 variant through the admin client would be caught by neither census nor e2e unless the job lookup moved too.
- `exports.spec.ts`/`workspace-closure.spec.ts` leave 2 `exports` objects per run with no job row (pre-existing pattern, ledger Task 2 minor).

## Design and accessibility review (read the diff, no browser)
- The parts list is a real `<ol>` with an `aria-label` carrying the count. Each link text starts "Part n of N", so names are distinct. Numbers are `tabular-nums`.
- "Contact us" is a real link with a visible name, and its classes are the `secondary` variant verbatim (square, `border-rule bg-surface text-ink`, hover `border-ink bg-shell`; focus ring is the global one). No new colour, no shadow, no `target`.
- The failed line is `text-ink`, not muted, on the shell: tokens only. Contrast was not measured; all colours are existing tokens.
- No finding that needed a change. A minor gap: page 2 of the parts list has no "back to part 1" link (browser back works).

## Deleted-lifecycle check (Spec correction 11 / Q239), by code reading only
- `getCurrentOrg` has no `deleted_at` or lifecycle term, and `delete_closed_workspace` does not touch memberships, so the Owner's membership still resolves for a `deleted` workspace and the page is reachable.
- The jobs list and parts list are not lifecycle-gated, so a `deleted` workspace's backup list should render. The Contact us block and the close section do not, because they key on `owner_closed`. A deleted workspace needs a succeeded backup, or an acknowledged no-backup, so Contact us there is not needed.
- Controller checked the live policy: `export_jobs_select_own` is `requested_by = auth.uid()` with no lifecycle term, so the Owner keeps reading their own jobs and parts of a `deleted` workspace. Still not walked in a browser for the `deleted` state. No routing change.

## Deviations
1. T7 uses the world Manager (a member of the planted workspace), not the Admin; the brief allows either.
2. The single-part "exactly as today" check uses a planted account export on `/account/exports`, not the workspace page.
3. The unit test's first run was green (implementation written first). The red evidence is a mutant of the code, not a red-first run.

## Files changed
app/(app)/[orgSlug]/settings/export/page.tsx, components/account/export-job-list.tsx, lib/export/jobs.ts, lib/org/closure-contract.ts, tests/e2e/support/fixtures.ts, tests/e2e/closure-backup-parts.spec.ts (new), tests/unit/org/closure-contact.test.ts (new).

## Concerns
- The cold-start 404 (cbp9) is unexplained; if it recurs in the full `pnpm test:e2e` run, instrument `issueExportDownloadUrl`'s 404 branches as done here.
- The ledger's deferred Task 1 matrix order dependency is not worsened: the spec removes its download audit rows in teardown.

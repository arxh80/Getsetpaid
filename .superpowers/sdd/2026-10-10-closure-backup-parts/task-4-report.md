# Task 4 report: the parts list and Contact us

**Status: PARTIAL: e2e owed.** Code committed and pushed (960c76b). The new Playwright spec has never completed a run, so every browser behaviour is unverified.

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

## Owed (not verified)
- The e2e spec: all three tests (Contact us for the Owner only, with the succeeded-backup and Manager denominators; two parts with the 302, the audit row's `after.part` = 2 and 404 parity including the colleague check; single-part unchanged) and the axe scans.
- The teardown row-count check (planted orgs and jobs before and after).
- Mutant evidence for the e2e assertions (T7 and the part guard on the page).
- The combined run with workspace-closure, exports, super-closures and phase8-refusal-parity specs.
- Why: two Playwright runs were killed by the memory-pressure reaper before any test executed (free RAM about 1.7 GB before, 1.2 GB after).

## Design and accessibility review (read the diff, no browser)
- The parts list is a real `<ol>` with an `aria-label` carrying the count. Each link text starts "Part n of N", so names are distinct. Numbers are `tabular-nums`.
- "Contact us" is a real link with a visible name, and its classes are the `secondary` variant verbatim (square, `border-rule bg-surface text-ink`, hover `border-ink bg-shell`; focus ring is the global one). No new colour, no shadow, no `target`.
- The failed line is `text-ink`, not muted, on the shell: tokens only. Contrast was not measured; all colours are existing tokens.
- No finding that needed a change. A minor gap: page 2 of the parts list has no "back to part 1" link (browser back works).

## Deleted-lifecycle check (Spec correction 11 / Q239), by code reading only
- `getCurrentOrg` has no `deleted_at` or lifecycle term, and `delete_closed_workspace` does not touch memberships, so the Owner's membership still resolves for a `deleted` workspace and the page is reachable.
- The jobs list and parts list are not lifecycle-gated, so a `deleted` workspace's backup list should render. The Contact us block and the close section do not, because they key on `owner_closed`. A deleted workspace needs a succeeded backup, or an acknowledged no-backup, so Contact us there is not needed.
- UNVERIFIED in a browser, and `export_jobs_select_own` was not checked for a lifecycle term. I changed no routing. If the e2e shows it does not render, record it in Q239's text.

## Deviations
1. T7 uses the world Manager (a member of the planted workspace), not the Admin; the brief allows either.
2. The single-part "exactly as today" check uses a planted account export on `/account/exports`, not the workspace page.
3. The unit test's first run was green (implementation written first). The red evidence is a mutant of the code, not a red-first run.

## Files changed
app/(app)/[orgSlug]/settings/export/page.tsx, components/account/export-job-list.tsx, lib/export/jobs.ts, lib/org/closure-contract.ts, tests/e2e/support/fixtures.ts, tests/e2e/closure-backup-parts.spec.ts (new), tests/unit/org/closure-contact.test.ts (new).

## Concerns
- The e2e spec is untested, so it may need fixes (selectors, the storage-host regex on the 302 `Location`, the teardown order).
- The ledger's deferred Task 1 matrix order dependency is not worsened: the spec removes its download audit rows in teardown.

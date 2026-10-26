wrote /c/Users/archi/Documents/Work/Portfolio/Getsetpaid/.claude/worktrees/launch-hardening/.superpowers/sdd/2026-10-16-launch-hardening/task-24-brief.md: 19 lines
te.export_limits()`), and passing it FAILS the job (`lib/export/runner.ts`, `lib/export/zip.ts:323`). A workspace export carries every clean document's bytes, so two 25 MiB riders make every export of that workspace fail. An account export carries the person's feedback screenshots (up to 5 MiB each, 10 an hour), so a heavy feedback submitter's statutory access export can fail for ever. Q228 already built a parts builder for closure backups (`lib/export/parts.ts`, `20261101000000`, spec `docs/superpowers/specs/2026-10-10-closure-backup-parts-design.md`).

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


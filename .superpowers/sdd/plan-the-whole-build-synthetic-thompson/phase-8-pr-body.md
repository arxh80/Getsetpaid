# Phase 8: Legal and privacy

This phase adds GetSetPaid's legal pages, consent, data-subject rights (requests, export and
erasure), automatic retention, audit coverage for the Phase 3-6 tables, permission tests, and
the founder rulings of 2026-09-30.

Branch `worktree-legal-phase` at `605620e`: 325 commits over `main` (`68f96cf`), and migrations
126 → **238**. The merge is clean, because both parents of #25 are ancestors.

## What shipped, task by task

**Task 1. The fifteen legal pages.**
- `/legal/<slug>` works signed out and is linked from every footer.
- The founder edits the pages at `/super/legal` without a deploy. A published version is
  frozen for every role.
- Every page shows a "draft pending legal review" notice. It stays until counsel's review of
  that exact version is recorded. None has been reviewed yet.

**Task 2. Consent and a storage census.**
- An append-only consent ledger. Marketing email is a withdrawable preference at
  `/account/privacy`.
- There is no cookie banner, because everything stored today is strictly necessary.
- In its place, a source census runs in CI and goes red the moment a non-essential cookie,
  storage key, script or tracker appears. A browser census does the same on a developer's
  machine.

**Task 3. Data subject requests.**
- People use `/account/data-requests` to exercise the six GDPR rights. The operator works them
  from a queue at `/super/data-requests`.
- The database computes the 30-day deadline, and no role can change it. A real state machine
  controls each request's status.
- Operator notes live in a table the requester cannot read.
- A deadline that is close or already missed raises an alert.

**Task 4. Two data exports.**
- `/account/exports` gives a person everything the platform holds about them.
- `/[orgSlug]/settings/export` gives an Owner or Admin everything the workspace holds,
  soft-deleted rows and files included.
- Both are built in the background and downloaded from a private bucket. Each download is
  audited and expires.
- The workspace export is built under the requester's own access rights, so a colleague's
  private notes are never in it.
- A census fails if a table is missing from the export.

**Task 5. Account erasure.**
- `/account/erase` deletes the account in one all-or-nothing database transaction.
- The audit trail is pseudonymised onto one "tombstone" identity, not deleted.
- Private notes are hard-deleted. The workspace's own records stay.
- A last Owner who would strand a workspace is refused, with a message naming that workspace.

**Task 6. Retention and garbage collection.**
- One scheduled sweep purges:
  - expired document bytes;
  - feedback and its screenshots;
  - stale rate-limit counters;
  - resolved alerts;
  - failed jobs and stuck jobs;
  - expired export archives and orphaned files;
  - workspaces 60 days after they close;
  - the audit log at one year.
- Every period is declared in one place, so counsel's answer becomes one migration.
- The audit purge has five independent safety rails and its own kill switch.

**Task 7. Audit coverage for the Phase 3-6 tables.**
- Every client write to sixteen more tables is now audited, with the column names only and
  never tenant content.
- A census derived from the catalogue fails when a new table has no audit writer.

**Task 8 and 8a. Permission tests and census hardening.**
- The permission matrix and censuses now cover every Phase 8 surface.
- A detached mutation driver ran 36 mutants with 0 false greens.
- One `run_suite()` now pins every psql suite's assertion total, so an assertion that vanishes
  is a failure rather than a silent pass.

**Task 9a. The founder's 2026-09-30 rulings.**
- The hosts are named on the legal pages: Supabase in Ireland (eu-west-1), and an IONOS VPS
  whose region is pending.
- The account export includes the break-glass reason.
- The founder can release the audit-purge ceiling for 3 days.
- "File deleted under the retention policy" replaces Restore on a purged document.
- Uploads are limited to 10 per hour.

**Task 9b. All notification emails, and Telegram alerts.**
- Emails now go out for:
  - DSR received and closed;
  - export ready;
  - erasure failure;
  - connection requests received, accepted and declined;
  - task reminders.
- They all go through the one Brevo sender on the existing 10-minute tick.
- Operator alerts are sent by email and by a counts-only Telegram bot, which replaces SMS.

**Task 9c. An Owner can close their own workspace.** This reverses Q104.
- Closing makes the workspace read-only for every member and takes an automatic full backup.
- The superuser is emailed. At `/super/closures`, behind step-up and with an audited reason,
  they either reassign the workspace to a new Owner or delete it.
- The 60-day purge is the backstop if nobody decides.

## Security fixes found along the way

- **Two pre-existing Phase 6 Criticals (Task 9b).** Both were found by probing, and both
  leaked a target's connections-level fields.
  - A sender could INSERT a connection request that was already `accepted`. Fixed with a
    `born_pending` trigger and policy.
  - A requester could UPDATE or repoint its own request into "X → T accepted". Fixed with a
    `bound_update` trigger and a status-only column grant.
- **`/super` was an existence oracle (Task 8).** The raw HTML differed per route (67/70/59 KB),
  so a signed-in non-superuser could tell which `/super` pages exist. A middleware rewrite now
  sends every such request to one fixed not-found route.
- **Task 5.**
  - An owner id snapshot in `merge_candidates` survived a "completed" erasure. Closed by a
    derived roll of every FK-less uuid column, and erasure refuses when that roll is
    incomplete.
  - Two concurrent erasures could strand a workspace with no Owner. Closed with locks and a
    re-check after the delete.
  - An Admin could demote the last Owner.
- **Task 6.**
  - A tenant could set a document's retention clock and its period, so a seven-year financial
    file could be destroyed within the hour.
  - The runner deleted bytes before its safety checks ran.
- **Task 7.** Third-party user ids inside audit payloads survived erasure.
- **Task 9c.** The closure backup held no finance or network rows, because it was read under
  the post-closure rights. The Phase 7 lifecycle actions also bypassed the closure decision,
  and two lifecycle transitions could race each other.
- **Smaller ones.**
  - Quadratic regexes on the public legal render path (a ReDoS).
  - A Task 3 guard that was dead code.
  - A `"use server"` constants bug that silently dropped every export of one module. A census
    now prevents it.
  - A browser-supplied `resolved_at` that could silence an overdue DSR.

## Gates at the tip

- **psql/HTTP:** all passed. 26 suites at their pinned totals, **4226** assertions, plus the
  lifecycle and retention concurrency probes.
- **vitest:** **3810**.
- **Playwright:** **178 passed / 0 failed** in 30 files, run at `b0eac34` with the same 238
  migrations.
- **Migrations:** **238**, unchanged around every long run.
- lint and typecheck are clean.

## CI is a subset

`.github/workflows/ci.yml` runs lint, typegen, typecheck, `tests/unit`, `pnpm audit` and
gitleaks. It does **not** run `tests/integration`, the psql/HTTP suite or Playwright, and those
are the tenant-boundary, erasure and retention suites this phase depends on.

**A green tick on this PR is not a green phase.** The numbers above come from a developer
machine. Q169's heavy CI jobs are ruled but not built; they come in Phase 9 with
`infra-parallel-stacks`.

## Open questions for the founder

- **Q227.** The closure-backup read marker sits on the network-leakage path, in
  `permitted_organisations()`. Default (a) is built and the censuses acknowledge it. Please
  confirm it, along with the extra `export_job_id` column.
- **Q228.** A failed closure backup is never rebuilt. The options are (i) an audited re-queue,
  (ii) higher ceilings for closure backups, or (iii) keep the "Delete without a backup"
  acknowledgement, which is what ships now.
- **Q189.** The recommended default was to audit an Owner's rename of a workspace, and it is
  not built.
- **Product calls, each shipped with a default:**
  - Q205: members of a closed workspace lose finance reads.
  - Q209/Q226: no one can retrieve a closure backup after a reassign.
  - Q212: the decision email carries no reason.
  - Q215/Q223: the superuser sees member names on `/super/closures`, and each view is audited.
  - Q200: a failed erasure's reason has no dashboard view.
  - Q195: a ceiling release cannot be revoked early.
- **For counsel:**
  - Q194/Q197: the scope of the account export;
  - Q198: Telegram with no sub-processor row;
  - Q199: no closure email to an erased requester;
  - Q201: the 7-day notice window;
  - Q188: the network-link audit row and Q82;
  - the earlier list: Q130, Q132, Q133, Q139, Q140, Q146, Q148-Q150, Q158, Q173, Q177;
  - all fifteen legal pages.

## Known follow-ups

- **Docs drift from final review B.** See `phase-8-final-review-B.md`.
  - The Brevo row in the sub-processor register does not list the Phase 8 notification emails.
  - Several CLAUDE.md and SECURITY.md counts are stale: 25 → 26 suites, 21 → 23 runners, the
    matrix headline, and nine → ten `/super` pages.
  - A "no hard-purge path" sentence is now false.
- **Q218.** Six network pages still say "suspended" inside a closed workspace.
- **F-T7-1.** The refusal-parity test runs close to its 60 s timeout.
- **F-T8-1.** A unit-test timeout under load.
- **Task 7 N1/N2.**
- **9c re-review nits n1-n3.**
- **Task 8 M2/M3.**
- **Fix rounds never independently re-reviewed.** Task 1 fix round 2 and Task 2 fix round 2.
- **Never measured at the tip.** The permission-matrix total (596 at 9c job 3a).
- **Deploy items (`SECURITY.md` § 15).**
  - The runner bearer secrets and Vault pairs.
  - The Brevo and Telegram environment values.
  - A check that the project is in `eu-west-1`.
  - The IONOS region.
  - The real malware scanner (Q42, a launch gate).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Kk6L3AvEozTtzVHZ88Doxv

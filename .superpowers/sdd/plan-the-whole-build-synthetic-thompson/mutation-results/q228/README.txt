Q228 mutation run (results.txt) -- Task 5, 2026-10-16, at 249 migrations (branch tip c89826e + docs)

- Driver: mutants.py, modelled on ../phase9/mutants.py. Run as `python mutants.py` from anywhere,
  after `npx supabase db reset --local` and one full `bash supabase/tests/run-rls-tests.sh` on that
  database ("All suites passed"), because the cw and xp suites read the runner's fixtures (the driver
  rebuilds the runner's P7VARS from the fixture users by email).
- SQL mutants: each applied to the LIVE database and restored in a finally block (CREATE OR REPLACE
  from the definition captured before any mutant ran, or the inverse DDL), not by a reset and not in
  begin..rollback.
  - M01-M11 and Task 1's extras (M08a/M08b/M08c split M08; M11b = the trigger no longer clears
    resume_cursor on a failure, numbered M12 in Task 1's own run and renamed here so M12-M18 keep the
    plan's numbers): a function redefinition from its pg_get_functiondef with one change, or one DDL
    statement.
  - M12-M17 apply the committed static mutants supabase/tests/mutations/21a-21f as they are, and M18
    applies supabase/tests/mutations/10-export-download-authorisation.sql. Before applying, the driver
    diffs each file's function against the live pg_get_functiondef and writes the changed lines into
    results.txt (the "-- Mnn file ... vs live" lines): every file differs from live by its one stated
    change and nothing else, so none is stale. This replaces Task 3's quick apply/run/restore driver
    for 21a-21f with the scripted run.
- Suites per mutant: qp (rls_q228_closure_backup_parts.sql, 114) for all; plus cw
  (rls_phase8_workspace_closure.sql, 181) for M12 and M13; plus xp (rls_phase8_exports.sql, 139) and
  the permission matrix's "cannot audit-and-download a job that is not theirs" for M18.
- Controls: qp 114/0 and cw 181/0 before and after. xp shows THE SAME THREE state-dependent reds in
  both controls (XD7, XD8, XZ4): the exports suite counts and deletes `export_job.*` audit rows
  globally, so on any database where later suites have written export audit rows it is not
  re-runnable. That predates Q228 (see task-5-report.md, "xp on a second run"); M18's xp result is
  read against that control (it adds XD2, XD3, XD5). The matrix control: 9 passed.
- TypeScript mutants T1-T6: the source edited in place (CRLF-aware), the named Vitest file run (with
  the -t case filter for the closure-parts integration file), then `git checkout -- <file>`; the
  driver refuses to edit a file with uncommitted changes and ends by asserting `git status lib/`
  is clean. T7 is e2e-only and was measured in Task 4 (EQUIVALENT in e2e; killed by
  tests/unit/email/service-client-census.test.ts "and nothing else"); it is not re-run here.
- clean.sql: removes any qp-* fixture a mutant that aborted the suite before its QZ housekeeping
  left behind; run before every qp run.
- results-task1.txt: Task 1's own run (2026-10-11, qp at 82 assertions, M01-M12 in Task 1's
  numbering); superseded by results.txt, kept as the record task-1-report.md cites.
- progress.log: START/END per run.

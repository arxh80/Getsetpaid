# SDD ledger — plan: docs/superpowers/plans/2026-10-10-closure-backup-parts.md
Controller: spec written; plan written by planner (opus), 5 tasks, 12 spec corrections recorded in plan (critical: orphan sweep would delete parts 2+ after 1 day -> Task 3)
Task 1: dispatched (base 03c4942, opus)
Task 1: implemented 91cfcd8 (report DONE_WITH_CONCERNS); review dispatched 2026-10-13 after context reset
Task 1: review — spec OK with 2 deviations ACCEPTED by controller (failed job clears resume_cursor, M12 guards it; guard checks cascade before session); quality not approved: 2 Important (no test evidence in report; export_job_parts in OWN_ROW_RELATIONS with no matrix describe)
Task 1: minor (deferred): no part insert/delete from a real service_role session (all as postgres)
Task 1: minor (deferred): re-queue clause does not forbid result columns (storage_key/manifest/byte_size/failure_reason) changing on running->queued (brief-verbatim)
Task 1: minor (deferred): QK1 cannot go red (reaper never selects queued)
Task 1: minor (deferred): QE1 checks erasure refusal only while queued, not running
Task 1: minor (deferred): claim ordering coalesce(started_at, requested_at) unindexable
Task 1: minor (deferred): mutation driver filed under another plan's folder
Task 1: minor (deferred): QZ1 does not confirm auth.users/audit_events cleanup
Task 1: fix round 1 implemented e837bfb (matrix describe for export_job_parts; evidence: psql all green + Q228 twice at 82, vitest 662/662, lint+typecheck 0); scoped re-review dispatched
Task 1: minor (deferred): matrix "no download was audited" test fails if run straight after the psql runner (leftover export_job.downloaded audit row) — order dependency, passes on a reset DB
Task 1: minor (deferred): matrix export_job_parts block plants the job row under replica, not via close_my_workspace; no mutation run against the new block
Task 1: fix round 1/5 (2 addressed, 0 open; commits 91cfcd8..e837bfb)
Task 1: complete (commits 03c4942..e837bfb, review clean)

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
Task 2: dispatched (base 21a2ef4, opus)
Task 2: implemented da2e99f (DONE_WITH_CONCERNS: fixture sizes, C7 ceiling, ZipWriter store option, buildAndStore takes limits from caller); review dispatched
Task 2: review — spec FAIL (residual-bound refusals untested; removeClosureParts unbounded read), 8 deviations accepted; plan-mandated: filenames in resume cursor (controller default: constraint governs, ids only — to DECISIONS-QUEUE), verbatim buildAndStore copies (default: parity assertion). Fix round 1 dispatched (resumed implementer)
Task 2: minor (deferred): test (f) asserts <=1 manifest naming quarantined doc, brief says exactly 1 (drop-push mutant survives)
Task 2: minor (deferred): writeDocuments "too large for any part" keys on entryCount===0 not isEmpty
Task 2: minor (deferred): page exactly filling row allowance not treated as table-finished (extra parts; weakens (d))
Task 2: minor (deferred): ceiling-pin formula omits per-file manifest reserve (~2061 vs 2048) — plan-mandated
Task 2: minor (deferred): cursor/index rewritten each claim, O(n^2) jsonb writes
Task 2: minor (deferred): effectiveLimits accepts zero/negative overrides (test-only)
Task 2: minor (deferred): ordinary jobs make one extra export_jobs SELECT before buildAndStore
Task 2: fix round 1/5 — 5d8a6ac (base da2e99f): all 4 findings ADDRESSED per scoped re-review (C9 row-over-part refusal, placeIndex unit refusal, removeClosureParts order desc limit 1 + C10 1005 parts, cursor ids-only + check (i), parity check (j)); mutants F1a/F1b/F2/F3/F4 red
Task 2: minor (deferred): test-only cursor-logging trigger on public.export_jobs logs other sessions' jobs on the shared DB while closure-parts.test.ts runs
Task 2: minor (deferred): readDocumentNames runs on every index-phase claim, including a re-claim that only defers the index
Task 2: minor (deferred): exports bucket holds 6 leftover objects from runner.test.ts (teardown deletes job rows, not archives) — pre-existing
Task 2: complete — da2e99f..5d8a6ac

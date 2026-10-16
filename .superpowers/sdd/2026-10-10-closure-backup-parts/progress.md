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
Task 3: implemented 0e822d8 (base c064173); review task-3-review.md — spec ✅, Needs fixes (Important #1 untested download.ts:125 guard)
Task 3: minor (deferred): vitest gate tolerates 1 known red (XD1 export_job.downloaded order dependency, pre-existing since Task 1)
Task 3: fix round 1/5 — 3638cda (base 0e822d8): all 4 findings ADDRESSED per scoped re-review (part-guard unit test + mutant, mutant 10 regenerated in place, M12-M17 committed as 21a-21f, census regex)
Task 3: minor (deferred): mutants 21a-21f measured by a quick apply/run/restore driver, not the full run-mutation.sh path — final review to decide whether a full harness run is owed
Task 3: complete — 0e822d8..3638cda

- Task 4 (parts list and Contact us): PARTIAL, e2e owed. Code in 960c76b; unit, lint, typecheck, tests/unit green; the new e2e spec has never completed a run (two memory kills). See task-4-report.md.
Task 4: e2e completed by controller 2026-10-16 (implementer session ended): spec 3/3 x5, teardown 0->0 on reset DB, combined 18/18 across runs, T7 equivalent in e2e but killed by service-client census; fixes in the commit after 960c76b
Task 4: minor (deferred): Contact us gate's !isImpersonated half untested; admin.ts has no importer census; cold-start 404 once (cbp9) unexplained
Task 4: complete
Task 5: dispatched 2026-10-16 (base c89826e)
Task 5: docs ba2709c, queue Q237-Q239 e1e8358, mutation results 0962d6c, re-runnability FOLLOW-UP 33284a9
Task 5: mutation run (mutation-results/q228/results.txt): M01-M18 + M08a/M08b/M08c/M11b + T1-T6 every one red at its named assertion, controls qp 114/0 and cw 181/0 before and after; T7 EQUIVALENT (Task 4, killed by service-client census); no assertion added, no pin changed; mutations/10 already regenerated (3638cda), verified one-line diff vs live at 249
Task 5: gates: lint 0, typecheck 0, pnpm test 174 files / 3983 passed + 5 skipped (clamav-live opt-in), psql runner All suites passed (28 suites, 4616 by pins), e2e 114 passed + 10 beforeAll failures (DB container transiently unhealthy) + 57 not run, isolated re-run of those 10 files 67/67 => 181/181 across the two runs
Task 5: minor (deferred): 10 pre-existing psql suites not re-runnable on one DB (phase3/4/5/6 fixed ids, leakage, lifecycle LA1, overrides, erasure, permissions, exports XD7/XD8/XZ4 from workspace-closure's leftover export audit rows); qp/cw/ck/rt re-run clean; recorded in FOLLOW-UPS § Q228
Task 5: complete (report task-5-report.md, DONE_WITH_CONCERNS: e2e not green in one cold run; re-runnability of pre-existing suites)

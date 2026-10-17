# SDD ledger — plan: docs/superpowers/plans/2026-10-16-launch-hardening.md

Branch `launch-hardening`, worktree `.claude/worktrees/launch-hardening`, stacked on `q228-closure-backup-parts` (ce1fda1, PR #32). Spec `docs/superpowers/specs/2026-10-16-launch-hardening-design.md`; plan `docs/superpowers/plans/2026-10-16-launch-hardening.md`. Q243 = design approval (default: proceed); next free Q = Q244.

Baselines at ce1fda1 (2026-10-16, fresh resets): psql runner "All suites passed" (28 suites, qp 119); pnpm test 175 files / 4012 passed + 5 skipped (clamav-live); permission matrix 620; e2e 181 tests (32 of the six closure/export/super specs green across runs; a whole-suite single run is not achievable on this machine: dev server > 3 GB).
Open PRs below this branch: #32 (Q228), #33 (Subprocessors v4, off main).

Phase 10: plan written 2026-10-16; census smoke-tested (87 routes: 47 exact axe, 5 by tail, 35 candidates; 32 candidate unbounded list reads; 31 rate-limit keys, 1 untested; 191 SECURITY DEFINER functions, 107 not named in matrix/census -- all candidates, to be read by hand in Task 1)
Task 1: dispatched 2026-10-16 (base af69ee4, opus) -- launch-gate inventory
Task 1: implementer DONE_WITH_CONCERNS 2026-10-17 -- 8ecbf31 (census), 52cf539 (docs/launch-gates.md); 31 gaps (1 Critical G11, 10 High)
Task 1: review 1 (opus) Needs fixes -- 3 Important: G10/G16 under-graded vs own rubric; G11 remediation misses the confirmations-ON created:true takeover; gate 4 re-measure names the census route verdict (plan-mandated verbatim script)
Task 1: fix round 1 -- 1f2e4fa (G10, G16 -> High: 1 Critical, 12 High, 14 Medium, 4 Low; G11 created:true + forced new password; gate 4 caveat; all 7 Minors fixed too)
Plan: Part B written 2026-10-17 as Tasks 4-16 (numeric so task-brief extracts them); Part C renumbered Tasks 17-18. Order: Task 4 (G11, Critical) runs right after Task 1, before Tasks 2-3; then Tasks 2, 3, 5..16, 17, 18.
Task 4: dispatched 2026-10-17 (base 19c94bf, opus) -- G11 invite pre-hijack (Critical); jumps ahead of Tasks 2-3
Task 1: re-review round 1 (sonnet) -- all findings addressed
Task 1: minor (deferred): G11 item (3) created_at discriminator would refuse a legitimate re-invite (forwarded to Task 4 as a constraint)
Task 1: minor (deferred): G11 cites :258-261 for the signed-up-unconfirmed case; that is GoTrue behaviour to confirm by experiment (forwarded to Task 4)
Task 1: complete 2026-10-17 -- 8ecbf31, 52cf539, 1f2e4fa; plan Tasks 8 and 14 amended from the re-review's out-of-scope notes (per-IP boundary not driven on the shared stack; entities.ts:85-92 fail-open)
Task 2: audit phase dispatched 2026-10-17 (opus, read-only alongside Task 4; writes task-2-findings.md + docs/threat-model.md for G19; fix phase resumes after Task 4)

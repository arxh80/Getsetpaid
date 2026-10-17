# SDD ledger — plan: docs/superpowers/plans/2026-10-16-launch-hardening.md

Branch `launch-hardening`, worktree `.claude/worktrees/launch-hardening`, stacked on `q228-closure-backup-parts` (ce1fda1, PR #32). Spec `docs/superpowers/specs/2026-10-16-launch-hardening-design.md`; plan `docs/superpowers/plans/2026-10-16-launch-hardening.md`. Q243 = design approval (default: proceed); next free Q = Q244.

Baselines at ce1fda1 (2026-10-16, fresh resets): psql runner "All suites passed" (28 suites, qp 119); pnpm test 175 files / 4012 passed + 5 skipped (clamav-live); permission matrix 620; e2e 181 tests (32 of the six closure/export/super specs green across runs; a whole-suite single run is not achievable on this machine: dev server > 3 GB).
Open PRs below this branch: #32 (Q228), #33 (Subprocessors v4, off main).

Phase 10: plan written 2026-10-16; census smoke-tested (87 routes: 47 exact axe, 5 by tail, 35 candidates; 32 candidate unbounded list reads; 31 rate-limit keys, 1 untested; 191 SECURITY DEFINER functions, 107 not named in matrix/census -- all candidates, to be read by hand in Task 1)
Task 1: dispatched 2026-10-16 (base af69ee4, opus) -- launch-gate inventory

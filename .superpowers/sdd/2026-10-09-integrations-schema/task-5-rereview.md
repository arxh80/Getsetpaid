# Task 5 re-review (fix base 5666782, head f5cb6f9)

### Finding Verdicts
- **I1** - ADDRESSED (evidence is the implementer's statement only). task-5-report.md "Fix round 1" records a fresh-reset, no-config-change cold run: 178 passed, 0 failed, 0 not run, 20.6 min, RAM 2.69 GB at start; matches CLAUDE.md's 178 tests/30 files. progress.md Task 5 complete line is rewritten to state the first 172/4/2 run and the 178 re-run. No e2e log file is cited or present in the worktree, so the 178 figure could not be confirmed from a log.
- **I2** - ADDRESSED. SECURITY.md section 2 gap 2 and FOLLOW-UPS.md Phase 9 Task 5 now state Q236's default (b), restrict p_owner_user_id to the caller, with callback binding as an additional connector-time check.
- **I3** - ADDRESSED. run.sh now does `rc=$?` straight after python and logs `exit=$rc`. README.txt records DDL restores, that a fresh reset preceded later gates, and explains the 4 s first run (wrong relative suite path, depth 4 to 5, exit=0 meaningless).
- **M1** - ADDRESSED. CLAUDE.md: column-level SELECT on integration_connections, table-level on integration_sync_runs.
- **M2** - ADDRESSED. SECURITY.md section 2: "eleven mutants plus a control", the control turning none red.
- **M3** - ADDRESSED. Note moved to a new SECURITY.md section 7 subsection; conditional (person on session audited, IM6 Owner audited; tombstone only with no session). Section 4 keeps a pointer line; FOLLOW-UPS now says section 7.
- **M4** - ADDRESSED. Phase 9 clause is now the last in CLAUDE.md Current state, and the earlier duplicate placement is gone.
- **M5** - ADDRESSED. mutants.py writes results-<names>.txt for subset runs, results.txt only for a full run; README documents it.

### New Breakage in the Fix Diff
None.

### Out-of-Scope Observations
- mutants.py and run.sh header comments still say "12 mutants" (12 entries including the control); consistent with the docs' "eleven plus a control", just loosely worded.

### Verdict
**Fix round:** All findings addressed, no new Critical/Important breakage

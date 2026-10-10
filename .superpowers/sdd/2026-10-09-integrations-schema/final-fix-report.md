# Phase 9 final fix wave report

Status: DONE (see Concerns)

## Commits (branch worktree-integrations-phase, base 237aed9)
- 63707f1 C1: ig tests IC4c/IC11d/IC11e/IC11f, mutants M13-M15, pins, m5 (IX5 exact), mutation docs and SECURITY.md count.
- 7a05e6a I1: Q236 amended (consequence of (b), option (c) added and made the default); SECURITY.md section 2 matches.
- f56a95c Minors m1-m4: FOLLOW-UPS (spec overstatements, Q169 re-homed, Q236 mirror, IX5 closed), SECURITY.md section 15 caveats (m2) and the section 7 reason correction (m3).
- (this report, committed after)

## C1
Fixtures added to workspace S: ro_s (Read Only, active), ex_s (Owner, membership revoked, aal2 session), owner_s at aal1.
- IC4c: aal1 Owner's connect on suspended S returns `forbidden`, not `workspace_not_writable`.
- IC11d: Read Only revoke on suspended S -> 42501 forbidden.
- IC11e: aal1 Owner revoke -> forbidden.
- IC11f: revoked-membership Owner revoke -> forbidden.
Assertions 195 -> 199. The first runner pass found one bug of mine (IC4b inherited the aal1 claim from IC4c); fixed by re-setting the aal2 claim before IC4b, and the whole runner was re-run from a fresh reset.

## Mutants (subset run after fresh reset: `python mutants.py M13 M14 M15 M12`, results-M13-M14-M15-M12.txt)
| Mutant | Assertions turned red |
|---|---|
| CONTROL before | 199, 0 red |
| M13 manage_integrations term dropped | IC11d; collateral IC11b, IC12a, IC12b |
| M14 MFA term dropped | IC4c, IC11e |
| M15 active-membership term dropped | IC11f; collateral IC11b |
| M12 control | 0 red |
| CONTROL restored | 199, 0 red |
Mutant count is now 14 plus the M12 control (M01-M11 untouched, M13-M15 new). SECURITY.md section 2, the mutants.py docstring and run.sh header say so (m6 fixed).

## Pins
- ig suite: 195 -> 199 (run-rls-tests.sh, `run_suite "PHASE 9 INTEGRATIONS" ... ig 199`).
- Runner total: the runner has no stored total (it sums per-suite pins), so only the ig pin moved. The old 4473 total is now 4477; it appears only in historical ledger lines, which were left alone.
- SECURITY.md was the only live doc stating 195.

## Gates
1. Fresh reset, `bash supabase/tests/run-rls-tests.sh`: final line `All suites passed.` (line 16033 of the log; "PHASE 9 INTEGRATIONS: 199 assertions recorded, as pinned.").
2. Second ig pass on one DB: the suite ran repeatedly on the same database without a reset (twice by hand before gate 1, then after the runner, and in the mutation run as control-before/control-restored): 199 assertions, 0 red each time. The re-runnability mechanism is the suite's own `drop schema ig` + fresh uuids + IZ cleanup.
3. Fresh reset, mutant subset: table above.
4. Fresh reset (DB left clean), `pnpm lint`: exit 0. `npx next typegen` then `pnpm typecheck`: exit 0 (`tsc --noEmit`, TC_DONE 0).
`pnpm test` (vitest) was NOT run: no TS or tests/ file was touched. No e2e: no app code changed.

## Minors
- m1: spec is founder-approved and process-only; left as written, both overstatements recorded in FOLLOW-UPS.
- m2: SECURITY.md section 15 now names service_role Vault access and p_secret in statement logs.
- m3: SECURITY.md section 7 corrected: only revoke rows carry `reason`.
- m4: Q169 re-homed to "unscheduled, a Phase 10 candidate", no decision claimed.
- m5: IX5 is an exact comparison with a postgres-read count of A's sync runs (also asserts non-zero); passed on repeated runs.
- m6: headers corrected.

## Concerns
- Q236 default (c) was my judgement; the founder still has to confirm it.
- mutation-results/phase9/progress.log has one spurious START/END exit=2 pair: `bash run.sh` passes python an MSYS path it cannot open on this machine. The real run was `python mutants.py ...` from the directory (README notes this). run.sh itself is untouched apart from its header.
- FOLLOW-UPS.md was committed whole in the minors commit, so the Q236 mirror line sits there rather than in the I1 commit.
- The shared-stack rule: no other node/playwright processes were running at the start. Everything here is slow (full runner roughly the length of several hours of wall time).

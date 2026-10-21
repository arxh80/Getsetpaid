# Phase 9 final fix wave: re-review (237aed9..bd593ae)

### Finding Verdicts (ADDRESSED | NOT ADDRESSED, file:line)

- **C1: ADDRESSED.** Four new assertions in supabase/tests/rls_phase9_integrations.sql. IC4c is at :536-538, IC11d at :635-637, IC11e at :638-640 and IC11f at :641-643. The fixtures are at :93-100 and :141-142, and cleanup is at :1473/:1479.
  - **Isolation.** Each fixture differs from the passing IC11 caller (owner_s, active, aal2) in one term only, and all run on suspended S, where `has_permission()` is already false, so `integration_role_held()` is the only gate.
    - ro_s: role read_only, active, aal1. A read_only role is not MFA-gated, and M13 reddening IC11d confirms the aal1 claim is irrelevant.
    - owner_s_c1: the same owner_s, with aal1 instead of aal2.
    - ex_s: owner, aal2, membership `status = 'revoked'`.
  - **Mutants.** mutants.py adds three mutants, each removing one line of `private.integration_role_held`, with the "DID NOT APPLY" guard extended to M13-M15. Results are in mutation-results/phase9/results-M13-M14-M15-M12.txt:
    - M13 (manage_integrations term) reddens IC11d.
    - M14 (MFA term) reddens IC4c and IC11e.
    - M15 (active-membership term) reddens IC11f.
    - The M12 control and the control before/after each show 199 assertions with 0 red.
    - The collateral reds (IC11b, IC12a/b) are consistent: the mutated function lets the wrong caller revoke conn_s or conn_p, so `revoked_by` is wrong.
  - **Re-pinned.** supabase/tests/run-rls-tests.sh:1241 now reads `ig 199`.
- **I1: ADDRESSED.** DECISIONS-QUEUE.md (the Q236 block, about :1629-1631) records the consequence of (b): only Owner/Admin could hold a person-scoped connection. It adds option (c), a self-connect path that forces `owner_user_id = auth.uid()` for any active member. The implementer made (c) the default; their report marks this for founder confirmation. SECURITY.md § 2 (about :127-136) and the FOLLOW-UPS.md Phase 9 Task 5 bullet (about :4582) match.
- **m1: ADDRESSED (recorded, not fixed).** FOLLOW-UPS.md (about :4583) records both spec overstatements and names SECURITY.md as the record of truth. This is acceptable because the spec is a founder-approved process document.
- **m2: ADDRESSED.** SECURITY.md:905 is under § 15 (the heading is at :894). It names direct `service_role` access to `vault.secrets`/`decrypted_secrets` and the exposure of `p_secret` through statement or parameter logging.
- **m3: ADDRESSED.** SECURITY.md:310-314 now says only revoke rows carry `reason`, and that `token_stored`/`sync_failed` carry none. The migrations confirm this:
  - The reasons are set via `revoke_integration_row(..., 'membership_ended'|'account_erased')` and `'account_deleted'` in 20261030003000.
  - The token_stored and sync_failed audits in 20261030001000/2000 build no `reason`.
- **m4: ADDRESSED.** FOLLOW-UPS.md:4545-4547 now says Q169 is "unscheduled, a Phase 10 candidate", with no decision claimed.
- **m5: ADDRESSED.** IX5 is at rls_phase9_integrations.sql:1365-1370.
  - The two sides are independent. The left side is `export_read_page` over the export job, which applies the requester's RLS. The right side is `count(*)` from `public.integration_sync_runs`, which runs as postgres: `ig.val` is SECURITY INVOKER, and the session was `reset role` / `reset request.jwt.claims` at :1356-1357. That count is unfiltered by RLS, so the two sides do not come from the same visibility-filtered read.
  - A separate `> 0` term stops the 0 = 0 case passing vacuously.
- **m6: ADDRESSED.** The mutants.py:1 docstring and the run.sh:3 header now say 14 mutants plus the M12 control. SECURITY.md:115-116 says "fourteen mutants plus a control", and 11 + 3 = 14.

### New Breakage in the Fix Diff (severity + file:line, or None)

None at Critical or Important.

**The leaked-identity check is clean.** Every claim the fix changes is overwritten before any assertion that existed before it:
- IC4c sets `owner_s_c1` at :536. `owner_s_c` is restored at :543 before IC4b, and `owner_a_c` is set at :546 before IC5.
- IC11d-f set `ro_s_c`, `owner_s_c1` and `ex_s_c`. `owner_s_c` is restored at :645 before IC11, and IC11c inherits it as before.
- The ordering also prevents vacuous passes. IC11d-f run before IC11 revokes conn_s, so each is tested against a live connection (`forbidden`, not `not_found`).

Two nits, neither blocking:
- **Trivia, :539-541.** The postgres-role `update ... lifecycle_state = 'owner_closed'` now runs with the aal1 `owner_s` claims still set, where before it ran with aal2. The sub is identical and the role is postgres, so there is no behavioural difference. The runner is green.
- **Trivia, process only.** mutation-results/phase9/progress.log has a spurious START/END exit=2 pair. It is documented in README.txt.

### Out-of-Scope Observations

- **Pins.** No live doc or script still says 195 or 4473. The remaining hits are all historical:
  - task-3/task-5 reports and reviews
  - final-review.md
  - results.txt (the original 195-assertion run)
  - README.txt:6, which describes that original run

  The runner has no stored total; it sums the per-suite pins, so the new total is 4477.
- **Q236 default.** The switch from (b) to (c) is the implementer's judgement, not a founder ruling. It is correctly flagged "founder to confirm" in DECISIONS-QUEUE, SECURITY.md and FOLLOW-UPS.
- **Gates not independently verified.** This re-review is read-only and did not re-run any gate. It relies on the reported fresh-reset runner ("All suites passed", ig 199) and on the mutant results file.

### Verdict

**Fix wave:** All findings addressed, no new Critical/Important breakage. Ready to PR.

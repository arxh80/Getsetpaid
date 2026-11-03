Phase 9 mutation run (results.txt)

- Each mutant was applied to the LIVE local database (a function redefinition or one DDL
  statement) and restored by DDL afterwards (CREATE OR REPLACE from pg_get_functiondef, or the
  inverse grant/policy/trigger statement), not by a database reset and not inside begin..rollback.
  The control before, M12 and the control after restoring were all 195 assertions, 0 red, which is
  the evidence the restores were exact. Every later gate (vitest, the psql runner, e2e) began with
  `npx supabase db reset --local`.
- progress.log: the first START/END pair (4 seconds) is the first attempt, which crashed on a wrong
  relative path to the suite (docker cp CalledProcessError, fixed by changing the root depth from 4 to
  5 levels). Its "exit=0" is meaningless: run.sh used to log `exit=$?` inside a $(date) substitution,
  which always reports 0. run.sh now captures rc immediately after python.
- A subset run (bash run.sh M05 M06) writes results-M05-M06.txt and leaves results.txt alone.

Final fix wave (review C1): integration_role_held's three narrowing terms were unmeasured.
- The suite grew 195 -> 199 (IC4c, IC11d, IC11e, IC11f; fixtures: S gained a Read Only member and a
  former Owner whose membership is revoked, plus an aal1 session for S's Owner). The mutant count is
  now 14 plus the M12 control (M01-M11 unchanged, M13-M15 new; M12 kept its number).
- M13 drops the manage_integrations term, M14 the MFA term, M15 the active-membership term.
  Subset run `python mutants.py M13 M14 M15 M12` -> results-M13-M14-M15-M12.txt (fresh reset first):
  control 199/0 red before and after; M13 reddens IC11d (and IC11b, IC12a, IC12b); M14 reddens IC4c and
  IC11e; M15 reddens IC11f (and IC11b); M12 control 0 red.
- progress.log has one spurious START/END exit=2 pair from 19:31: `bash run.sh` handed python an MSYS
  path it could not open. The real run was `python mutants.py ...` from this directory.

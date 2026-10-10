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

-- Phase 7 Task 5, fix 1: attach the house `set_updated_at` trigger to
-- public.rate_limit_counters.
--
-- FOUND BY A TRIPWIRE THAT WORKED. rls_phase2_crm.sql § L5 asserts that EVERY
-- table in `public` carrying an `updated_at` column also carries a trigger
-- named exactly `set_updated_at` -- the guard whose stated purpose
-- (20260828121500's own comment block, and § L5's trailing note) is to notice
-- a NEW table arriving without one. 20260909020000 added three tables;
-- rate_limit_policies and incident_alerts carry no updated_at column and are
-- correctly outside the guard, but rate_limit_counters carries one and got no
-- trigger, so § L5 counted 1 violation instead of 0.
--
-- WHY ATTACH IT RATHER THAN RELAX THE GUARD. The guard's usual justification
-- -- "a PostgREST PATCH can set any column it has a grant on, so the value
-- must be server-forced" -- does NOT apply here: rate_limit_counters has no
-- INSERT/UPDATE/DELETE policy for any role, `revoke all` then a bare
-- `grant select`, and every write is inside a SECURITY DEFINER function. A
-- client cannot forge this column because a client cannot write this table at
-- all. But the guard is a STRUCTURAL tripwire, not a per-table risk
-- assessment: its whole value is that it fires on every new table without the
-- author having to be asked, and the moment it acquires an exception list it
-- stops being able to catch the case it exists for -- a future table that
-- *does* have a client write path and *was* forgotten. So the cheap,
-- convention-following move is the right one: attach the trigger, keep the
-- guard absolute at 0.
--
-- BEHAVIOURALLY A NO-OP. private.record_rate_limit_event()'s ON CONFLICT DO
-- UPDATE already sets `updated_at = now()` on every increment, which is
-- exactly what private.set_updated_at() forces. Nothing that reads this
-- column sees a different value after this migration than before it.
--
-- ADDITIVE. No previously applied migration is edited.

create trigger set_updated_at
  before update on public.rate_limit_counters
  for each row execute function private.set_updated_at();

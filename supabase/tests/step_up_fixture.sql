-- ===========================================================================
-- THE ONE WAY A PSQL FIXTURE GETS PAST STEP-UP (Phase 10 Task 6, G13).
--
-- Every step-up-gated RPC, and the export_jobs / erasure_jobs inserts, now
-- consume a single-use token in the database (20261108001000). A suite whose
-- fixture calls one of them mints first, through this, in the SAME statement
-- or transaction as the call where it can, so a call that fails leaves no
-- stray token behind to make a later refusal pass:
--
--   select step_up_fixture.mint('organisation_lifecycle') \g /dev/null
--   ... $$select step_up_fixture.mint('override'); select public.grant_...$$
--
-- It goes through the real public.mint_step_up_token(), so it needs what the
-- app's server has: a session (request.jwt.claims, role authenticated) and the
-- server request mark, which run-rls-tests.sh turns on for every suite.
-- Installed once by run-rls-tests.sh, before the first suite.
-- ===========================================================================
drop schema if exists step_up_fixture cascade;
create schema step_up_fixture;

-- plpgsql, so the body is resolved at call time: the runner installs this
-- before any migration check, and a missing mint function is then a loud
-- failure in the suite that called it, not here.
create function step_up_fixture.mint(p_purpose text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  perform public.mint_step_up_token(p_purpose);
  return true;
end $$;

grant usage on schema step_up_fixture to authenticated;
grant execute on function step_up_fixture.mint(text) to authenticated;

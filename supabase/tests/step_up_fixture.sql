-- ===========================================================================
-- THE ONE WAY A PSQL FIXTURE GETS PAST STEP-UP (Phase 10 Task 6, G13).
--
-- Every step-up-gated RPC, and the export_jobs / erasure_jobs inserts, now
-- consume a single-use token in the database (20261108001000). Two ways in,
-- both through the real public.mint_step_up_token(), so both need what the
-- app's server has: a session (request.jwt.claims) and the server request
-- mark, which run-rls-tests.sh turns on for every suite.
--
--   mint(purpose)  one token for the CURRENT claims. rls_phase10_step_up.sql
--                  mints this way inside each scenario, which it rolls back.
--   arm(claims)    a stock of every purpose for one principal, for the suites
--                  whose subject is not step-up (below).
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

-- ARMS a principal for a suite that tests something OTHER than step-up: mints
-- p_n live tokens of every purpose on the closed list for the user in
-- p_claims, as the server would after a passed step-up. The suite's gated
-- calls then behave exactly as they did before 20261108001000 -- a refusal
-- from any other guard keeps its meaning, a success still succeeds -- and
-- step-up itself is rls_phase10_step_up.sql's job. Tokens live five minutes,
-- so arm at the top of the suite (or section) that uses them. Called as
-- postgres at session level:
--
--   select step_up_fixture.arm(:'super_c') \g /dev/null
create function step_up_fixture.arm(p_claims text, p_n integer default 40)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_was text := pg_catalog.current_setting('request.jwt.claims', true);
  v_p   text;
begin
  perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
  if (select auth.uid()) is null then
    raise exception 'step_up_fixture.arm: the claims name no user: %', p_claims;
  end if;
  for v_p in
    select pg_catalog.replace(pg_catalog.split_part(x, '::', 1), '''', '')
      from pg_catalog.pg_constraint c
     cross join lateral pg_catalog.unnest(pg_catalog.string_to_array(
             pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '^.*ARRAY\[(.*)\].*$', '\1'),
             ', ')) x
     where c.conname = 'step_up_tokens_purpose_known'
  loop
    for i in 1 .. p_n loop
      perform public.mint_step_up_token(v_p);
    end loop;
  end loop;
  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_was, ''), true);
  return true;
end $$;

grant usage on schema step_up_fixture to authenticated;
grant execute on function step_up_fixture.mint(text) to authenticated;
grant execute on function step_up_fixture.arm(text, integer) to authenticated;

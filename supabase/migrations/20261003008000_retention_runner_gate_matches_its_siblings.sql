-- ===========================================================================
-- PHASE 8 TASK 6 -- THE RUNNER'S SERVER-ONLY GATE, CORRECTED TO THE SHAPE ITS
-- THREE SIBLINGS ALREADY USE.
--
-- MEASURED, AND IT MADE THE WHOLE FEATURE UNREACHABLE.
-- public.start_retention_run() shipped with
--
--   if current_setting('request.jwt.claims', true) is not null
--      or auth.uid() is not null then  ... refuse
--
-- and PostgREST sets `request.jwt.claims` ON EVERY REQUEST, including the
-- service_role one the runner makes -- so the retention job refused its own
-- runner and every run returned `unavailable`:
--
--   [retention] the run could not be started:
--     start_retention_run: the retention runner is server-only
--
-- Found by tests/integration/retention/runner.test.ts on its first execution,
-- which is the only test in the estate that calls the runner over PostgREST
-- rather than the functions over psql. THE PSQL SUITE COULD NOT SEE IT: as
-- `postgres` there is no `request.jwt.claims` at all, so all thirteen
-- assertions in its § RR passed against a gate that refused the real caller.
-- That is worth stating plainly rather than fixing quietly -- it is the exact
-- shape of "a check that cannot see its own subject", one layer up.
--
-- THE CORRECT SHAPE IS THE ONE public.claim_erasure_job(),
-- public.run_erasure_job() and the export runner's RPCs already use, and it is
-- an OPEN list of server roles rather than a closed list of client ones
-- (20260928000000's reasoning): auth.uid() must be absent, AND the session
-- role must be one of postgres/service_role/none. A client role added by a
-- later phase therefore arrives REFUSED BY OMISSION rather than admitted by
-- it. `request.jwt.claims` is not consulted at all, because its presence says
-- only that the request came through PostgREST and nothing about who made it.
--
-- ADDITIVE. All three RPCs are rebuilt from their LATEST definitions; the only
-- change in each is the gate.
-- ===========================================================================

create or replace function public.start_retention_run(p_dry boolean default false)
returns public.retention_runs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run     public.retention_runs%rowtype;
  v_enabled boolean;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'start_retention_run: the retention runner is server-only'
      using errcode = '42501', hint = 'retention_runner_is_server_only';
  end if;

  -- Q166's shape, for this job. A run left `running` by a crash is failed
  -- once it is older than the declared stuck_job period.
  update public.retention_runs r
     set status      = 'failed',
         finished_at = pg_catalog.now(),
         duration_ms = 0,
         refused     = r.refused || pg_catalog.jsonb_build_object('*', 'run_abandoned')
   where r.status = 'running'
     and r.started_at < pg_catalog.now() - private.retention_period('stuck_job');

  select s.enabled into v_enabled from public.retention_settings s where s.id;

  insert into public.retention_runs (correlation_id, mode, status, finished_at, duration_ms, refused)
  values (
    pg_catalog.gen_random_uuid(),
    case when p_dry then 'dry' else 'live' end,
    -- THE KILL SWITCH IS RECORDED, NOT SILENT.
    case when v_enabled then 'running' else 'refused' end,
    case when v_enabled then null else pg_catalog.now() end,
    case when v_enabled then null else 0 end,
    case when v_enabled then '{}'::jsonb
         else pg_catalog.jsonb_build_object('*', 'retention_disabled') end)
  returning * into v_run;

  return v_run;
end;
$$;

comment on function public.start_retention_run(boolean) is
  'OPENS one retention run, in its OWN transaction, and returns the row (Phase 8 Task 6). Separate from public.run_retention_sweep() for one reason: a run that takes the process down with it must leave evidence that it began, and a row written and completed inside a single call vanishes with the rollback it was the only record of. It also REAPS a previous run left `running` past the declared stuck_job period -- Q166''s shape applied to this job itself. When the kill switch is off it still writes a row, with status `refused`, because "nothing has been deleted since the 4th because somebody turned it off" and "there has been nothing to delete" must not look the same. SERVER-ONLY in the shape claim_erasure_job() uses: no auth.uid() AND a session role of postgres/service_role/none, an OPEN list of server roles so a client role added later is refused by omission. 20261003008000 corrected this from a test on `request.jwt.claims`, which PostgREST sets on EVERY request including the runner''s own, and which therefore refused the runner itself on every run -- invisible to the psql suite, where there is no such setting at all.';

revoke all on function public.start_retention_run(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.start_retention_run(boolean) to service_role;


create or replace function public.fail_retention_run(p_run_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'fail_retention_run: the retention runner is server-only'
      using errcode = '42501', hint = 'retention_runner_is_server_only';
  end if;

  update public.retention_runs r
     set status      = 'failed',
         finished_at = pg_catalog.now(),
         duration_ms = greatest(0, (pg_catalog.date_part('epoch', pg_catalog.now() - r.started_at) * 1000)::integer),
         refused     = r.refused || pg_catalog.jsonb_build_object(
                         '*', pg_catalog.left(coalesce(pg_catalog.btrim(p_reason), 'unknown'), 200))
   where r.id = p_run_id
     and r.status = 'running';
end;
$$;

comment on function public.fail_retention_run(uuid, text) is
  'Records that a retention run failed. In its own transaction ON PURPOSE, because it has to survive the rollback it is describing -- fail_erasure_job()''s reason. The reason is truncated to 200 characters and comes from the runner, which composes it from a SQLSTATE and a hint rather than passing a PostgreSQL message through: a message can quote a row value and this table is rendered on /super/health. Server-only in the same shape as its siblings since 20261003008000.';

revoke all on function public.fail_retention_run(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_retention_run(uuid, text) to service_role;


CREATE OR REPLACE FUNCTION public.run_retention_sweep(p_run_id uuid, p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run     public.retention_runs%rowtype;
  v_swept   jsonb;
  v_refused jsonb;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'run_retention_sweep: the retention runner is server-only'
      using errcode = '42501', hint = 'retention_runner_is_server_only';
  end if;

  -- NEVER UNDER `replica`. The workspace purge refuses it too, but this is
  -- the outermost gate and a run that got this far under `replica` would
  -- have swept seven other tables before reaching that refusal.
  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'run_retention_sweep: refuses to run with session_replication_role = %',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;

  select * into v_run from public.retention_runs r where r.id = p_run_id;
  if not found then
    raise exception 'run_retention_sweep: no such run' using errcode = '22023', hint = 'unknown_retention_run';
  end if;
  if v_run.status <> 'running' then
    raise exception 'run_retention_sweep: run % is %', p_run_id, v_run.status
      using errcode = '22023', hint = 'retention_run_is_not_running';
  end if;

  -- STEP 0, BEFORE A ROW MOVES: the roll and the catalogue must agree. A
  -- table this product grew and nobody classified is a refusal, not a silent
  -- omission.
  perform private.assert_retention_roll();

  -- ONE THREAD FOR THE WHOLE RUN (requirement 3). See the header for why this
  -- is not begin_lifecycle_transition(), and for the measurement that setting
  -- the marker grants this sessionless caller nothing.
  perform pg_catalog.set_config('app.lifecycle_correlation_id', v_run.correlation_id::text, true);

  select b.swept, b.refused into v_swept, v_refused
    from private.retention_sweep_body(v_run.mode = 'dry', p_limit) b;

  update public.retention_runs r
     set status      = 'completed',
         finished_at = pg_catalog.now(),
         duration_ms = greatest(0, (pg_catalog.date_part('epoch', pg_catalog.now() - r.started_at) * 1000)::integer),
         swept       = v_swept,
         refused     = v_refused
   where r.id = p_run_id;

  -- ONE SUMMARY AUDIT ROW (requirement 3): counts, never content, on the
  -- run's own thread, actor = the Q130 tombstone. A DRY run writes one too,
  -- and says so in the payload -- "the founder previewed what would be
  -- deleted" is itself a thing the audit log should be able to answer.
  insert into public.audit_events
    (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
  values (
    null, private.erased_user_id(), 'retention.swept', 'platform',
    p_run_id, v_run.correlation_id,
    v_swept || pg_catalog.jsonb_build_object('mode', v_run.mode)
             || case when v_refused = '{}'::jsonb then '{}'::jsonb
                     else pg_catalog.jsonb_build_object('refused', v_refused) end);

  perform pg_catalog.set_config('app.lifecycle_correlation_id', '', true);

  return v_swept || pg_catalog.jsonb_build_object('run_id', p_run_id, 'mode', v_run.mode,
                                                  'refused', v_refused);
end;
$function$;


-- The grants are reissued beside the rebuild, the house pattern: a
-- `create or replace` keeps the existing ACL, and restating it is what makes
-- the file auditable by eye.
revoke all on function public.run_retention_sweep(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.run_retention_sweep(uuid, integer) to service_role;

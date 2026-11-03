-- ===========================================================================
-- PHASE 8 TASK 6 -- RETENTION, PART 5: THE ONE RUN, AND THE THREE RPCs THE
-- RUNNER DRIVES IT WITH.
--
-- The erasure runner's shape (20260930004000), for the same three reasons:
--
--   public.start_retention_run(p_dry)   OPENS the run in its OWN transaction,
--                                       so a run that takes the process down
--                                       with it leaves a row saying it began
--                                       and never ended. A row written and
--                                       completed inside one call would
--                                       vanish with the rollback it was the
--                                       only evidence of.
--   public.run_retention_sweep(id)      DOES EVERYTHING, in ONE transaction,
--                                       and completes the row in the same
--                                       one. Ten PostgREST calls would be ten
--                                       transactions and there would be no
--                                       moment at which the run log and the
--                                       database agreed.
--   public.fail_retention_run(id, why)  Records a failure, deliberately in
--                                       its own transaction BECAUSE IT HAS TO
--                                       SURVIVE THE ROLLBACK IT DESCRIBES.
--
-- ===========================================================================
-- A FAILING SWEEP CANNOT STOP ANY OTHER SWEEP
-- ===========================================================================
-- Each of the eight sweeps runs in its OWN subtransaction, exactly the way
-- the four halves of the cron tick do. Whatever one throws is rolled back to
-- its own BEGIN, recorded in `refused` under that sweep's name with its
-- SQLSTATE and hint, and the run carries on. The alternative -- one long
-- statement list -- means the workspace purge refusing because one bucket
-- has not drained also stops the counters being swept, for ever, and nothing
-- says why.
--
-- THE SQLSTATE AND THE HINT TRAVEL; THE MESSAGE DOES NOT. A PostgreSQL error
-- message can quote a row value, and public.retention_runs is read on
-- /super/health. The erasure runner's rule, in the database this time.
--
-- ===========================================================================
-- THE CORRELATION THREAD, AND WHY IT IS NOT begin_lifecycle_transition()
-- ===========================================================================
-- Requirement 3 asks for one thread per run plus one summary row -- the
-- pattern 20260908030000 § 6 established. That marker is normally opened by
-- private.begin_lifecycle_transition(), which REQUIRES an aal2 platform
-- superuser; this run has no session at all, so it cannot call it and sets
-- the GUC itself.
--
-- MEASURED, BECAUSE IT IS THE OBVIOUS OBJECTION: setting that marker does NOT
-- hand this function the lifecycle write path.
-- organisations_update_platform_lifecycle is
--   has_platform_permission('manage_organisation_lifecycle') AND
--   lifecycle_transition_in_progress()
-- -- a conjunction, and the first term is false for a sessionless caller
-- (private.has_platform_permission() requires both an auth.uid() on the
-- platform_admins allowlist and aal2). The marker alone grants nothing.
--
-- THE SUMMARY ROW IS WRITTEN DIRECTLY, NOT THROUGH log_audit_event(), and for
-- the reason Task 5 recorded twice: private.log_audit_event() REQUIRES
-- auth.uid() and raises 28000 without one, and a retention run has nobody on
-- it. The actor is the Q130 tombstone, as private.erase_organisation()'s
-- summary row already is. This is the SIXTH direct writer into
-- public.audit_events and it is registered with the census in
-- tests/integration/admin/audit-actions-match-db.test.ts that exists to find
-- exactly this.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. THE `swept` CHECK, CORRECTED -- AND THE CHECK IS WHAT FOUND IT.
--
--    20261003001000 reused public.erasure_jobs.summary's predicate,
--    private.jsonb_is_count_map(), on the theory that "counts, never content"
--    is one rule. It is not quite: that predicate admits a boolean only for
--    three named erasure keys, and every sweep in part 3 reports a `capped`
--    flag saying whether it hit its per-run ceiling. The first end-to-end run
--    failed with 23514 `retention_runs_swept_is_counts` -- the constraint
--    doing its job on the first row anybody tried to write, which is better
--    than it being wide enough to let anything through.
--
--    The fix is a predicate of this table's own rather than a widening of the
--    erasure's: numbers and booleans, nothing else, so a string cannot reach
--    a table that is rendered on /super/health. A summary key holding a
--    filename, a search term or an error message stays impossible.
-- ---------------------------------------------------------------------------

create or replace function private.jsonb_is_retention_summary(p_value jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_value) = 'object'
     and not exists (
       select 1 from pg_catalog.jsonb_each(p_value) e
        where pg_catalog.jsonb_typeof(e.value) not in ('number', 'boolean'))
$$;

comment on function private.jsonb_is_retention_summary(jsonb) is
  'The shape public.retention_runs.swept is allowed to have: a flat object whose every value is a NUMBER or a BOOLEAN. Numbers are the counts; the booleans are each sweep''s `capped` flag, saying it hit its per-run ceiling and left a backlog. Deliberately NOT private.jsonb_is_count_map(), which admits a boolean only under three erasure-specific keys and refused the first retention row anybody tried to write -- widening THAT predicate would have loosened public.erasure_jobs.summary as a side effect. What both share is the part that matters: no string can reach either column, so a filename, a search term or a PostgreSQL error message cannot arrive in a summary that is rendered on a cross-tenant operator page.';

-- EXECUTE MUST BE REACHABLE FROM THE WRITER'S ROLE. Task 5 § 5(a): a CHECK
-- constraint is evaluated with the privileges of the role performing the
-- WRITE, not the table owner's, and revoking a private helper from everything
-- made public.erasure_jobs unwritable by every client role. Nothing but a
-- SECURITY DEFINER function owned by postgres writes public.retention_runs,
-- so the house revoke is correct here -- and this comment is why it is safe
-- to be correct here and was not there.
revoke all on function private.jsonb_is_retention_summary(jsonb)
  from public, anon, authenticated, service_role;

alter table public.retention_runs drop constraint retention_runs_swept_is_counts;
alter table public.retention_runs
  add constraint retention_runs_swept_is_counts
  check (private.jsonb_is_retention_summary(swept));

comment on constraint retention_runs_swept_is_counts on public.retention_runs is
  'public.retention_runs.swept is counts and capped-flags only: every value a number or a boolean, never a string. It is the rule that keeps a filename, a search term or a PostgreSQL error message out of a table rendered on /super/health. Re-pointed in 20261003004000 from private.jsonb_is_count_map() -- the erasure''s predicate, which admits a boolean under three named erasure keys and so refused the first retention row ever written.';


-- ---------------------------------------------------------------------------
-- 1. OPEN A RUN.
--
--    Also reaps a PREVIOUS run left `running` -- the same Q166 shape, applied
--    to this job itself. Without it a crash would leave a row that says
--    "running" for ever and /super/health would report a sweep in progress
--    that has not existed for a month.
-- ---------------------------------------------------------------------------

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
  if pg_catalog.current_setting('request.jwt.claims', true) is not null
     or (select auth.uid()) is not null then
    raise exception 'start_retention_run: the retention runner is server-only'
      using errcode = '42501', hint = 'retention_runner_is_server_only';
  end if;

  -- Q166's shape, for this job. A run left `running` by a crash is failed
  -- once it is older than the declared stuck_job period.
  update public.retention_runs r
     set status      = 'failed',
         finished_at = pg_catalog.now(),
         duration_ms = 0,
         refused     = r.refused || pg_catalog.jsonb_build_object(
                         '*', 'run_abandoned')
   where r.status = 'running'
     and r.started_at < pg_catalog.now() - private.retention_period('stuck_job');

  select s.enabled into v_enabled from public.retention_settings s where s.id;

  insert into public.retention_runs (correlation_id, mode, status, finished_at, duration_ms, refused)
  values (
    pg_catalog.gen_random_uuid(),
    case when p_dry then 'dry' else 'live' end,
    -- THE KILL SWITCH IS RECORDED, NOT SILENT. A refused run still writes a
    -- row, so "the job has not deleted anything since the 4th because
    -- somebody turned it off" is readable on /super/health rather than being
    -- indistinguishable from "there has been nothing to delete".
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
  'OPENS one retention run, in its OWN transaction, and returns the row (Phase 8 Task 6). Separate from public.run_retention_sweep() for one reason: a run that takes the process down with it must leave evidence that it began, and a row written and completed inside a single call vanishes with the rollback it was the only record of. It also REAPS a previous run left `running` past the declared stuck_job period -- Q166''s shape applied to this job itself, without which a crash leaves /super/health reporting a sweep in progress that has not existed for a month. When the kill switch is off it still writes a row, with status `refused`, because "nothing has been deleted since the 4th because somebody turned it off" and "there has been nothing to delete" must not look the same. service_role only, and it refuses a session with a person on it.';

revoke all on function public.start_retention_run(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.start_retention_run(boolean) to service_role;


-- ---------------------------------------------------------------------------
-- 2. RECORD A FAILURE. Its own transaction, because it describes a rollback.
-- ---------------------------------------------------------------------------

create or replace function public.fail_retention_run(p_run_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
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
  'Records that a retention run failed. In its own transaction ON PURPOSE, because it has to survive the rollback it is describing -- the erasure runner''s fail_erasure_job() for the same reason. The reason is truncated to 200 characters and comes from the runner, which composes it from a SQLSTATE and a hint rather than passing a PostgreSQL message through: a message can quote a row value and this table is rendered on /super/health.';

revoke all on function public.fail_retention_run(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_retention_run(uuid, text) to service_role;


-- ---------------------------------------------------------------------------
-- 3. THE RUN.
--
--    THE ORDER IS DECLARED AND IT MATTERS IN ONE PLACE. Everything before the
--    workspace purge is independent; the workspace purge goes LAST because
--    private.erase_organisation() refuses while a byte of that workspace is
--    still in its bucket, so it wants the most recent possible view of the
--    bucket -- which the runner produced by deleting objects before calling
--    this at all.
-- ---------------------------------------------------------------------------

create or replace function private.retention_sweep_body(p_dry boolean, p_limit integer)
returns table (swept jsonb, refused jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_swept   jsonb := '{}'::jsonb;
  v_refused jsonb := '{}'::jsonb;
  v_state   text;
  v_hint    text;
begin
  -- Each sweep in its own subtransaction. A refusal is recorded and the run
  -- carries on; there is no sweep whose failure stops another.
  begin
    v_swept := v_swept || private.sweep_rate_limit_counters(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('rate_limit_counters', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.sweep_feedback(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('feedback', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.sweep_incident_alerts(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('incident_alerts', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.sweep_erasure_jobs(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('erasure_jobs', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.reap_stuck_jobs(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('stuck_jobs', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.sweep_document_bytes(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('documents', coalesce(nullif(v_hint, ''), v_state));
  end;

  -- THE DANGEROUS ONE, in the middle of the list rather than first or last,
  -- because its rails are what protect it and not its position.
  begin
    v_swept := v_swept || private.purge_audit_events(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('audit_events', coalesce(nullif(v_hint, ''), v_state));
  end;

  -- LAST, deliberately: the primitive refuses while a byte of the workspace
  -- is still in its bucket, so it wants the freshest possible view of a
  -- bucket the runner has just been deleting from.
  begin
    v_swept := v_swept || private.sweep_expired_workspaces(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('organisations', coalesce(nullif(v_hint, ''), v_state));
  end;

  return query select v_swept, v_refused;
end;
$$;

comment on function private.retention_sweep_body(boolean, integer) is
  'The eight sweeps of one retention run, each in its OWN subtransaction so that no sweep''s failure can stop another -- the shape the four halves of private.run_incident_alert_tick() already have, for the same reason. A refusal is recorded in the returned `refused` map under that sweep''s name, as its HINT where it has one and its SQLSTATE otherwise: the MESSAGE is deliberately not kept, because a PostgreSQL message can quote a row value and public.retention_runs is rendered on /super/health. The workspace purge is last because private.erase_organisation() refuses while a byte of that workspace is still in its bucket, and the runner has just been deleting from that bucket.';

revoke all on function private.retention_sweep_body(boolean, integer)
  from public, anon, authenticated, service_role;


create or replace function public.run_retention_sweep(p_run_id uuid, p_limit integer default 500)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run     public.retention_runs%rowtype;
  v_swept   jsonb;
  v_refused jsonb;
begin
  if (select auth.uid()) is not null then
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
$$;

comment on function public.run_retention_sweep(uuid, integer) is
  'THE RETENTION RUN (Phase 8 Task 6): the eight sweeps, the run log''s completion and one summary audit row, all in ONE transaction. It asserts private.assert_retention_roll() at step 0, before a row moves, so a table this product grew and nobody classified stops the job instead of being quietly un-retained. It threads every audit row written anywhere inside the run onto the run''s correlation id -- setting the marker GUC itself, because private.begin_lifecycle_transition() requires an aal2 superuser and this has no session, and because the marker alone grants nothing (organisations_update_platform_lifecycle is a conjunction whose first term a sessionless caller fails). The summary row is written DIRECTLY into public.audit_events, the sixth writer to do so, because private.log_audit_event() requires auth.uid() and a retention run has nobody on it; the actor is the Q130 tombstone, as private.erase_organisation()''s summary row already is. A DRY run writes the summary row too, marked `"mode": "dry"` -- the founder previewing what would be deleted is itself a thing the audit log should be able to answer. service_role only, refuses a session with a person on it, and refuses any session_replication_role but `origin`.';

revoke all on function public.run_retention_sweep(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.run_retention_sweep(uuid, integer) to service_role;

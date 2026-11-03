-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 1 -- REVIEW FINDING I2.
--
-- NOTHING SERIALISED RETENTION RUNS.
--
-- public.start_retention_run() took no lock and refused nothing when a run
-- was already `running`:
--
--   select (public.start_retention_run(false)).id;
--   select (public.start_retention_run(false)).id;
--   select count(*) filter (where status = 'running') from public.retention_runs;  -- 2
--
-- Three of the audit purge's five rails are arithmetic over ONE run. The
-- per-run ceiling (rail 4) is per run, so N concurrent runs delete up to
-- N x 500 audit rows a pass; the sanity ceiling (rail 3) is computed per run
-- and each is blind to the other's deletions; and total_before / total_after
-- (rail 5), which exist so the run log's arithmetic is "checkable rather than
-- trusted", are both wrong when two deletes interleave. The pg_cron path is
-- throttled to about hourly, but POST /api/retention/run is reachable with
-- the bearer secret and the /super/health preview button is a second caller:
-- a rail with a documented purpose that a second HTTP request defeated.
--
-- THE HOUSE PATTERN: a partial unique index over the live state -- the export
-- and erasure jobs both have one. It is the database's own serialisation, so
-- it holds for a caller nobody has written yet, and under a real race the
-- second INSERT blocks on the first's uncommitted row and then fails, rather
-- than both passing an unlocked read (Task 5's C2, which is what
-- `if exists (select ... running)` would have been).
--
-- THE LOSER IS RECORDED, NOT RAISED: a `refused` run carrying
-- `retention_run_in_progress`. A raise would surface to the runner as
-- "unavailable" and leave no row, and an overlap somebody can see on
-- /super/health is better than one they cannot. A run left `running` by a
-- crash does not wedge the job: the reaper at the top of this same function
-- fails it past the declared stuck_job period, exactly as before, and it runs
-- BEFORE the insert.
--
-- public.start_retention_run() is rebuilt from its LATEST definition
-- (20261004002000). supabase/tests/retention_concurrency_probe.sh is the
-- standing two-session proof; the psql suite is single-session and cannot
-- have one.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- A deployment that already holds two `running` rows (this defect, having
-- happened) would fail the index build. Fail every one but the newest first,
-- with a reason that says what it was.
update public.retention_runs r
   set status      = 'failed',
       finished_at = pg_catalog.now(),
       duration_ms = 0,
       refused     = r.refused || pg_catalog.jsonb_build_object('*', 'run_overlapped')
 where r.status = 'running'
   and r.id <> (select k.id from public.retention_runs k
                 where k.status = 'running'
                 order by k.started_at desc, k.id desc limit 1);

create unique index retention_runs_one_running_idx
  on public.retention_runs ((true))
  where status = 'running';

comment on index public.retention_runs_one_running_idx is
  'AT MOST ONE retention run is `running` (Phase 8 Task 6 fix round 1, review finding I2). The per-run ceiling, the sanity ceiling and the before/after totals are all arithmetic over ONE run, and two concurrent runs defeated all three. A partial unique index rather than a check inside public.start_retention_run(): it is the database''s own serialisation, so under a real race the second INSERT blocks on the first''s uncommitted row and then fails, where an `if exists` would let both pass an unlocked read. The house pattern -- export_jobs and erasure_jobs carry the same shape.';


create or replace function public.start_retention_run(p_dry boolean default false)
returns public.retention_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run     public.retention_runs%rowtype;
  v_enabled boolean;
  v_reason  text;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'start_retention_run: the retention runner is server-only'
      using errcode = '42501', hint = 'retention_runner_is_server_only';
  end if;

  -- NEVER UNDER `replica`, AND ASKED HERE so that it is asked before the
  -- runner has been handed anything (C2). It used to be asked only by
  -- public.run_retention_sweep(), which the runner calls AFTER deleting
  -- objects. RAISED rather than recorded: under `replica` no trigger on the
  -- run log fires either, and a row written in that state is not one to keep.
  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'start_retention_run: refuses to run with session_replication_role = %',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;

  -- Q166's shape, for this job. A run left `running` by a crash is failed
  -- once it is older than the declared stuck_job period -- BEFORE the insert
  -- below, so an abandoned run cannot wedge the one-running index for ever.
  update public.retention_runs r
     set status      = 'failed',
         finished_at = pg_catalog.now(),
         duration_ms = 0,
         refused     = r.refused || pg_catalog.jsonb_build_object('*', 'run_abandoned')
   where r.status = 'running'
     and r.started_at < pg_catalog.now() - private.retention_period('stuck_job');

  select s.enabled into v_enabled from public.retention_settings s where s.id;

  -- EVERY REFUSAL THAT CAN STOP A RUN, BEFORE THE RUN EXISTS (C2). The kill
  -- switch first -- somebody CHOSE that, and it should read as their choice
  -- rather than as whatever structural fault happens to sit behind it.
  v_reason := case when v_enabled is distinct from true then 'retention_disabled'
                   else private.retention_refusal() end;

  begin
    insert into public.retention_runs (correlation_id, mode, status, finished_at, duration_ms, refused)
    values (
      pg_catalog.gen_random_uuid(),
      case when p_dry then 'dry' else 'live' end,
      -- A REFUSAL IS RECORDED, NOT SILENT.
      case when v_reason is null then 'running' else 'refused' end,
      case when v_reason is null then null else pg_catalog.now() end,
      case when v_reason is null then null else 0 end,
      case when v_reason is null then '{}'::jsonb
           else pg_catalog.jsonb_build_object('*', v_reason) end)
    returning * into v_run;
  exception when unique_violation then
    -- ONE RUN AT A TIME (I2). The only unique constraint a `running` insert
    -- can violate is retention_runs_one_running_idx -- the primary key is a
    -- fresh uuid. Under a real race this branch is reached only after the
    -- other session COMMITTED its `running` row; had it rolled back, the
    -- insert above would simply have succeeded.
    insert into public.retention_runs (correlation_id, mode, status, finished_at, duration_ms, refused)
    values (
      pg_catalog.gen_random_uuid(),
      case when p_dry then 'dry' else 'live' end,
      'refused', pg_catalog.now(), 0,
      pg_catalog.jsonb_build_object('*', 'retention_run_in_progress'))
    returning * into v_run;
  end;

  return v_run;
end;
$$;

comment on function public.start_retention_run(boolean) is
  'OPENS one retention run, in its OWN transaction, and returns the row (Phase 8 Task 6). Separate from public.run_retention_sweep() for one reason: a run that takes the process down with it must leave evidence that it began, and a row written and completed inside a single call vanishes with the rollback it was the only record of. It also REAPS a previous run left `running` past the declared stuck_job period -- Q166''s shape applied to this job itself. SINCE 20261004002000 (review finding C2) IT IS WHERE EVERY REFUSAL THAT CAN STOP A RUN IS ASKED FIRST: `replica` raises; the kill switch, private.assert_retention_roll() and private.assert_retention_clocks() are each RECORDED as a `refused` run carrying the hint -- because the runner deletes OBJECTS between this call and public.run_retention_sweep(), and a tripwire that fires after the bytes are gone has protected nothing. SINCE 20261004003000 (I2) ONLY ONE RUN IS EVER `running`: retention_runs_one_running_idx is the serialisation, and the loser of an overlap is recorded as `refused` / `retention_run_in_progress` rather than raised -- the per-run ceiling, the sanity ceiling and the before/after totals are all arithmetic over one run. "Nothing has been deleted since the 4th because somebody turned it off", "...because the schema grew a table nobody classified" and "there has been nothing to delete" must not look the same. SERVER-ONLY in the shape claim_erasure_job() uses: no auth.uid() AND a session role of postgres/service_role/none, an OPEN list of server roles so a client role added later is refused by omission. 20261003008000 corrected this from a test on `request.jwt.claims`, which PostgREST sets on EVERY request including the runner''s own.';

revoke all on function public.start_retention_run(boolean) from public, anon, authenticated, service_role;
grant execute on function public.start_retention_run(boolean) to service_role;

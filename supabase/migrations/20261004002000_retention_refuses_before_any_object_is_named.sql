-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 1 -- REVIEW FINDING C2.
--
-- STEP 0 RAN AFTER THE BYTES WERE ALREADY GONE.
--
-- lib/retention/runner.ts read the object manifest, DELETED THE OBJECTS, and
-- only then called public.run_retention_sweep() -- which is where
-- private.assert_retention_roll() lived. The reviewer planted an unclassified
-- table and measured it end to end with a real Storage download:
--
--   [retention] run ... failed: 55000: assert_retention_roll:
--     public.reviewer_unclassified_probe is not classified ...
--   outcome: {"outcome":"failed","objectsRemoved":1, ...}
--   object still in bucket = false
--
-- The tripwire fired, the run was recorded `failed`, and the file had been
-- destroyed anyway. The same held for every other refusal inside
-- run_retention_sweep(): `replica`, unknown_retention_run,
-- retention_run_is_not_running. Only the `enabled` kill switch was bytes-safe,
-- because public.start_retention_run() answers it before the manifest is read.
-- Row deletion is transactional and object deletion is not, so the half that
-- was unprotected was the half that cannot be put back.
--
-- THE RULE NOW: EVERY REFUSAL THAT CAN STOP A RUN IS EVALUATED BEFORE ANY
-- OBJECT IS NAMED, LET ALONE TOUCHED -- AND IN THE DATABASE, NOT IN THE
-- RUNNER'S ORDER OF CALLS. Reordering three lines of TypeScript would have
-- fixed the measurement and left the property resting on nobody ever
-- reordering them back. Two gates instead, each of which holds alone:
--
--   1. public.start_retention_run() ASKS FIRST AND RECORDS THE ANSWER. It now
--      refuses `replica` outright, and evaluates the kill switch, the roll
--      (private.assert_retention_roll()) and the clock roll
--      (private.assert_retention_clocks(), 20261004001000) before it writes
--      the run row. A refusal is recorded as a `refused` run carrying its hint
--      -- the kill switch's existing shape -- so the runner never receives a
--      `running` row, never reads the manifest, and /super/health says why.
--
--   2. public.retention_object_manifest() NAMES NOTHING FOR A RUN THAT WOULD
--      REFUSE. It takes the run id now: no `running` run, no keys. It
--      re-asserts `replica`, the kill switch, the roll and the clocks ITSELF,
--      in the same call that produces the keys -- so there is no ordering of
--      runner calls, and no runner bug, that obtains an object key from a
--      database that would refuse the run. The old one-argument signature is
--      DROPPED rather than left beside it: a second way to get keys with no
--      gate in front of it is the hole, kept.
--
-- public.run_retention_sweep() keeps both assertions at step 0 as the third
-- line. Its `comment on function` said the roll is asserted "before a row
-- moves", which is true of rows and was read as covering bytes; it is
-- reissued below with the sentence that says which.
--
-- THE 20261003008000 SCRIPT COMMENT ("STEP 0, BEFORE A ROW MOVES", inside the
-- function body it created) is part of an applied migration and that file
-- stays as written. The corrections of record are the rebuilt function body
-- below, whose comment now says what the line does and does not protect, the
-- two reissued `comment on function` statements, and SECURITY.md § 8.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. WHAT WOULD REFUSE A RUN, AS A VALUE RATHER THAN AN EXCEPTION -- so the
--    caller can RECORD it instead of being rolled back by it.
-- ---------------------------------------------------------------------------

create or replace function private.retention_refusal()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_hint text; v_state text;
begin
  perform private.assert_retention_roll();
  perform private.assert_retention_clocks();
  return null;
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint, v_state = returned_sqlstate;
  return coalesce(nullif(v_hint, ''), v_state);
end;
$$;

comment on function private.retention_refusal() is
  'The hint of the first structural assertion that would refuse a retention run -- private.assert_retention_roll(), then private.assert_retention_clocks() -- or NULL when none would (Phase 8 Task 6 fix round 1, C2). A VALUE rather than an exception so that public.start_retention_run() can RECORD the refusal on a `refused` run row; raising would roll the row back with it and leave a silent non-run.';

revoke all on function private.retention_refusal() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. public.start_retention_run(), REBUILT FROM ITS LATEST DEFINITION
--    (20261003008000). The gate and the reaper are unchanged. New: the
--    `replica` refusal, and the structural refusals recorded beside the kill
--    switch's.
-- ---------------------------------------------------------------------------

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
  -- once it is older than the declared stuck_job period.
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

  return v_run;
end;
$$;

comment on function public.start_retention_run(boolean) is
  'OPENS one retention run, in its OWN transaction, and returns the row (Phase 8 Task 6). Separate from public.run_retention_sweep() for one reason: a run that takes the process down with it must leave evidence that it began, and a row written and completed inside a single call vanishes with the rollback it was the only record of. It also REAPS a previous run left `running` past the declared stuck_job period -- Q166''s shape applied to this job itself. SINCE 20261004002000 (review finding C2) IT IS WHERE EVERY REFUSAL THAT CAN STOP A RUN IS ASKED FIRST: `replica` raises; the kill switch, private.assert_retention_roll() and private.assert_retention_clocks() are each RECORDED as a `refused` run carrying the hint -- because the runner deletes OBJECTS between this call and public.run_retention_sweep(), and a tripwire that fires after the bytes are gone has protected nothing. "Nothing has been deleted since the 4th because somebody turned it off", "...because the schema grew a table nobody classified" and "there has been nothing to delete" must not look the same. SERVER-ONLY in the shape claim_erasure_job() uses: no auth.uid() AND a session role of postgres/service_role/none, an OPEN list of server roles so a client role added later is refused by omission. 20261003008000 corrected this from a test on `request.jwt.claims`, which PostgREST sets on EVERY request including the runner''s own.';

revoke all on function public.start_retention_run(boolean) from public, anon, authenticated, service_role;
grant execute on function public.start_retention_run(boolean) to service_role;


-- ---------------------------------------------------------------------------
-- 3. THE MANIFEST NAMES NOTHING FOR A RUN THAT WOULD REFUSE.
--
--    The five sources and the orphan half are the LATEST definition
--    (20261003002000), byte for byte, generated from the live function's
--    source rather than retyped; what is new is everything above
--    `return query`. `#variable_conflict use_column`, because the OUT
--    parameters share their names with the query's own columns.
-- ---------------------------------------------------------------------------

drop function public.retention_object_manifest(integer);

create or replace function public.retention_object_manifest(p_run_id uuid, p_limit integer default 500)
returns table (bucket text, object_key text, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_status  text;
  v_enabled boolean;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'retention_object_manifest: the retention runner is server-only'
      using errcode = '42501', hint = 'retention_runner_is_server_only';
  end if;

  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'retention_object_manifest: refuses to run with session_replication_role = %',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;

  -- NO RUNNING RUN, NO KEYS.
  select r.status into v_status from public.retention_runs r where r.id = p_run_id;
  if not found then
    raise exception 'retention_object_manifest: no such run'
      using errcode = '22023', hint = 'unknown_retention_run';
  end if;
  if v_status <> 'running' then
    raise exception 'retention_object_manifest: run % is %', p_run_id, v_status
      using errcode = '22023', hint = 'retention_run_is_not_running';
  end if;

  -- THE KILL SWITCH, AGAIN: it can be thrown between the start and this call,
  -- and "stop" should mean stop before the next object, not after this run.
  select s.enabled into v_enabled from public.retention_settings s where s.id;
  if v_enabled is distinct from true then
    raise exception 'retention_object_manifest: the retention job is switched off'
      using errcode = '55000', hint = 'retention_disabled';
  end if;

  -- AND THE TWO STRUCTURAL ASSERTIONS, IN THE SAME CALL THAT PRODUCES THE
  -- KEYS. This is the gate that holds whatever the runner does.
  perform private.assert_retention_roll();
  perform private.assert_retention_clocks();

  return query
    with expired_documents as (
      -- (a) A soft-deleted document whose class has run out.
      select 'documents'::text as bucket, d.storage_key as object_key,
             'document_expired'::text as reason, d.deleted_at as age
        from public.documents d
       where d.deleted_at is not null
         and d.bytes_purged_at is null
         and d.deleted_at < pg_catalog.now()
             - private.retention_period(private.document_retention_class(d.id))
    ),
    doomed_workspaces as (
      -- (b) EVERY document of a workspace whose 60 days are up, whatever its
      --     own class. The workspace is about to be hard-purged and
      --     private.erase_organisation() REFUSES to run while a single byte of
      --     it is still in the bucket -- so if these were not here, the
      --     workspace purge would refuse for ever and nothing would say why.
      select 'documents'::text, d.storage_key, 'workspace_purge'::text, o.retention_expires_at
        from public.documents d
        join public.organisations o on o.id = d.organisation_id
       where o.deleted_at is not null
         and o.retention_expires_at is not null
         and o.retention_expires_at < pg_catalog.now()
    ),
    expired_feedback as (
      -- (c) An expired feedback row's screenshot (Q120).
      select 'feedback-screenshots'::text, f.screenshot_key, 'feedback_expired'::text, f.created_at
        from public.feedback f
       where f.screenshot_key is not null
         and f.created_at < private.feedback_retention_cutoff()
    ),
    expired_exports as (
      -- (d) An export archive past its own expires_at. Task 4 enforced that
      --     expiry at READ time only -- public.record_export_download() refuses
      --     an expired job -- and nothing ever deleted the zip, so every export
      --     anyone has ever taken is still sitting in the bucket. Measured, not
      --     assumed: there is no other caller of storage.remove() for this
      --     bucket anywhere in the repository.
      select 'exports'::text, j.storage_key, 'export_expired'::text, j.expires_at
        from public.export_jobs j
       where j.storage_key is not null
         and j.expires_at is not null
         and j.expires_at < pg_catalog.now()
    ),
    candidates as (
      select * from expired_documents
      union all select * from doomed_workspaces
      union all select * from expired_feedback
      union all select * from expired_exports
    ),
    present as (
      -- ONLY WHAT IS ACTUALLY THERE. The join is what makes a second run over
      -- the same subject a no-op with no bookkeeping column to get out of step.
      select c.bucket, c.object_key, c.reason, c.age
        from candidates c
        join storage.objects s on s.bucket_id = c.bucket and s.name = c.object_key
    ),
    orphans as (
      -- (e) THE ORPHAN HALF (requirement 5): an object no row names at all,
      --     older than the grace period. This is the residue of a row delete
      --     whose object delete failed, and of any other way the two can come
      --     apart.
      select s.bucket_id::text as bucket, s.name as object_key,
             'orphan'::text as reason, s.created_at as age
        from storage.objects s
       where s.bucket_id in ('documents', 'feedback-screenshots', 'exports')
         and s.created_at < pg_catalog.now() - private.retention_period('storage_orphan')
         and not exists (select 1 from public.documents d where d.storage_key = s.name
                          and s.bucket_id = 'documents')
         and not exists (select 1 from public.feedback f where f.screenshot_key = s.name
                          and s.bucket_id = 'feedback-screenshots')
         and not exists (select 1 from public.export_jobs j where j.storage_key = s.name
                          and s.bucket_id = 'exports')
    )
    select bucket, object_key, reason
      from (select * from present union all select * from orphans) all_rows
     -- OLDEST FIRST, so a run that hits the ceiling leaves the newer remainder
     -- for the next one rather than skipping an arbitrary slice for ever.
     order by age, object_key
     limit greatest(coalesce(p_limit, 500), 0);
end;
$function$;

comment on function public.retention_object_manifest(uuid, integer) is
  'WHAT THE RETENTION RUNNER DELETES FROM THE BUCKETS, derived in the database (Phase 8 Task 6) -- AND, SINCE 20261004002000 (review finding C2), NOTHING AT ALL FOR A RUN THAT WOULD REFUSE. It takes the run id: no `running` run, no keys. It re-asserts `replica`, the kill switch, private.assert_retention_roll() and private.assert_retention_clocks() in the same call that produces the keys, so no ordering of runner calls and no runner bug obtains an object key from a database that would refuse the run. (The runner used to delete objects BEFORE step 0 was ever asked; the reviewer measured a run recorded `failed` whose file was already gone.) The erasure runner''s rule, for the same reason: the keys come from here and never from TypeScript, so a bug in the runner cannot aim a delete at a prefix the database did not name. Five sources -- an expired document''s bytes (Q52), every document of a workspace whose 60 days are up (because private.erase_organisation() refuses to run while one byte remains), an expired feedback row''s screenshot (Q120), an export archive past its own expires_at, and ORPHANS in all three buckets: objects no row names, older than the storage_orphan grace period. It lists only objects that EXIST, which is what makes the storage half idempotent with no bookkeeping column, and it returns them OLDEST FIRST under a ceiling, so a capped run leaves a remainder rather than skipping a slice. service_role only.';

revoke all on function public.retention_object_manifest(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.retention_object_manifest(uuid, integer) to service_role;


-- ---------------------------------------------------------------------------
-- 4. public.run_retention_sweep(), REBUILT FROM ITS LATEST DEFINITION
--    (20261003008000). ONE line added -- the clock roll beside the table roll
--    at step 0 -- and the comment above it corrected. Everything else is
--    byte-identical, generated from pg_get_functiondef() rather than retyped.
-- ---------------------------------------------------------------------------

create or replace function public.run_retention_sweep(p_run_id uuid, p_limit integer DEFAULT 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
  --
  -- "BEFORE A ROW MOVES" IS ALL THIS LINE EVER MEANT (review finding C2): the
  -- runner deletes OBJECTS before it calls this function, so by the time this
  -- fires the bytes are gone. What protects the bytes is the same two
  -- assertions made EARLIER, twice -- by public.start_retention_run(), which
  -- records the refusal and never returns a `running` row, and by
  -- public.retention_object_manifest(), which names no key at all unless they
  -- pass (20261004002000). They stay here as the third line, not the first.
  perform private.assert_retention_roll();
  perform private.assert_retention_clocks();

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

comment on function public.run_retention_sweep(uuid, integer) is
  'THE RETENTION RUN (Phase 8 Task 6): the eight sweeps, the run log''s completion and one summary audit row, all in ONE transaction. It asserts private.assert_retention_roll() and private.assert_retention_clocks() at step 0, BEFORE A ROW MOVES -- AND THAT IS ALL "BEFORE A ROW MOVES" MEANS. CORRECTION OF RECORD (20261004002000, review finding C2): this comment used to stop there, and was read as covering the bytes. It never did -- the runner deletes OBJECTS before it calls this function, and the reviewer measured a run this step refused whose file was already gone. What protects the bytes is the same two assertions made EARLIER, by public.start_retention_run() (which records the refusal and returns no `running` row) and by public.retention_object_manifest() (which names no key unless they pass); here they are the third line. It threads every audit row written anywhere inside the run onto the run''s correlation id -- setting the marker GUC itself, because private.begin_lifecycle_transition() requires an aal2 superuser and this has no session, and because the marker alone grants nothing (organisations_update_platform_lifecycle is a conjunction whose first term a sessionless caller fails). The summary row is written DIRECTLY into public.audit_events, the sixth writer to do so, because private.log_audit_event() requires auth.uid() and a retention run has nobody on it; the actor is the Q130 tombstone, as private.erase_organisation()''s summary row already is. A DRY run writes the summary row too, marked `"mode": "dry"` -- the founder previewing what would be deleted is itself a thing the audit log should be able to answer. service_role only, refuses a session with a person on it, and refuses any session_replication_role but `origin`.';

revoke all on function public.run_retention_sweep(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.run_retention_sweep(uuid, integer) to service_role;

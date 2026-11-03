-- ===========================================================================
-- Q228 TASK 1: A CLOSURE BACKUP OF ANY SIZE, IN PARTS -- THE PARTS TABLE, THE
-- JOB COLUMNS AND THEIR GUARDS (founder ruling Q228 CHANGED, 2026-10-10;
-- docs/superpowers/specs/2026-10-10-closure-backup-parts-design.md).
--
-- WHAT THIS ADDS
--   1. public.export_jobs.part_count and .resume_cursor -- written only by
--      service_role, closure backups only (export_jobs_part_count_shape).
--   2. public.export_job_parts -- one row per stored part of a closure backup.
--      RLS on before any grant; SELECT under the parent job's own-row rule
--      (export_jobs_select_own, reused through a subquery, not restated); no
--      client write at all. service_role holds SELECT, INSERT and DELETE
--      (plan Spec correction 3: a `delete ... where job_id = ...` needs
--      SELECT), never UPDATE.
--   3. private.export_job_parts_guard() -- a part is written only by the
--      server, only for a RUNNING closure backup, only as the next part in
--      order; it is deleted only once its job has FAILED (or by the cascade
--      from its job's own delete).
--
-- WHAT THIS REBUILDS (each from its LIVE pg_get_functiondef, which equals the
-- text in the migration named; only the stated lines change):
--   private.export_jobs_before_update()  from 20261029002000:92
--     + the one backward transition: running -> queued, closure backups
--       only, with a resume cursor and part_count advanced by one and equal
--       to the stored part rows (hints illegal_export_transition,
--       export_part_count_mismatch);
--     + a success must count every stored part (export_part_count_mismatch);
--       a FAILURE never is (the reaper must always be able to fail a job);
--     + a failure clears resume_cursor, so the CHECK below can never abort
--       private.reap_stuck_jobs() on a stuck re-claimed closure backup.
--   public.claim_export_job()            from 20260927002000:375
--     the queue order only: coalesce(started_at, requested_at), seq -- a
--     re-queued closure backup waits behind the jobs that were already
--     waiting when it was last claimed (plan Spec correction 7).
--   private.retention_subjects()         from 20261030003000:1290
--     + the export_job_parts row (`cascades`), and the export_jobs row's
--     wrong last sentence corrected (plan Spec correction 1).
--
-- WHAT THIS DOES NOT CHANGE. Ordinary workspace and account exports: their
-- part_count is 0 and their resume_cursor null by CHECK, and every
-- transition they could make before they can make now and no other. A
-- closure backup planted or built before this migration (succeeded, 0 part
-- rows, part_count 0) is one archive at storage_key, which is what
-- part_count = 0 means (plan Spec correction 9).
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE JOB COLUMNS.
-- ---------------------------------------------------------------------------
alter table public.export_jobs
  add column part_count integer not null default 0,
  add column resume_cursor jsonb;

alter table public.export_jobs
  add constraint export_jobs_part_count_shape check (
    part_count >= 0
    and (closure_backup or part_count = 0)
    and (resume_cursor is null or (closure_backup and status in ('queued', 'running'))));

comment on column public.export_jobs.part_count is
  'Q228: how many parts of a CLOSURE BACKUP are stored -- always equal to the job''s public.export_job_parts rows when the job is re-queued or stamped succeeded (private.export_jobs_before_update(), hint export_part_count_mismatch). 0 means one archive at storage_key: every ordinary export (CHECK export_jobs_part_count_shape), and a closure backup built or planted before parts existed. Written only by service_role (column grant), from a session with no person on it.';

comment on column public.export_jobs.resume_cursor is
  'Q228: the export runner''s opaque resume point for a closure backup between claims -- which table and key to read after, and the running totals. Never a person''s data, never read by a client. Present only on a queued or running closure backup (CHECK export_jobs_part_count_shape); a failure clears it (private.export_jobs_before_update()) and the runner''s success update sets it to null. Written only by service_role (column grant).';

grant update (part_count, resume_cursor) on public.export_jobs to service_role;

-- ---------------------------------------------------------------------------
-- 2. THE PARTS TABLE.
-- ---------------------------------------------------------------------------
create table public.export_job_parts (
  job_id      uuid    not null references public.export_jobs (id) on delete cascade,
  part_no     integer not null,
  storage_key text    not null,
  byte_size   bigint  not null,
  row_count   bigint  not null,
  created_at  timestamptz not null default now(),
  primary key (job_id, part_no),
  constraint export_job_parts_part_no check (part_no >= 1),
  constraint export_job_parts_counts check (byte_size >= 0 and row_count >= 0),
  -- THE KEY CARRIES NO USER INPUT and is derived from the job id and the
  -- part number, the export_jobs_storage_key_shape rule extended: part 1 is
  -- today's key (so a single-part backup is where it always was, and the
  -- job's own storage_key names it); part n >= 2 is `-part-` and n padded to
  -- AT LEAST four digits. greatest() keeps the pad from TRUNCATING a longer
  -- number (lpad('12345', 4) is '1234'), which would collide once the
  -- uncapped part count passed 9 999 (plan Spec correction 10). Mirrored by
  -- exportStorageKey(jobId, part) in TypeScript.
  constraint export_job_parts_storage_key_shape check (storage_key =
    case when part_no = 1 then 'exports/' || job_id::text || '.zip'
         else 'exports/' || job_id::text || '-part-'
              || pg_catalog.lpad(part_no::text, greatest(4, pg_catalog.length(part_no::text)), '0')
              || '.zip' end)
);
-- No separate job_id index: the primary key's leading column is the FK's index.

comment on table public.export_job_parts is
  'Q228: one row per stored part of a CLOSURE BACKUP (export_jobs.closure_backup). Each part is a complete zip under the per-archive ceilings of private.export_limits(); together they are the whole backup, and the last carries the index in the job''s manifest. RLS: the requester of the parent job reads its parts (export_job_parts_select_own) and nobody else. NO CLIENT WRITE: authenticated holds SELECT only, anon nothing, service_role SELECT/INSERT/DELETE and never UPDATE. private.export_job_parts_guard() admits an insert only from a session with no person on it, only for a running closure backup, only as part part_count + 1; and a delete only once the job has FAILED, or as the cascade from the job''s own delete. Retention: cascades with its job (private.retention_subjects()).';

alter table public.export_job_parts enable row level security;

create policy export_job_parts_select_own on public.export_job_parts
  for select to authenticated
  using (exists (select 1 from public.export_jobs j where j.id = export_job_parts.job_id));
-- The subquery runs under the CALLER's RLS on export_jobs, i.e. export_jobs_select_own
-- (requested_by = auth.uid()): the rule is reused, not restated.

comment on policy export_job_parts_select_own on public.export_job_parts is
  'Q228: a part is readable exactly when its parent export job is. The EXISTS subquery reads public.export_jobs under the CALLER''s own RLS, i.e. export_jobs_select_own (requested_by = auth.uid()) -- the requester''s own jobs and nobody else''s, not a second Admin of the same workspace -- so the rule is REUSED, not restated, and cannot drift from it.';

revoke all on public.export_job_parts from public, anon, authenticated, service_role;
grant select on public.export_job_parts to authenticated;
grant select, insert, delete on public.export_job_parts to service_role;

-- ---------------------------------------------------------------------------
-- 3. THE PART GUARD.
-- ---------------------------------------------------------------------------
create or replace function private.export_job_parts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_server_session boolean;
  v_closure        boolean;
  v_status         text;
  v_part_count     integer;
begin
  -- THE CASCADE FIRST. A part deleted while its parent job is no longer
  -- visible is the FK's ON DELETE CASCADE from the job's own delete (the
  -- workspace purge, an account deletion): the FK guarantees a part row
  -- always has a job, so "no job" can only mean "being deleted with it".
  -- Admitted before the session test so a purge that cascades from a
  -- definer RPC never depends on whose session it ran in.
  if tg_op = 'DELETE' then
    select j.status into v_status from public.export_jobs j where j.id = old.job_id;
    if not found then
      return old;
    end if;
  end if;

  -- THE SERVER, AND NOBODY ELSE (private.export_jobs_before_update()'s open
  -- list of server roles: a role this schema has never heard of arrives
  -- refused rather than admitted by omission).
  v_server_session := (select auth.uid()) is null
                      and coalesce(pg_catalog.current_setting('role', true), '')
                            in ('postgres', 'service_role', 'none', '');
  if not v_server_session then
    raise exception 'export_job_parts: a part is written by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_part_is_server_only';
  end if;

  if tg_op = 'INSERT' then
    -- The parent is LOCKED, so a re-queue or a finish racing this insert
    -- waits for it and then counts it.
    select j.closure_backup, j.status, j.part_count
      into v_closure, v_status, v_part_count
      from public.export_jobs j where j.id = new.job_id
       for update;
    if not coalesce(v_closure, false) then
      raise exception 'export_job_parts: only a closure backup is built in parts'
        using errcode = '22023', hint = 'export_parts_are_closure_only';
    end if;
    if v_status <> 'running' then
      raise exception 'export_job_parts: a part is stored only while its job is running'
        using errcode = '22023', hint = 'export_part_needs_a_running_job';
    end if;
    if new.part_no <> v_part_count + 1 then
      raise exception 'export_job_parts: parts are stored in order, and the next one is %', v_part_count + 1
        using errcode = '22023', hint = 'export_part_out_of_order';
    end if;
    new.created_at := pg_catalog.now();
    return new;
  end if;

  -- DELETE of a part whose job still exists: only once the job has FAILED
  -- (the runner removing a failed build's parts). A queued, running or
  -- succeeded job's parts are the backup, or are becoming it.
  if v_status <> 'failed' then
    raise exception 'export_job_parts: a part of a backup that is kept, or still being built, is not deleted'
      using errcode = '42501', hint = 'export_part_of_a_kept_backup';
  end if;
  return old;
end;
$$;

comment on function private.export_job_parts_guard() is
  'Q228: BEFORE INSERT OR DELETE on public.export_job_parts. Admits (1) the cascade from the parent job''s own delete (no parent visible); otherwise refuses any session with a person on it (42501 export_part_is_server_only). INSERT: locks the parent; refuses a non-closure job (22023 export_parts_are_closure_only), a job not running (22023 export_part_needs_a_running_job), and any part but part_count + 1 (22023 export_part_out_of_order); stamps created_at. DELETE: only of a FAILED job''s part (else 42501 export_part_of_a_kept_backup). SECURITY DEFINER so it reads the parent whatever the caller''s RLS; EXECUTE revoked from every API role.';

revoke all on function private.export_job_parts_guard() from public, anon, authenticated, service_role;

create trigger export_job_parts_guard
  before insert or delete on public.export_job_parts
  for each row execute function private.export_job_parts_guard();

-- ---------------------------------------------------------------------------
-- 4. THE JOB TRANSITIONS: private.export_jobs_before_update(), rebuilt from
--    its live text (20261029002000:92). Changes, and nothing else: the
--    re-queue clause before the legal-transition check; the part count on a
--    success; the cursor cleared on a failure.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.export_jobs_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid            uuid := (select auth.uid());
  v_session_role   text := coalesce(pg_catalog.current_setting('role', true), '');
  v_server_session boolean;
  v_days           integer;
begin
  -- AN OPEN LIST OF SERVER ROLES, not a closed list of client ones: a role
  -- this schema has never heard of arrives REFUSED rather than admitted by
  -- omission. `none` and the empty string are what current_setting('role')
  -- answers for a plain superuser session that has not `set role`. Neither
  -- leg is bypassable by SECURITY DEFINER: it changes the current USER and
  -- touches neither the JWT claims nor the `role` SETTING, so both still
  -- describe whoever issued the statement.
  v_server_session := v_uid is null
                      and v_session_role in ('postgres', 'service_role', 'none', '');

  -- Q229 (Phase 8 final review A, I2): THE ONE PERMITTED REWRITE OF A
  -- FINISHED JOB. When the superuser deletes a closed workspace,
  -- the decision RPC (delete_closed_workspace) RAISES its succeeded closure backup's
  -- expires_at to at least the decision + private.closure_backup_hold(), so
  -- the closing Owner can still download it while the purge is held for it.
  -- Admitted only (a) for a succeeded closure_backup row, (b) while that RPC
  -- has named THIS job in its transaction-local marker, (c) upwards, and
  -- (d) when nothing else on the row moves. It is checked before the
  -- server-session leg because the decision runs in the superuser's session.
  if old.closure_backup
     and old.status = 'succeeded'
     and pg_catalog.current_setting('app.closure_backup_hold', true) = old.id::text
     and new.expires_at > old.expires_at
     and (pg_catalog.to_jsonb(new) - 'expires_at') = (pg_catalog.to_jsonb(old) - 'expires_at') then
    return new;
  end if;

  if not v_server_session then
    raise exception 'export_jobs: a job''s progress is written by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_outcome_is_server_only';
  end if;

  -- Q206 (Task 9c job 2): THE ONE PERMITTED REWRITE OF requested_by. A
  -- workspace's CLOSURE BACKUP outlives the Owner who closed it: when
  -- private.erase_account() erases that Owner it re-points the backup's
  -- requester at the Q130 tombstone instead of letting ON DELETE CASCADE take
  -- the row. Admitted only (a) for a closure_backup row, (b) to the tombstone,
  -- (c) while erase_account has named THIS requester in its transaction-local
  -- marker, and (d) when nothing else on the row moves -- finished or not.
  if old.closure_backup
     and new.requested_by = private.erased_user_id()
     and old.requested_by is distinct from new.requested_by
     and pg_catalog.current_setting('app.erasing_account', true) = old.requested_by::text
     and (pg_catalog.to_jsonb(new) - 'requested_by') = (pg_catalog.to_jsonb(old) - 'requested_by') then
    return new;
  end if;

  -- THE REQUEST ITSELF IS IMMUTABLE. Who asked, which kind, which workspace
  -- and when: the archive's provenance, and nothing may rewrite it.
  if new.id is distinct from old.id
     or new.seq is distinct from old.seq
     or new.kind is distinct from old.kind
     or new.organisation_id is distinct from old.organisation_id
     or new.requested_by is distinct from old.requested_by
     or new.requested_aal is distinct from old.requested_aal
     or new.requested_at is distinct from old.requested_at
     or new.closure_backup is distinct from old.closure_backup then
    raise exception 'export_jobs: the request itself is immutable -- only its progress and its outcome may change'
      using errcode = '42501', hint = 'export_request_is_immutable';
  end if;

  -- A CLOSED JOB IS IMMUTABLE. A succeeded archive cannot be re-pointed at
  -- another key, and a failure cannot be quietly turned into a success.
  if old.status in ('succeeded', 'failed') then
    raise exception 'export_jobs: a finished job is not rewritten'
      using errcode = '22023', hint = 'export_job_is_finished';
  end if;

  -- Q228 (20261101000000): THE ONE BACKWARD TRANSITION. A closure backup is
  -- built one part per claim: after the runner has stored a part and recorded
  -- its export_job_parts row, it puts the job back in the queue with a resume
  -- cursor so the next claim builds the next part. Admitted only (a) for a
  -- closure_backup row, (b) with a cursor to resume from, (c) with part_count
  -- advanced by exactly one, and (d) when part_count then equals the job's
  -- stored part rows. started_at is kept (a claim re-stamps it), and the
  -- finish stamps stay empty. Every other running -> queued is refused below
  -- exactly as before.
  if old.status = 'running' and new.status = 'queued' then
    if not (old.closure_backup and new.resume_cursor is not null
            and new.part_count = old.part_count + 1) then
      raise exception 'export_jobs: a job cannot go from running to queued' using errcode = '22023', hint = 'illegal_export_transition';
    end if;
    if new.part_count <> (select pg_catalog.count(*) from public.export_job_parts p where p.job_id = old.id) then
      raise exception 'export_jobs: part_count does not match the stored parts' using errcode = '22023', hint = 'export_part_count_mismatch';
    end if;
    new.started_at := old.started_at; new.completed_at := null; new.expires_at := null;
    return new;
  end if;

  if not (   (old.status = 'queued'  and new.status in ('running', 'failed'))
          or (old.status = 'running' and new.status in ('succeeded', 'failed'))) then
    raise exception 'export_jobs: a job cannot go from % to %', old.status, new.status
      using errcode = '22023', hint = 'illegal_export_transition';
  end if;

  -- Q228: A SUCCESS COUNTS EVERY STORED PART. part_count must equal the
  -- job's export_job_parts rows when it is stamped succeeded, so a success
  -- with a lagging count (the index naming fewer parts than are stored) is
  -- impossible. 0 = 0 for a single archive at storage_key (the legacy and
  -- planted shape). NEVER CHECKED ON A FAILURE: a part can be stored and the
  -- re-queue then fail, leaving part_count one behind, and a raise here would
  -- abort the runner's own fail-update and private.reap_stuck_jobs() -- and
  -- with it the whole retention run.
  if new.status = 'succeeded'
     and new.part_count <> (select pg_catalog.count(*) from public.export_job_parts p where p.job_id = old.id) then
    raise exception 'export_jobs: part_count does not match the stored parts' using errcode = '22023', hint = 'export_part_count_mismatch';
  end if;

  -- Q228: A FAILED JOB HAS NOTHING TO RESUME. export_jobs_part_count_shape
  -- admits a resume_cursor only while queued or running, and
  -- private.reap_stuck_jobs() fails a stuck job without naming the column, so
  -- the cursor is cleared here rather than letting the CHECK abort the
  -- reaper (and the retention run) on a stuck re-claimed closure backup.
  -- Never cleared on a success: the CHECK refuses a success that still
  -- carries one, and the runner's success update sets it to null itself.
  if new.status = 'failed' then
    new.resume_cursor := null;
  end if;

  -- THE STAMPS ARE THE DATABASE'S, so a finished job's times say when it
  -- finished rather than what a runner claimed.
  if new.status = 'running' then
    new.started_at := pg_catalog.now();
  else
    new.started_at := old.started_at;
  end if;

  if new.status in ('succeeded', 'failed') then
    new.completed_at := pg_catalog.now();
  end if;

  if new.status = 'succeeded' then
    select l.archive_days into v_days from private.export_limits() l;
    new.expires_at := pg_catalog.now() + pg_catalog.make_interval(days => v_days);
    -- A CLOSURE BACKUP is kept for as long as the closed workspace itself is
    -- (private.organisation_retention_days(), through retention_expires_at --
    -- the same Q88 clock the 60-day purge reads), never less than an ordinary
    -- archive. greatest() ignores a null, so a workspace reinstated before the
    -- backup finished gets the ordinary window.
    if old.closure_backup then
      new.expires_at := greatest(new.expires_at,
        (select o.retention_expires_at from public.organisations o
          where o.id = old.organisation_id));
    end if;
    new.failure_reason := null;
  else
    new.expires_at := null;
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. THE QUEUE ORDER: public.claim_export_job(), rebuilt from its live text
--    (20260927002000:375) with the `order by` line only. A re-queued closure
--    backup keeps its requested_at (the request is immutable), so ordering by
--    it would re-claim the backup ahead of every other export until all its
--    parts were built. Ordering by the last claim puts it behind the jobs
--    that were already waiting (plan Spec correction 7).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_export_job()
 RETURNS TABLE(id uuid, kind text, organisation_id uuid, requested_by uuid, requested_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'claim_export_job: jobs are claimed by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_runner_is_server_only';
  end if;

  select j.id into v_id
    from public.export_jobs j
   where j.status = 'queued'
   -- Q228: a re-queued closure backup's place is its LAST CLAIM, not its
   -- request, so the jobs that were waiting are served between its parts.
   order by coalesce(j.started_at, j.requested_at), j.seq
   for update skip locked
   limit 1;

  if v_id is null then
    return;
  end if;

  update public.export_jobs j set status = 'running' where j.id = v_id;

  return query
    select j.id, j.kind, j.organisation_id, j.requested_by, j.requested_at
      from public.export_jobs j where j.id = v_id;
end;
$function$;

comment on function public.claim_export_job() is
  'Claims the oldest queued export job and moves it to `running`, or returns no row (Phase 8 Task 4). `for update skip locked` is what makes exactly one runner take a job when two tick at once -- the request''s own nudge and the pg_cron safety net. Refuses any session with a person on it (42501, hint export_runner_is_server_only). EXECUTE is granted to service_role alone. It returns no CONTENT: the id, the kind, the workspace, the requester and when they asked -- everything the runner needs and nothing about anybody''s records. SINCE Q228 (20261101000000) "oldest" is coalesce(started_at, requested_at): a closure backup re-queued between its parts takes its place from its LAST CLAIM, so the exports that were waiting are served in between rather than starved until every part is built.';

-- ---------------------------------------------------------------------------
-- 6. THE RETENTION ROLL: private.retention_subjects(), rebuilt from its live
--    text (20261030003000:1290) with the export_job_parts row added and the
--    export_jobs row's last sentence corrected -- the archive bytes are
--    purged by the retention runner from public.retention_object_manifest(),
--    never by "the export runner's own expiry", which does not exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.retention_subjects()
 RETURNS TABLE(table_name text, treatment text, class text, reason text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- ---- swept, each by a named class ------------------------------------
    ('audit_events',        'swept', 'audit_total',
     'private.purge_audit_events(), the one sweep that destroys evidence. Hard floor, sanity ceiling, dry run, counts either side.'),
    ('feedback',            'swept', 'feedback',
     'private.sweep_feedback(): the row and its feedback-screenshots object (Q120).'),
    ('rate_limit_counters', 'swept', 'rate_limit_counter',
     'private.sweep_rate_limit_counters(): closed windows nobody came back to (Q110).'),
    ('incident_alerts',     'swept', 'incident_alert',
     'private.sweep_incident_alerts(): RESOLVED alerts only; an open one is never purged at any age (Q117).'),
    ('erasure_jobs',        'swept', 'erasure_job_failed',
     'private.sweep_erasure_jobs(): FAILED rows only. A succeeded row is pseudonymous and is kept for ever as the proof (Q175).'),
    ('export_jobs',         'swept', 'stuck_job',
     'private.reap_stuck_jobs(): a row left `running` is failed, not deleted, so the one-live-job index stops blocking the subject (Q166). The archive bytes are purged by the retention runner from public.retention_object_manifest() (expiry and orphans).'),
    ('documents',           'swept', 'operational',
     'private.sweep_document_bytes(): the BYTES of a soft-deleted document, once its parent record''s class has run out (Q52). The row survives -- see the column comment on documents.bytes_purged_at.'),
    ('organisations',       'swept', 'workspace',
     'private.sweep_expired_workspaces() -> private.erase_organisation(): 60 days after suspension or closure (Q88/Q92/Q102). Everything classified `cascades` below goes with it.'),

    -- ---- goes with its parent --------------------------------------------
    ('export_job_parts',            'cascades', null, 'FK to public.export_jobs, ON DELETE CASCADE: a part row goes with its job. Its OBJECT is named by public.retention_object_manifest() on expiry, and is an orphan once its job is failed or gone.'),
    ('document_links',              'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE.'),
    ('document_versions',           'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE. Dormant (SELECT-only, no write path) until Release 1.1.'),
    ('data_subject_request_notes',  'cascades', null, 'FK to public.data_subject_requests, ON DELETE CASCADE.'),
    ('organisation_memberships',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_subscriptions',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_billing_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_feature_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_values',         'cascades', null,
     'FK to public.organisations cascades, AND private.sweep_custom_field_values() runs first for the polymorphic half no foreign key protects (20260930002000).'),
    ('impersonation_sessions',      'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('event_status_changes',        'cascades', null, 'Composite FK to public.events, ON DELETE CASCADE.'),
    ('artist_fee_history',          'cascades', null, 'Composite FK to public.artists, ON DELETE CASCADE.'),
    ('contact_companies',           'cascades', null, 'Composite FKs to public.contacts and public.companies, ON DELETE CASCADE.'),
    ('artist_representations',      'cascades', null, 'Composite FKs to public.artists and public.agencies, ON DELETE CASCADE.'),
    ('event_lineup',                'cascades', null, 'Composite FKs to public.events and public.artists, ON DELETE CASCADE.'),
    ('task_links',                  'cascades', null, 'Composite FK to public.tasks, ON DELETE CASCADE.'),
    ('meeting_links',               'cascades', null, 'Composite FK to public.meetings, ON DELETE CASCADE.'),
    ('note_links',                  'cascades', null, 'Composite FK to public.notes, ON DELETE CASCADE.'),
    ('network_links',               'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('network_connection_requests', 'cascades', null, 'FKs to public.organisations, ON DELETE CASCADE.'),
    ('network_profiles',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_definitions',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('merges',                      'cascades', null,
     'FK to public.organisations, ON DELETE CASCADE -- and field_resolution is scrubbed first, because it holds the discarded record''s values verbatim.'),
    ('merge_candidates',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),

    -- ---- tenant records: retained with their workspace (Q180) -------------
    ('contacts',          'retained_with_workspace', null, 'A soft-deleted CRM record stays readable to its workspace. Q180 asks whether it should expire on its own.'),
    ('companies',         'retained_with_workspace', null, 'See contacts.'),
    ('artists',           'retained_with_workspace', null, 'See contacts.'),
    ('agencies',          'retained_with_workspace', null, 'See contacts.'),
    ('venues',            'retained_with_workspace', null, 'See contacts.'),
    ('venue_rooms',       'retained_with_workspace', null, 'See contacts.'),
    ('events',            'retained_with_workspace', null, 'See contacts.'),
    ('tasks',             'retained_with_workspace', null, 'See contacts.'),
    ('meetings',          'retained_with_workspace', null, 'See contacts.'),
    ('notes',             'retained_with_workspace', null, 'See contacts.'),
    ('financial_entries', 'retained_with_workspace', null,
     'And the LONGEST class if Q180 is ever taken: seven years, not two. A financial entry is the thing CLAUDE.md''s "7 years for financial records" is about.'),

    -- ---- the person's own records ----------------------------------------
    ('consents',              'never_purged', null,
     'A consent record is the evidence of a lawful basis (UK GDPR Art 7(1)); deleting it destroys the proof that processing was lawful. It goes with the ACCOUNT, in private.erase_account(), and on no clock of its own (Q173).'),
    ('data_subject_requests', 'never_purged', null,
     'The statutory register: the evidence that a request was answered inside 30 days. It SURVIVES the erasure it answered, anonymised (Q173), and is on no clock.'),
    ('profiles',              'cascades', null, 'FK to auth.users, ON DELETE CASCADE -- and private.erase_account() is what makes that happen.'),

    -- ---- the retention job's own bookkeeping (added in 20261003002000) ---
    ('retention_runs',     'never_purged', null,
     'The run log itself. It is the evidence of what the garbage collector deleted and when, and a garbage collector that garbage-collects its own record of what it deleted is the one thing on this list that must not exist. Counts only -- the table has no column that could hold a record -- so it grows by one row per run and nothing else.'),
    ('retention_settings', 'platform_reference', null,
     'One enforced row: the two kill switches. Not a record about anybody.'),

    -- ---- the platform's own ----------------------------------------------
    ('legal_documents',  'never_purged', null,
     'A PUBLISHED legal version is immutable and permanent: it is what the product promised on a given date, and a consent points at it by version.'),
    ('platform_admins',  'platform_reference', null, 'Who the superuser is. One row.'),
    ('permissions',      'platform_reference', null, 'The permission catalogue.'),
    ('roles',            'platform_reference', null, 'The role catalogue.'),
    ('role_permissions', 'platform_reference', null, 'The role/permission matrix.'),
    ('subscription_plans',   'platform_reference', null, 'The tier catalogue.'),
    ('rate_limit_policies',  'platform_reference', null, 'The rate-limit budgets. The COUNTERS are swept; the policies are the catalogue.'),

    -- ---- the notice ledger (added in 20261016000000) ----------------------
    ('private.notification_deliveries', 'cascades', null,
     'One row per connection-request / task-reminder email accepted by Brevo: a notice name, a subject id and a time -- no address, no content. FKs to public.tasks and public.network_connection_requests, ON DELETE CASCADE: a stamp goes with the row it is about, and both of those go with their workspace.'),

    -- ---- the closure-backup marker (added in 20261027000000) -------------
    ('private.closure_backup_reads', 'ephemeral', null,
     'One row per transaction in which public.export_read_page() is reading a closure_backup job (20261025000000, Task 9c C1): a transaction id, the organisation id and the export job id -- no tenant data. Inserted and deleted inside that one call, on both its success and its failure path, so the table is empty at rest (rls_phase8_closure_backup.sql KA7/KM). Nothing to sweep; the FKs also cascade with the workspace and the job.'),

    -- ---- integrations (tables 20261030000000; classes 20261030003000) ---
    ('integration_connections', 'swept', 'integration_connection_revoked',
     'private.sweep_integration_records(): a REVOKED connection, once its class has run from revocation; its token went when it was revoked. A live one goes with its workspace (erase_organisation step 5c deletes the Vault secrets first) or, person-scoped, with its owner''s account (erase_account step 5c) or membership (the membership trigger revokes it).'),
    ('integration_sync_runs',   'swept', 'integration_sync_run',
     'private.sweep_integration_records(): a FINISHED run, once its class has run. Also goes with its connection (composite FK, ON DELETE CASCADE) and its workspace.')
$function$;

-- ---------------------------------------------------------------------------
-- 7. SELF-CHECKS. The migration refuses itself rather than ship a roll that
--    does not classify the new table, or a trigger without its new refusals.
-- ---------------------------------------------------------------------------
do $$
declare v_src text;
begin
  perform private.assert_retention_roll();

  v_src := pg_catalog.pg_get_functiondef('private.export_jobs_before_update()'::regprocedure);
  if (pg_catalog.length(v_src) - pg_catalog.length(pg_catalog.replace(v_src, 'export_part_count_mismatch', '')))
       / pg_catalog.length('export_part_count_mismatch') < 2
     or v_src not like '%if old.status = ''running'' and new.status = ''queued'' then%' then
    raise exception 'Q228 self-check: export_jobs_before_update() is missing the re-queue clause or a part-count check';
  end if;

  v_src := pg_catalog.pg_get_functiondef('private.export_job_parts_guard()'::regprocedure);
  if v_src not like '%export_part_is_server_only%'
     or v_src not like '%export_parts_are_closure_only%'
     or v_src not like '%export_part_needs_a_running_job%'
     or v_src not like '%export_part_out_of_order%'
     or v_src not like '%export_part_of_a_kept_backup%' then
    raise exception 'Q228 self-check: export_job_parts_guard() is missing a refusal';
  end if;

  if pg_catalog.pg_get_functiondef('public.claim_export_job()'::regprocedure)
       not like '%order by coalesce(j.started_at, j.requested_at), j.seq%' then
    raise exception 'Q228 self-check: claim_export_job() does not order by the last claim';
  end if;

  if not exists (select 1 from pg_catalog.pg_class c
                  where c.oid = 'public.export_job_parts'::regclass and c.relrowsecurity) then
    raise exception 'Q228 self-check: export_job_parts has RLS off';
  end if;
end;
$$;

-- ===========================================================================
-- Q228 TASK 3 -- A CLOSURE BACKUP IN PARTS: EACH PART IS DOWNLOADED AND
-- AUDITED, Q229'S PURGE HOLD WAITS FOR EVERY PART, AND THE RETENTION
-- MANIFEST PURGES EVERY PART (and never a part of a backup that is kept).
--
-- Three functions, each rebuilt from its LATEST definition:
--   * public.audit_export_download    from 20260927005000:26
--   * private.closure_backup_owed     from 20261029002000:55
--   * public.retention_object_manifest from 20261005000000:268
--
-- 1. audit_export_download(p_job_id, p_part default 1). The (uuid) form is
--    DROPPED, not overloaded: two signatures would be two grants to keep in
--    step. The four existing refusals are verbatim and come FIRST, so the
--    IDOR term (requested_by = auth.uid()) still answers before anything
--    about parts does -- a stranger asking for part 2 of somebody's backup
--    learns `not_your_export`, never whether a part 2 exists. Then the new
--    refusal, export_part_not_found (22023): a null/zero/negative part, or a
--    part > 1 with no export_job_parts row. Part 1 needs no row: it is the
--    job's own storage_key, which is all a legacy or ordinary export has.
--    The audit payload gains `part`.
--
-- 2. closure_backup_owed(): the hold releases only when the requester has a
--    download row for EVERY part 1..greatest(part_count, 1). A row with no
--    `part` key (every download before this migration) counts as part 1, so
--    a legacy single-archive backup already downloaded stays released.
--
-- 3. retention_object_manifest(): (a) an expired backup's parts 2+ are named
--    `export_expired` beside part 1 (the job's storage_key, already named);
--    (b) PLAN SPEC CORRECTION 2, THE CRITICAL ONE: the orphan half no longer
--    names a part object whose row belongs to a job that has not failed.
--    Without it, parts 2+ of a succeeded backup -- named by no export_jobs
--    row -- were orphans one day after they were written, and the hourly run
--    would have deleted them while the backup was still owed. A FAILED job's
--    parts stay orphans: the runner removes them itself, and this is the
--    backstop if it could not.
--
-- No new CLOCK is read (the new reads are part_count, storage_key, status and
-- audit_events.after), but the clock derivation matches columns by name and
-- now sees export_job_parts.created_at: section 4 classifies it `not_a_clock`
-- (the brief's conditional), and the self-check at the end asks
-- private.assert_retention_clocks() to agree.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE DOWNLOAD AUDIT, PER PART
-- ---------------------------------------------------------------------------
drop function public.audit_export_download(uuid);

create function public.audit_export_download(p_job_id uuid, p_part integer default 1)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.export_jobs%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'audit_export_download: no session' using errcode = '28000';
  end if;

  select * into v_job from public.export_jobs j
   where j.id = p_job_id and j.requested_by = (select auth.uid());
  if not found then
    raise exception 'audit_export_download: no such export of yours'
      using errcode = '42501', hint = 'not_your_export';
  end if;

  if v_job.status <> 'succeeded' then
    raise exception 'audit_export_download: that export has no archive'
      using errcode = '22023', hint = 'export_has_no_archive';
  end if;

  if v_job.expires_at is null or v_job.expires_at <= pg_catalog.now() then
    raise exception 'audit_export_download: that archive has expired'
      using errcode = '22023', hint = 'export_archive_expired';
  end if;

  -- Q228: WHICH PART. Asked only after the job is known to be the caller's,
  -- so the answer is never an oracle for somebody else's backup.
  if p_part is null or p_part < 1
     or (p_part > 1 and not exists (select 1 from public.export_job_parts p
                                     where p.job_id = v_job.id and p.part_no = p_part)) then
    raise exception 'audit_export_download: that export has no such part'
      using errcode = '22023', hint = 'export_part_not_found';
  end if;

  perform private.log_audit_event(
    p_action          => 'export_job.downloaded',
    p_target_type     => 'export_job',
    p_organisation_id => v_job.organisation_id,
    p_target_id       => v_job.id,
    p_after           => pg_catalog.jsonb_build_object('kind', v_job.kind, 'part', p_part));
end;
$$;

revoke all on function public.audit_export_download(uuid, integer) from public, anon, service_role;
grant execute on function public.audit_export_download(uuid, integer) to authenticated;

comment on function public.audit_export_download(uuid, integer) is
  'Records that the requester downloaded ONE PART of their own export archive, and refuses everything else -- a job that is not theirs (42501, hint not_your_export: the IDOR gate, asked here as well as by the SELECT policy so the audit path cannot be the weaker of the two, and asked BEFORE the part so it is never an oracle for another person''s backup), one with no archive (export_has_no_archive), one whose read-time expiry has passed (export_archive_expired), and (since 20261101001000, Q228) a part that is null, below 1, or above 1 with no export_job_parts row (export_part_not_found, 22023). Part 1 is the job''s own storage_key and needs no part row, so an ordinary or legacy export is part 1 of 1. The download route calls this BEFORE it mints a signed URL, so no audit row means no URL -- the feedback screenshot route''s order, which is the control. The payload is the export kind and the part number; there is no record content anywhere near it. private.closure_backup_owed() reads that part number. VOLATILE, so not GET-reachable over PostgREST. The (uuid) form was dropped, not overloaded.';

-- ---------------------------------------------------------------------------
-- 2. Q229 HOLDS THE PURGE UNTIL EVERY PART IS DOWNLOADED
-- ---------------------------------------------------------------------------
create or replace function private.closure_backup_owed(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organisations o
      join lateral (
        select j.id, j.status, j.requested_by, j.expires_at, j.part_count
          from public.export_jobs j
         where j.organisation_id = o.id and j.closure_backup
         order by j.requested_at desc
         limit 1) b on true
     where o.id = p_organisation_id
       and o.lifecycle_state = 'deleted'
       and o.retention_expires_at is not null
       and o.retention_expires_at > pg_catalog.now() - private.closure_backup_hold()
       and b.status = 'succeeded'
       and b.expires_at is not null
       and b.expires_at > pg_catalog.now()
       -- Q228: OWED WHILE ANY PART 1..greatest(part_count, 1) HAS NO DOWNLOAD
       -- ROW BY THE REQUESTER. A row with no (or a non-numeric) `part` is
       -- part 1 -- every download audited before 20261101001000.
       and exists (
         select 1 from pg_catalog.generate_series(1, greatest(b.part_count, 1)) n
          where not exists (
            select 1 from public.audit_events a
             where a.organisation_id = o.id
               and a.action = 'export_job.downloaded'
               and a.target_type = 'export_job'
               and a.target_id = b.id
               and a.actor_user_id = b.requested_by
               and (case when (a.after ->> 'part') ~ '^[0-9]{1,9}$'
                         then (a.after ->> 'part')::integer else 1 end) = n)));
$$;

comment on function private.closure_backup_owed(uuid) is
  'Q229 (Phase 8 final review A, I2; controller 2026-10-05, pending founder): TRUE while a workspace the superuser deleted through delete_closed_workspace() still owes its closing Owner the closure backup -- lifecycle_state deleted, its LATEST closure_backup job succeeded and unexpired, the decision (retention_expires_at, which the decision dates to now) less than private.closure_backup_hold() ago, and (since 20261101001000, Q228, the Q238 default: the hold waits for the WHOLE backup) at least one of its parts 1..greatest(part_count, 1) without an export_job.downloaded audit row for that job, BY ITS REQUESTER, naming that part. A download row with no `part` key -- every one written before Q228 -- counts as part 1, so a single-archive backup is released by one download exactly as before. A colleague''s download releases nothing. private.sweep_expired_workspaces() skips such a workspace in BOTH loops (in the WHERE, so a held workspace never takes a slot of the run''s limit) and reports it as organisations.held_for_backup. Bounded by construction: never past the hold, never for an owner_closed (undecided) workspace, never for a backup that has expired.';

revoke all on function private.closure_backup_owed(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE RETENTION MANIFEST NAMES EVERY PART -- AND NO KEPT ONE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_object_manifest(p_run_id uuid, p_limit integer DEFAULT 500)
 RETURNS TABLE(bucket text, object_key text, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      -- (a) A soft-deleted document whose FROZEN class has run out -- the
      --     class stamped when it was deleted, never recomputed here (fix
      --     round 2, I-N1).
      select 'documents'::text as bucket, d.storage_key as object_key,
             'document_expired'::text as reason, d.deleted_at as age
        from public.documents d
       where d.deleted_at is not null
         and d.bytes_purged_at is null
         and d.deleted_at < pg_catalog.now()
             - private.retention_period(d.retention_class)
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
      -- Q228 (20261101001000): a closure backup's parts 2+ expire with it.
      -- Part 1's key is the job's own storage_key, named just above.
      union all
      select 'exports'::text, p.storage_key, 'export_expired'::text, j.expires_at
        from public.export_job_parts p
        join public.export_jobs j on j.id = p.job_id
       where p.part_no >= 2
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
         -- Q228 (20261101001000, plan Spec correction 2): A PART OF A BACKUP
         -- THAT HAS NOT FAILED IS NOT AN ORPHAN -- queued, running or
         -- succeeded, its object is named by its part row. A failed job's
         -- parts stay orphans (the runner removes them; this is the backstop).
         and not exists (select 1 from public.export_job_parts p
                           join public.export_jobs j on j.id = p.job_id
                          where p.storage_key = s.name and s.bucket_id = 'exports'
                            and j.status <> 'failed')
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
  'WHAT THE RETENTION RUNNER DELETES FROM THE BUCKETS, derived in the database (Phase 8 Task 6) -- AND, SINCE 20261004002000 (review finding C2), NOTHING AT ALL FOR A RUN THAT WOULD REFUSE. It takes the run id: no `running` run, no keys. It re-asserts `replica`, the kill switch, private.assert_retention_roll() and private.assert_retention_clocks() in the same call that produces the keys, so no ordering of runner calls and no runner bug obtains an object key from a database that would refuse the run. (The runner used to delete objects BEFORE step 0 was ever asked; the reviewer measured a run recorded `failed` whose file was already gone.) The erasure runner''s rule, for the same reason: the keys come from here and never from TypeScript, so a bug in the runner cannot aim a delete at a prefix the database did not name. Six sources -- an expired document''s bytes (Q52; expired against the class FROZEN when it was deleted, documents.retention_class, never recomputed -- fix round 2, I-N1), every document of a workspace whose 60 days are up (because private.erase_organisation() refuses to run while one byte remains), an expired feedback row''s screenshot (Q120), an export archive past its own expires_at, the parts 2+ of an expired closure backup (Q228, 20261101001000), and ORPHANS in all three buckets: objects no row names, older than the storage_orphan grace period. A part of a closure backup is named by its export_job_parts row, so while its job is queued, running or succeeded it is NOT an orphan (Q228 plan Spec correction 2: otherwise parts 2+ of a kept backup would be deleted a day after they were written); a FAILED job''s parts are orphans, the backstop for the runner''s own removal. It lists only objects that EXIST, which is what makes the storage half idempotent with no bookkeeping column, and it returns them OLDEST FIRST under a ceiling, so a capped run leaves a remainder rather than skipping a slice. service_role only.';

revoke all on function public.retention_object_manifest(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.retention_object_manifest(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. THE CLOCK ROLL learns one FALSE CANDIDATE. The fixed-point derivation
--    (20261005003000) matches date columns by NAME, so the manifest naming
--    export_job_parts makes export_job_parts.created_at a candidate (the
--    manifest's `created_at` is storage.objects'). Measured: without this row
--    private.assert_retention_clocks() refuses with undeclared_retention_clock.
--    Rebuilt from the LATEST pg_get_functiondef (20261030003000:1553), one row
--    added; CREATE OR REPLACE keeps its comment and its EXECUTE revoke.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.retention_clock_columns()
 RETURNS TABLE(schema_name text, table_name text, column_name text, role text, guard text, note text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    ('public', 'audit_events', 'created_at', 'clock', null,
     'audit_total. No client role holds INSERT or UPDATE on the table; rows are written by definer functions and triggers.'),

    ('public', 'documents', 'deleted_at', 'clock',
     'trigger:private.guard_document_retention_columns',
     'operational / financial. THE COLUMN REVIEW FINDING C1 WAS ABOUT. A client holds UPDATE on it because soft-delete and restore are its own writes; the guard overwrites a null -> value transition with now() and refuses a re-date (20261004000000). Not in the INSERT grant.'),
    ('public', 'documents', 'retention_class', 'clock',
     'trigger:private.guard_document_retention_columns',
     'THE PERIOD HALF OF THE SAME CLOCK (fix round 2, I-N1 / Q186): which of operational / financial applies, frozen by the guard when deleted_at is set, cleared on restore, immutable otherwise for every writer. No client grant at all; derived onto this roll as the column the sweep hands to retention_period().'),
    ('public', 'documents', 'bytes_purged_at', 'clock', null,
     'The record that the sweep ran, and the term that takes a document OUT of every future sweep. No client grant at all since 20261004000000; the guard refuses it too if one is ever added.'),
    ('public', 'documents', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s. No client grant since 20261004000000 either.'),

    ('public', 'erasure_jobs', 'completed_at', 'clock', null,
     'erasure_job_failed. No client write path: the table''s outcome columns are server-only (20260930001000).'),
    ('public', 'erasure_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),
    ('public', 'export_jobs', 'completed_at', 'clock', null,
     'Written by the reaper, read by nothing as a cutoff; classified `clock` rather than excused because no client can write it and the stricter answer costs nothing.'),
    ('public', 'export_jobs', 'requested_at', 'clock', null,
     'Q229 (20261029002000): private.closure_backup_owed() reads it to pick a workspace''s LATEST closure backup, the one whose download releases the held purge -- an ordering, not a cutoff, classified `clock` rather than excused because no client can write it (the request is immutable under export_jobs_before_update(), and authenticated''s INSERT grant is column-level, without it) and the stricter answer costs nothing.'),
    ('public', 'export_jobs', 'expires_at', 'clock', null,
     'The export archive''s own expiry, which the manifest reads. No client write path.'),
    ('public', 'export_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),
    ('public', 'export_job_parts', 'created_at', 'not_a_clock', null,
     'Q228 (20261101001000): a FALSE CANDIDATE. public.retention_object_manifest() now names export_job_parts (a part of a non-failed job is not an orphan; an expired job''s parts 2+ are named), and the derivation matches a column by NAME -- the manifest''s `created_at` is storage.objects''. Nothing judges a part on its own created_at: a part expires with its job''s expires_at. No client role holds any write on the table, and the part guard stamps it with now() on insert.'),

    ('public', 'feedback', 'created_at', 'clock', null,
     'feedback. Outside the column-level INSERT grant (20260911000000); no client UPDATE at all.'),

    ('public', 'incident_alerts', 'resolved_at', 'clock',
     'trigger:private.incident_alert_resolution_guard',
     'incident_alert. A client (the aal2 operator) holds UPDATE on it, column-level; the guard forces it to now() whenever resolved_by is set and refuses a resolved_by that is not the caller (fix round 2 of Phase 8 Task 3, Q162).'),

    -- PHASE 9 TASK 3 (20261030003000). Neither table has ANY client write
    -- grant (20261030000000: authenticated holds SELECT only; anon and
    -- service_role hold nothing), so no client can move either clock.
    ('public', 'integration_connections', 'revoked_at', 'clock', null,
     'integration_connection_revoked. Written by two server paths only, each with now(): private.revoke_integration_row(), and the out-of-band branch of private.integration_connections_guard() (an account deleted outside the erasure nulls a live person-scoped row''s owner, and the guard revokes it in that write). A revoked row is then frozen whole by the same guard. No client INSERT or UPDATE grant on the table.'),
    ('public', 'integration_sync_runs', 'finished_at', 'clock', null,
     'integration_sync_run. Written only by public.record_integration_sync_run() (service_role, no person on the session), with now(). No client INSERT or UPDATE grant on the table.'),

    ('public', 'merge_candidates', 'deleted_at', 'not_a_clock', null,
     'A false candidate the fixed-point walk (m-N1) reaches through private.erase_account(): that function''s `deleted_at` is organisations'', read as a filter on which workspaces are live, never as a cutoff. No client role holds UPDATE on merge_candidates.deleted_at.'),
    ('public', 'notes', 'deleted_at', 'not_a_clock', null,
     'A false candidate reached the same way: erase_account() hard-deletes a private note by ownership, not by age. A client holds UPDATE on notes.deleted_at (soft-delete/restore are its own writes), which is harmless because nothing judges a note on it.'),

    ('public', 'organisations', 'deleted_at', 'clock',
     'trigger:private.organisation_lifecycle_guard',
     'workspace. The guard refuses any session write to it outside an audited lifecycle RPC, with the hint organisation_lifecycle_is_the_rpcs (m-N2) so the probe can tell it from organisations_update_manage_organisation''s WITH CHECK, which carries `deleted_at is null` and refuses the same write with the same SQLSTATE -- a second layer, not the named one.'),
    ('public', 'organisations', 'retention_expires_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace. RECOMPUTED on every write by the sync trigger from lifecycle_changed_at, and nulled whenever the workspace is live -- so a written value never survives the statement that wrote it.'),
    ('public', 'organisations', 'lifecycle_changed_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace -- THE REAL CLOCK, and one the derivation cannot reach: no retention function names it, the sync trigger computes retention_expires_at from it. Nulled on a live workspace; on a closed one it is writable only by a session the UPDATE policies admit, which is the audited lifecycle RPCs and nobody else.'),
    ('public', 'organisations', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s.'),

    ('public', 'rate_limit_counters', 'window_start', 'clock', null,
     'rate_limit_counter. No client role can write or read a counter (20260909020000).'),

    ('public', 'retention_settings', 'audit_ceiling_released_at', 'clock', null,
     'The start of an audit-purge ceiling release (Q184, founder 2026-09-30, 20261010000000), read by private.audit_ceiling_release_active() -- not a cutoff for any row, but it decides whether rail 3 applies, so it is classified as a clock rather than excused. No client role holds INSERT or UPDATE on retention_settings (RC4); written only by public.release_audit_purge_ceiling(), with now().'),
    ('public', 'retention_settings', 'audit_ceiling_release_expires_at', 'clock', null,
     'The end of that release: released_at + 72 hours, held by the CHECK retention_settings_audit_ceiling_release_shape and re-checked by the reader. Same writer, same absence of any client grant.'),

    ('storage', 'objects', 'created_at', 'clock',
     'no_permissive_policy,policy:documents_deny_client_insert,policy:documents_deny_client_update,policy:feedback_screenshots_deny_client_insert,policy:feedback_screenshots_deny_client_update,policy:exports_deny_client_insert,policy:exports_deny_client_update',
     'storage_orphan. Supabase grants client roles table-wide privileges on storage.objects and this product fences its three buckets with RESTRICTIVE deny-all policies; the six named here are the INSERT and UPDATE halves of that fence. THE LAYER THAT ACTUALLY REFUSES TODAY IS DEFAULT DENY -- no permissive policy admits a client role at all (m-N2) -- so `no_permissive_policy` is named first: adding one is a forgeable_retention_clock refusal, and the restrictive six are the layer behind it. The probe measures their composite.')
$function$;

-- ---------------------------------------------------------------------------
-- SELF-CHECKS
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.audit_export_download(uuid)') is not null then
    raise exception 'Q228 Task 3: the (uuid) audit_export_download overload survived';
  end if;
  if not has_function_privilege('authenticated', 'public.audit_export_download(uuid,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.audit_export_download(uuid,integer)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.audit_export_download(uuid,integer)', 'EXECUTE') then
    raise exception 'Q228 Task 3: audit_export_download EXECUTE is not authenticated-only';
  end if;
  if pg_catalog.strpos(
       (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.retention_object_manifest(uuid,integer)'::regprocedure),
       'export_job_parts') = 0 then
    raise exception 'Q228 Task 3: retention_object_manifest does not name export_job_parts';
  end if;
  -- No new date column reached: the clock roll must still be complete.
  perform private.assert_retention_clocks();
  perform private.assert_retention_roll();
end $$;

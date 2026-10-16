-- Q228 Task 3 mutant (fix round 1), from the LIVE pg_get_functiondef at 248 migrations.
-- guard:  public.retention_object_manifest(uuid, integer)
-- change: the expired-parts union is dropped: an expired backup's parts 2+ outlive it (M15)
-- caught by: rls_q228_closure_backup_parts.sql QM1
-- Applied after a fresh reset by run-mutation.sh and removed by the next reset. Never a migration.
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

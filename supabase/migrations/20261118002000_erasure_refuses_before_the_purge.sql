-- ===========================================================================
-- An account erasure refuses BEFORE any stored file is removed.
--
-- The runner (lib/erasure/runner.ts) removes the bytes this manifest names
-- first, then calls run_erasure_job(), whose private.erase_account() is where
-- the two account refusals lived: Q131 (assert_account_is_erasable) and the
-- unbuilt closure backup (step 2b, closure_backup_not_built). So an Owner who
-- closed a workspace and asked to be erased while its backup was still being
-- built lost their screenshots and export archives, and was then told
-- "Nothing was deleted" (audit 2026-11-18, finding 2).
--
-- The manifest now raises the same two refusals, with the same hints, before
-- it names a single object; erase_account() keeps both as the enforcement.
-- Rebuilt from 20261108006000 with only that block added.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.erasure_purge_manifest(p_job_id uuid)
 RETURNS TABLE(bucket text, object_key text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_job public.erasure_jobs%rowtype;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'erasure_purge_manifest: the purge manifest is read by the erasure runner, never from a person''s session'
      using errcode = '42501', hint = 'erasure_runner_is_server_only';
  end if;

  select * into v_job from public.erasure_jobs j where j.id = p_job_id;
  if not found then
    raise exception 'erasure_purge_manifest: no such job' using errcode = '22023', hint = 'unknown_job';
  end if;

  if v_job.kind = 'account' then
    -- The refusals erase_account() would raise, raised before any byte goes.
    perform private.assert_account_is_erasable(v_job.subject_user_id);
    if exists (select 1 from public.export_jobs j
                where j.requested_by = v_job.subject_user_id and j.closure_backup
                  and j.status in ('queued', 'running')) then
      raise exception 'erasure_purge_manifest: the backup of a workspace this account closed has not been built yet'
        using errcode = '55000', hint = 'closure_backup_not_built';
    end if;

    return query
      select 'feedback-screenshots'::text, 'feedback/' || f.id::text
        from public.feedback f
       where f.user_id = v_job.subject_user_id
         and f.screenshot_key is not null
      union all
      select 'exports'::text, e.storage_key
        from public.export_jobs e
       where e.requested_by = v_job.subject_user_id
         and e.storage_key is not null
         -- Q206: a closure backup is the WORKSPACE's archive, not the
         -- requester's; it is re-pointed at the tombstone, never purged here.
         and not e.closure_backup
      -- G37 (20261108005000): an ordinary export's parts 2..n (part 1 is the
      -- job's storage_key, above).
      union all
      select 'exports'::text, p.storage_key
        from public.export_job_parts p
        join public.export_jobs e on e.id = p.job_id
       where e.requested_by = v_job.subject_user_id
         and p.part_no >= 2
         and not e.closure_backup;
  else
    return query
      select 'documents'::text, d.storage_key
        from public.documents d
       where d.organisation_id = v_job.organisation_id;
  end if;
end;
$function$;

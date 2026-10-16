-- Q228 Task 3 mutant (fix round 1), from the LIVE pg_get_functiondef at 248 migrations.
-- guard:  private.closure_backup_owed(uuid)
-- change: the requester term (a.actor_user_id = b.requested_by) is dropped: a colleague's downloads release the hold (M13)
-- caught by: rls_q228_closure_backup_parts.sql QO5
-- Applied after a fresh reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.closure_backup_owed(p_organisation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
               and (case when (a.after ->> 'part') ~ '^[0-9]{1,9}$'
                         then (a.after ->> 'part')::integer else 1 end) = n)));
$function$;

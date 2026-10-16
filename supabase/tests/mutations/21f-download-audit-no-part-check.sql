-- Q228 Task 3 mutant (fix round 1), from the LIVE pg_get_functiondef at 248 migrations.
-- guard:  public.audit_export_download(uuid, integer)
-- change: the part-exists check is dropped: any part number above 1 is audited (M17)
-- caught by: rls_q228_closure_backup_parts.sql QD4a, QD4e (+QD7)
-- Applied after a fresh reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION public.audit_export_download(p_job_id uuid, p_part integer DEFAULT 1)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if p_part is null or p_part < 1 then
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
$function$;

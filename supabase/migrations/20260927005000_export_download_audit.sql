-- ===========================================================================
-- PHASE 8 TASK 4 -- EXPORT, PART 6: EVERY DOWNLOAD IS AUDITED.
--
-- The feedback screenshot route's RPC, for the same reason and with the same
-- shape (20260911000000): the ONE path that mints a signed URL calls this
-- first, and a failure here means no URL. An archive is the densest personal
-- data this product ever hands out -- every table of a workspace, or
-- everything the platform holds about a person -- so "who downloaded it, and
-- when" is exactly the kind of high-value action CLAUDE.md says to audit.
--
-- GUARDED ON THE CALLER'S OWN ROW, not on a permission: an export job belongs
-- to its requester and to nobody else (public.export_jobs' SELECT policy says
-- so), so the guard here is "is this job yours", asked with a SECURITY
-- INVOKER read of the same policy... except that a definer function does not
-- get the caller's policies, so the guard asks the membership question
-- directly: requested_by = auth.uid(). One rule, in one place, matching the
-- policy.
--
-- The audit row names the job and the workspace and NOTHING ELSE. There is no
-- content to leak here, which is worth saying because audit_events is
-- readable across tenants by the operator.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function public.audit_export_download(p_job_id uuid)
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

  perform private.log_audit_event(
    p_action          => 'export_job.downloaded',
    p_target_type     => 'export_job',
    p_organisation_id => v_job.organisation_id,
    p_target_id       => v_job.id,
    p_after           => pg_catalog.jsonb_build_object('kind', v_job.kind));
end;
$$;

comment on function public.audit_export_download(uuid) is
  'Records that the requester downloaded their own export archive, and refuses everything else -- a job that is not theirs (42501, hint not_your_export: the IDOR gate, asked here as well as by the SELECT policy so the audit path cannot be the weaker of the two), one with no archive (export_has_no_archive), and one whose read-time expiry has passed (export_archive_expired). The download route calls this BEFORE it mints a signed URL, so no audit row means no URL -- the feedback screenshot route''s order, which is the control. The payload is the export kind; there is no record content anywhere near it. VOLATILE, so not GET-reachable over PostgREST.';

revoke all on function public.audit_export_download(uuid) from public, anon, service_role;
grant execute on function public.audit_export_download(uuid) to authenticated;

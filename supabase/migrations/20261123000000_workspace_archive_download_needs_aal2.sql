-- ===========================================================================
-- A WORKSPACE ARCHIVE (closure backups included) IS READ ONLY AT aal2.
--
-- Every organisation role needs MFA, and a workspace export can only be
-- requested at aal2, so the archive is built from aal2 read rights. Reading it
-- back asked only `requested_by = auth.uid()`, which a password-only (aal1)
-- session satisfies. This puts the assurance level on the two last decision
-- points, failing closed (private.session_is_aal2() is false on a missing
-- claim):
--
--   * export_jobs_select_own: a workspace job is the requester's at aal2
--     only. export_job_parts_select_own needs no change: its EXISTS reads
--     export_jobs under the caller's RLS, so a part follows its job.
--   * audit_export_download(): the same term inside the definer's lookup, so
--     an aal1 caller gets the same not_your_export as a stranger and the
--     download route answers its ordinary 404. No audit row, no URL.
--
-- An ACCOUNT export stays readable at aal1 on purpose: it is the person's own
-- statutory copy, and an un-enrolled user must still be able to get it.
--
-- ADDITIVE. The function body is 20261101001000's with one WHERE term added;
-- signature, owner and grants are unchanged by `create or replace`.
-- ===========================================================================

drop policy "export_jobs_select_own" on public.export_jobs;

create policy "export_jobs_select_own"
  on public.export_jobs for select to authenticated
  using (
    requested_by = (select auth.uid())
    and (kind = 'account' or (select private.session_is_aal2()))
  );

comment on policy "export_jobs_select_own" on public.export_jobs is
  'The requester''s own jobs: an account job at any assurance level, a workspace job (closure backups included) only at aal2, because it was built from aal2 read rights and every organisation role needs MFA. Deliberately not "any Admin of that workspace": an archive is a snapshot taken under ONE person''s read rights at ONE moment, so a second Admin reading it would be reading rows resolved against somebody else''s record scope. They start their own job instead. export_job_parts_select_own reads this policy through its EXISTS, so a part follows its job.';

create or replace function public.audit_export_download(p_job_id uuid, p_part integer default 1)
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

  -- The SELECT policy's rule, restated because a definer skips RLS: a
  -- workspace archive is the requester's at aal2 only. An aal1 caller gets
  -- the stranger's answer, so the refusal says nothing about the job.
  select * into v_job from public.export_jobs j
   where j.id = p_job_id and j.requested_by = (select auth.uid())
     and (j.kind = 'account' or private.session_is_aal2());
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

  -- Asked only after the job is known to be the caller's, so the answer is
  -- never an oracle for somebody else's backup.
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

comment on function public.audit_export_download(uuid, integer) is
  'Records that the requester downloaded ONE PART of their own export archive, and refuses everything else -- a job that is not theirs, or a workspace job (closure backups included) asked for below aal2 (42501, hint not_your_export: the IDOR and assurance gate, asked here as well as by the SELECT policy so the audit path cannot be the weaker of the two, and asked BEFORE the part so it is never an oracle for another person''s backup), one with no archive (export_has_no_archive), one whose read-time expiry has passed (export_archive_expired), and a part that is null, below 1, or above 1 with no export_job_parts row (export_part_not_found, 22023). An account export passes at aal1: it is the person''s own statutory copy. Part 1 is the job''s own storage_key and needs no part row, so an ordinary or legacy export is part 1 of 1. The download route calls this BEFORE it mints a signed URL, so no audit row means no URL. The payload is the export kind and the part number; there is no record content anywhere near it. private.closure_backup_owed() reads that part number. VOLATILE, so not GET-reachable over PostgREST.';

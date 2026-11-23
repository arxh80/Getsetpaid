-- ===========================================================================
-- AN ACCOUNT EXPORT NEEDS aal2 TOO, FOR ANYONE WHO HAS A FACTOR.
--
-- 20261123000000 bound workspace archives to aal2 and left account exports at
-- aal1, because a person with no factor enrolled cannot reach aal2 and must
-- still get their own statutory copy. But someone who HAS enrolled a factor
-- and signs in with the password alone is exactly the stolen-password case:
-- their account export holds their memberships, notes and impersonation
-- decisions. So the rule is now aal2, or an account export for a caller with
-- no verified factor (founder 2026-11-23).
--
-- private.caller_has_verified_factor() is a definer because authenticated
-- cannot read auth.mfa_factors. It answers only for auth.uid().
-- ===========================================================================

create function private.caller_has_verified_factor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from auth.mfa_factors f
                  where f.user_id = (select auth.uid()) and f.status = 'verified');
$$;

comment on function private.caller_has_verified_factor() is
  'True when the calling user has at least one verified MFA factor, so they can reach aal2. False with no session. Answers only for auth.uid(); reads auth.mfa_factors, which authenticated cannot.';

revoke all on function private.caller_has_verified_factor() from public, anon, authenticated, service_role;
grant execute on function private.caller_has_verified_factor() to authenticated;

drop policy "export_jobs_select_own" on public.export_jobs;

create policy "export_jobs_select_own"
  on public.export_jobs for select to authenticated
  using (
    requested_by = (select auth.uid())
    and ((select private.session_is_aal2())
         or (kind = 'account' and not (select private.caller_has_verified_factor())))
  );

comment on policy "export_jobs_select_own" on public.export_jobs is
  'The requester''s own jobs, at aal2. One exception: an account job is readable at aal1 by a person with no verified factor, who cannot reach aal2 and must still get their statutory copy. Deliberately not "any Admin of that workspace": an archive is a snapshot taken under ONE person''s read rights at ONE moment. export_job_parts_select_own reads this policy through its EXISTS, so a part follows its job.';

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

  -- The SELECT policy's rule, restated because a definer skips RLS: aal2,
  -- or an account export for someone with no factor to reach aal2 with. An
  -- aal1 caller gets the stranger's answer, so the refusal says nothing.
  select * into v_job from public.export_jobs j
   where j.id = p_job_id and j.requested_by = (select auth.uid())
     and (private.session_is_aal2()
          or (j.kind = 'account' and not private.caller_has_verified_factor()));
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
  'Records that the requester downloaded ONE PART of their own export archive, and refuses everything else -- a job that is not theirs, or a job asked for below aal2 (an account job of someone with no verified factor excepted) (42501, hint not_your_export: the IDOR and assurance gate, asked here as well as by the SELECT policy so the audit path cannot be the weaker of the two, and asked BEFORE the part so it is never an oracle for another person''s backup), one with no archive (export_has_no_archive), one whose read-time expiry has passed (export_archive_expired), and a part that is null, below 1, or above 1 with no export_job_parts row (export_part_not_found, 22023). An account export passes at aal1 only for a person with no verified factor, who has no way to reach aal2 and must still get their statutory copy; anyone who has enrolled a factor needs aal2 for it too. Part 1 is the job''s own storage_key and needs no part row, so an ordinary or legacy export is part 1 of 1. The download route calls this BEFORE it mints a signed URL, so no audit row means no URL. The payload is the export kind and the part number; there is no record content anywhere near it. private.closure_backup_owed() reads that part number. VOLATILE, so not GET-reachable over PostgREST.';

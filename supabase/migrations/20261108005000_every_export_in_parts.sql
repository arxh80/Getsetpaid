-- ===========================================================================
-- Phase 10 Task 24 (G37, Q263): any export, any size -- every export is
-- built in parts.
--
-- An ordinary export was one zip under the 40 MiB ceiling and FAILED past it:
-- two 25 MiB documents failed every export of their workspace, and a heavy
-- feedback submitter's account export (screenshots up to 5 MiB each) could
-- fail for ever. Q228 built parts for closure backups only (20261101000000).
-- Q263 (default) extends them to every export, with one difference that
-- answers Q237's consistency concern: an ORDINARY export builds all of its
-- parts inside one runner claim, back to back, so it never sits `queued`
-- between parts and is no less consistent than the single archive it
-- replaces. Closure backups keep one part per claim and are unchanged.
--
-- Two closure-only terms go:
--   * export_jobs_part_count_shape no longer requires part_count = 0 for an
--     ordinary job. resume_cursor stays closure-only: an ordinary job never
--     resumes, so it never has one.
--   * private.export_job_parts_guard() no longer refuses a non-closure job's
--     part. Its order check counts the parts already stored (under the
--     parent's row lock) instead of reading part_count, so a job that stays
--     `running` while it adds parts is ordered the same way. For a closure
--     backup the two are equal: the re-queue writes part_count = the stored
--     parts (private.export_jobs_before_update(), export_part_count_mismatch).
-- Everything else is unchanged: parts are written only by a server session,
-- only while the job runs, in order; a part is deleted only once its job has
-- failed or with its job; a success stamps part_count = the stored parts.
-- ===========================================================================

alter table public.export_jobs drop constraint export_jobs_part_count_shape;
alter table public.export_jobs
  add constraint export_jobs_part_count_shape check (
    part_count >= 0
    and (resume_cursor is null
         or (closure_backup and status in ('queued', 'running')))
  );

comment on column public.export_jobs.part_count is
  'How many parts of the export are stored -- always equal to the job''s public.export_job_parts rows when a closure backup is re-queued or any job is stamped succeeded (private.export_jobs_before_update(), hint export_part_count_mismatch). 0 means one archive at storage_key with no part rows: a job built before 20261108005000, or a closure backup planted before parts existed. Written only by service_role (column grant), from a session with no person on it. Since 20261108005000 (Q263) every export is built in parts; an ordinary one in a single runner claim.';

create or replace function private.export_job_parts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_server_session boolean;
  v_status         text;
  v_stored         integer;
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
    select j.status into v_status
      from public.export_jobs j where j.id = new.job_id
       for update;
    if v_status is distinct from 'running' then
      raise exception 'export_job_parts: a part is stored only while its job is running'
        using errcode = '22023', hint = 'export_part_needs_a_running_job';
    end if;
    -- In order: the next part is one past the parts already stored (Q263:
    -- counted, because an ordinary export adds its parts without leaving
    -- `running`, so part_count is only written when it finishes).
    select pg_catalog.count(*)::integer into v_stored
      from public.export_job_parts p where p.job_id = new.job_id;
    if new.part_no <> v_stored + 1 then
      raise exception 'export_job_parts: parts are stored in order, and the next one is %', v_stored + 1
        using errcode = '22023', hint = 'export_part_out_of_order';
    end if;
    new.created_at := pg_catalog.now();
    return new;
  end if;

  -- DELETE of a part whose job still exists: only once the job has FAILED
  -- (the runner removing a failed build's parts). A queued, running or
  -- succeeded job's parts are the export, or are becoming it.
  if v_status <> 'failed' then
    raise exception 'export_job_parts: a part of a backup that is kept, or still being built, is not deleted'
      using errcode = '42501', hint = 'export_part_of_a_kept_backup';
  end if;
  return old;
end;
$function$;

comment on function private.export_job_parts_guard() is
  'BEFORE INSERT OR DELETE on public.export_job_parts. Admits (1) the cascade from the parent job''s own delete (no parent visible); otherwise refuses any session with a person on it (42501 export_part_is_server_only). INSERT: locks the parent; refuses a job not running (22023 export_part_needs_a_running_job) and any part but one past the parts already stored (22023 export_part_out_of_order); stamps created_at. Any export kind since 20261108005000 (Q263); before it, closure backups only. DELETE: only of a FAILED job''s part (else 42501 export_part_of_a_kept_backup). SECURITY DEFINER so it reads the parent whatever the caller''s RLS; EXECUTE revoked from every API role.';

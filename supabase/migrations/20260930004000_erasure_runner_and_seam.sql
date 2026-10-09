-- ===========================================================================
-- PHASE 8 TASK 5 -- ERASURE, PART 5: THE RUNNER'S ENTRY POINTS, AND THE DATA
-- SUBJECT REGISTER'S ERASURE SEAM WAKING UP.
--
-- Four RPCs, all `service_role` only and all refusing any session with a
-- person on it, plus the one-line change that makes the Task 3 constraint
-- real for `erasure` the way 20260927003000 made it real for `export`.
--
-- ===========================================================================
-- WHY THE ERASURE ITSELF IS AN RPC AND NOT FOUR STATEMENTS IN TYPESCRIPT
-- ===========================================================================
-- All-or-nothing. A PostgREST call is one transaction; four are four, and a
-- runner that erased the notes, then failed to re-point the audit log, would
-- have produced exactly the partial erasure the brief forbids. So
-- `public.run_erasure_job()` does the work AND records the success, and a
-- raise takes both back together. The runner's only other write is the
-- FAILURE, which is deliberately a separate transaction because it has to
-- survive the rollback it is describing.
--
-- ===========================================================================
-- THE SEAM, AND THE ORDER IT HAS TO BE WRITTEN IN
-- ===========================================================================
-- The request ids are captured BEFORE the erasure and the seam is written
-- AFTER it. Not a detail:
--   * writing it first would make the seam a statement about the future,
--     which is review finding I5b in its original form;
--   * finding the requests afterwards is impossible by user id, because the
--     erasure has just re-pointed them at the tombstone along with everybody
--     else's -- there would be nothing to tell them apart.
-- Capturing the ids first and writing by id afterwards is the only order that
-- is both honest and possible.
--
-- ADDITIVE. `private.dsr_fulfilment_job_ready()` is re-issued from its LATEST
-- definition (20260927003000 § 3).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. CLAIM. The export runner's shape, verbatim in structure.
-- ---------------------------------------------------------------------------

create or replace function public.claim_erasure_job()
returns table (id uuid, kind text, subject_user_id uuid,
               organisation_id uuid, requested_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'claim_erasure_job: jobs are claimed by the erasure runner, never from a person''s session'
      using errcode = '42501', hint = 'erasure_runner_is_server_only';
  end if;

  select j.id into v_id
    from public.erasure_jobs j
   where j.status = 'queued'
   order by j.requested_at, j.seq
   for update skip locked
   limit 1;

  if v_id is null then
    return;
  end if;

  update public.erasure_jobs j set status = 'running' where j.id = v_id;

  return query
    select j.id, j.kind, j.subject_user_id, j.organisation_id, j.requested_at
      from public.erasure_jobs j where j.id = v_id;
end;
$$;

comment on function public.claim_erasure_job() is
  'The erasure runner takes the oldest queued job, `for update skip locked` so two runners never take the same one, and moves it to `running` -- which is also the interlock the register anonymisation and the note guard require, so nothing can anonymise a register row without a claimed job behind it. Refuses any session with a person on it (42501, hint erasure_runner_is_server_only).';


-- ---------------------------------------------------------------------------
-- 2. WHAT BYTES MUST GO FIRST.
--
--    Storage lives outside Postgres, so the objects are deleted by the runner
--    through the Storage API and the erasure REFUSES while any of them is
--    left. This is how the runner knows which ones -- derived from the job,
--    never from anything a caller passes.
-- ---------------------------------------------------------------------------

create or replace function public.erasure_purge_manifest(p_job_id uuid)
returns table (bucket text, object_key text)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    return query
      select 'feedback-screenshots'::text, 'feedback/' || f.id::text
        from public.feedback f
       where f.user_id = v_job.subject_user_id
         and f.screenshot_key is not null
      union all
      select 'exports'::text, e.storage_key
        from public.export_jobs e
       where e.requested_by = v_job.subject_user_id
         and e.storage_key is not null;
  else
    return query
      select 'documents'::text, d.storage_key
        from public.documents d
       where d.organisation_id = v_job.organisation_id;
  end if;
end;
$$;

comment on function public.erasure_purge_manifest(uuid) is
  'The stored objects an erasure job must remove from Storage BEFORE the rows go: an account''s feedback screenshots and export archives, or a workspace''s documents -- INCLUDING soft-deleted ones, because Q52 is that soft-deleting a document keeps its bytes. Derived from the job row, never from anything a caller passes, so a compromised runner cannot aim it at another subject. private.erase_account() and private.erase_organisation() both REFUSE while any object on this list is still in its bucket, which is what stops the row delete from being the thing that makes an object unreachable-but-present.';


-- ---------------------------------------------------------------------------
-- 3. RUN IT. One transaction: the erasure, the seam, and the success.
-- ---------------------------------------------------------------------------

create or replace function public.run_erasure_job(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job      public.erasure_jobs%rowtype;
  v_counts   jsonb;
  v_requests uuid[];
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'run_erasure_job: an erasure is run by the erasure runner, never from a person''s session'
      using errcode = '42501', hint = 'erasure_runner_is_server_only';
  end if;

  select * into v_job from public.erasure_jobs j where j.id = p_job_id;
  if not found then
    raise exception 'run_erasure_job: no such job' using errcode = '22023', hint = 'unknown_job';
  end if;
  if v_job.status <> 'running' then
    raise exception 'run_erasure_job: job is %, not running', v_job.status
      using errcode = '22023', hint = 'job_is_not_running';
  end if;

  if v_job.kind = 'account' then
    -- THE IDS FIRST. See the header: after the erasure these rows point at
    -- the tombstone along with every other erased person's, so there is
    -- nothing left to find them by.
    select pg_catalog.array_agg(d.id) into v_requests
      from public.data_subject_requests d
     where d.user_id = v_job.subject_user_id
       and d.subject_scope = 'account'
       and d.right_type = 'erasure'
       and d.status in ('open', 'in_progress')
       and d.requested_at <= pg_catalog.now();

    v_counts := private.erase_account(v_job.subject_user_id, p_job_id);

    -- AND THE SEAM AFTER, so it records something that has happened.
    if v_requests is not null then
      update public.data_subject_requests d
         set fulfilment_kind      = 'erasure',
             fulfilment_reference = p_job_id
       where d.id = any (v_requests);
    end if;
  else
    v_counts := private.erase_organisation(v_job.organisation_id, p_job_id, true);
  end if;

  update public.erasure_jobs j
     set status = 'succeeded', summary = v_counts
   where j.id = p_job_id;

  return v_counts;
end;
$$;

comment on function public.run_erasure_job(uuid) is
  'Runs a claimed erasure job and records its success IN THE SAME TRANSACTION, which is what makes the erasure all-or-nothing: a raise anywhere inside takes the work and the outcome back together, and there is no state in which some of an account is gone. For an `account` job it captures the subject''s OPEN account-scope erasure requests first, erases, and then records the fulfilment seam on those ids -- that order because writing the seam first would be a claim about the future, and finding the requests afterwards is impossible once they point at the shared tombstone. The FAILURE is deliberately not written here: public.fail_erasure_job() is a separate transaction because it has to survive the rollback it describes.';


-- ---------------------------------------------------------------------------
-- 4. RECORD A FAILURE. Its own transaction, deliberately.
-- ---------------------------------------------------------------------------

create or replace function public.fail_erasure_job(p_job_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'fail_erasure_job: a job''s outcome is written by the erasure runner, never from a person''s session'
      using errcode = '42501', hint = 'erasure_runner_is_server_only';
  end if;

  update public.erasure_jobs j
     set status = 'failed',
         failure_reason = pg_catalog.left(
           coalesce(nullif(pg_catalog.btrim(p_reason), ''),
                    'The erasure could not be completed and nothing was changed.'), 2000)
   where j.id = p_job_id and j.status in ('queued', 'running');
end;
$$;

comment on function public.fail_erasure_job(uuid, text) is
  'Records that an erasure failed and that NOTHING was changed -- the only outcome there is, because private.erase_account() and private.erase_organisation() are single transactions. Called from outside the rolled-back transaction, which is why it is its own RPC rather than an exception handler inside run_erasure_job(). The reason is the runner''s own sentence, bounded at 2000 characters, and never a row value.';


revoke all on function public.claim_erasure_job()             from public, anon, authenticated;
revoke all on function public.erasure_purge_manifest(uuid)    from public, anon, authenticated;
revoke all on function public.run_erasure_job(uuid)           from public, anon, authenticated;
revoke all on function public.fail_erasure_job(uuid, text)    from public, anon, authenticated;
grant execute on function public.claim_erasure_job()          to service_role;
grant execute on function public.erasure_purge_manifest(uuid) to service_role;
grant execute on function public.run_erasure_job(uuid)        to service_role;
grant execute on function public.fail_erasure_job(uuid, text) to service_role;


-- ---------------------------------------------------------------------------
-- 5. THE SEAM'S SERVICE-ROLE GRANT, widened by exactly nothing.
--
--    20260927003000 § 1 already granted `update (fulfilment_kind,
--    fulfilment_reference)`. The erasure runner writes the same two columns.
--    Nothing is added here; this comment exists so that a reader looking for
--    "where did the erasure runner get its grant" finds the answer instead of
--    assuming one is missing.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 6. THE ERASURE HALF WAKES. Re-issued from its LATEST definition
--    (20260927003000 § 3); only the `erasure` line changes.
-- ---------------------------------------------------------------------------

create or replace function private.dsr_fulfilment_job_ready(p_kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_kind
           when 'export'  then true   -- Phase 8 Task 4 shipped: public.export_jobs
           when 'erasure' then true   -- Phase 8 Task 5 shipped: public.erasure_jobs
           else false
         end
$$;

comment on function private.dsr_fulfilment_job_ready(text) is
  'Has the job that fulfils this kind of request shipped? BOTH HALVES ARE NOW AWAKE: `export` (access, portability) since 20260927003000, and `erasure` since 20260930004000. An account-scope request of either kind can no longer be marked fulfilled by hand -- a job for that requester must have completed after the request was made and recorded itself on the row (private.data_subject_requests_before_update() § 6, 22023, hint fulfilment_not_recorded). The function survives as a two-line case rather than being collapsed to `true` so that a NINTH right type added later starts dormant, which is the direction 20260925000000 split it for (review finding I5a). rls_phase8_data_subject_requests.sql § DF flips each line alone inside a rolled-back transaction, and rls_phase8_erasure.sql § ES carries the positive control: a legitimate fulfilment IS admitted once the job has run.';

revoke all on function private.dsr_fulfilment_job_ready(text) from public, anon, authenticated, service_role;

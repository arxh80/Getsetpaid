-- ===========================================================================
-- PHASE 8 TASK 4, FIX ROUND 1 -- THE JOB-PROGRESS GUARD FAILS CLOSED.
--
-- Task 4 review, finding M1. The brief for this task was in part a whole
-- section about why a CLOSED LIST of client roles is the wrong shape for a
-- server-only gate: "A role added later -- a third client role, a PostgREST
-- persona -- is admitted BY OMISSION... Invert it: refuse unless the session
-- role is postgres/service_role."
--
-- 20260927003000 inverted it for private.data_subject_requests_before_update().
-- public.export_read_page(), public.claim_export_job(), public.export_plan()
-- and public.export_limits_for_runner() were all WRITTEN inverted. And
-- private.export_jobs_before_update() -- created one migration EARLIER, in
-- 20260927001000 -- shipped with the closed list:
--
--   v_client_session := v_uid is not null or v_session_role in ('authenticated','anon');
--   if v_client_session then raise ...
--
-- So four of the five new server-only gates in this task fail closed and the
-- fifth failed open, in the same series, with no comment acknowledging the
-- difference. The exposure was small -- a new client role would also need an
-- explicit column UPDATE grant on public.export_jobs, which nothing gives it
-- -- but it is the same defect the task was sent to fix.
--
-- THE FUNCTION IS REBUILT FROM ITS LATEST DEFINITION (20260927001000 § 5)
-- with exactly that one expression changed. Everything else -- the immutable
-- request, the finished-job rule, the transition table and the three stamps
-- -- is verbatim.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function private.export_jobs_before_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid            uuid := (select auth.uid());
  v_session_role   text := coalesce(pg_catalog.current_setting('role', true), '');
  v_server_session boolean;
  v_days           integer;
begin
  -- AN OPEN LIST OF SERVER ROLES, not a closed list of client ones: a role
  -- this schema has never heard of arrives REFUSED rather than admitted by
  -- omission. `none` and the empty string are what current_setting('role')
  -- answers for a plain superuser session that has not `set role`. Neither
  -- leg is bypassable by SECURITY DEFINER: it changes the current USER and
  -- touches neither the JWT claims nor the `role` SETTING, so both still
  -- describe whoever issued the statement.
  v_server_session := v_uid is null
                      and v_session_role in ('postgres', 'service_role', 'none', '');

  if not v_server_session then
    raise exception 'export_jobs: a job''s progress is written by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_outcome_is_server_only';
  end if;

  -- THE REQUEST ITSELF IS IMMUTABLE. Who asked, which kind, which workspace
  -- and when: the archive's provenance, and nothing may rewrite it.
  if new.id is distinct from old.id
     or new.seq is distinct from old.seq
     or new.kind is distinct from old.kind
     or new.organisation_id is distinct from old.organisation_id
     or new.requested_by is distinct from old.requested_by
     or new.requested_aal is distinct from old.requested_aal
     or new.requested_at is distinct from old.requested_at then
    raise exception 'export_jobs: the request itself is immutable -- only its progress and its outcome may change'
      using errcode = '42501', hint = 'export_request_is_immutable';
  end if;

  -- A CLOSED JOB IS IMMUTABLE. A succeeded archive cannot be re-pointed at
  -- another key, and a failure cannot be quietly turned into a success.
  if old.status in ('succeeded', 'failed') then
    raise exception 'export_jobs: a finished job is not rewritten'
      using errcode = '22023', hint = 'export_job_is_finished';
  end if;

  if not (   (old.status = 'queued'  and new.status in ('running', 'failed'))
          or (old.status = 'running' and new.status in ('succeeded', 'failed'))) then
    raise exception 'export_jobs: a job cannot go from % to %', old.status, new.status
      using errcode = '22023', hint = 'illegal_export_transition';
  end if;

  -- THE STAMPS ARE THE DATABASE'S, so a finished job's times say when it
  -- finished rather than what a runner claimed.
  if new.status = 'running' then
    new.started_at := pg_catalog.now();
  else
    new.started_at := old.started_at;
  end if;

  if new.status in ('succeeded', 'failed') then
    new.completed_at := pg_catalog.now();
  end if;

  if new.status = 'succeeded' then
    select l.archive_days into v_days from private.export_limits() l;
    new.expires_at := pg_catalog.now() + pg_catalog.make_interval(days => v_days);
    new.failure_reason := null;
  else
    new.expires_at := null;
  end if;

  return new;
end;
$$;

comment on function private.export_jobs_before_update() is
  'BEFORE UPDATE on public.export_jobs, for EVERY writer. Admits the write ONLY from a server session -- auth.uid() null AND the session role setting one of postgres/service_role/none/"" -- and refuses everything else (42501, hint export_outcome_is_server_only, its own hint so a test can tell it from a missing grant). Reissued in 20260928000000 with that leg INVERTED from the closed list of client roles it shipped with in 20260927001000: a client role added by a later phase now arrives refused by omission rather than admitted by it, which is the shape 20260927003000 gave the data subject register''s fulfilment seam and the shape the other four server-only gates in this feature were written with. Refuses a change to the request itself (export_request_is_immutable), a write to a finished job (export_job_is_finished) and a transition that is not queued->running->succeeded/failed (illegal_export_transition). Stamps started_at, completed_at and expires_at (completed_at + private.export_limits().archive_days) from the database clock.';

revoke all on function private.export_jobs_before_update() from public, anon, authenticated, service_role;

-- ===========================================================================
-- PHASE 8 TASK 4 -- EXPORT, PART 4: THE DATA SUBJECT REGISTER'S EXPORT SEAM
-- WAKES UP, AND THE GUARD IN FRONT OF IT STOPS BEING A CLOSED LIST.
--
-- Three changes, in the order they depend on each other. The first two were
-- decided in Task 3 fix round 2 (re-review finding M-R1) and DELIBERATELY NOT
-- SHIPPED THEN: a grant with no consumer is a standing write path on the one
-- table that round spent itself making unwritable, and only the task that
-- writes the seam knows which columns it actually moves.
--
-- ===========================================================================
-- 1. THE GRANT, AND WHY IT IS TWO COLUMNS
-- ===========================================================================
-- Measured at 150 migrations, before this file: `service_role` held NO grant
-- of any kind on public.data_subject_requests. So the comment on
-- fulfilment_kind -- "written ONLY from a session with no person on it:
-- postgres, or service_role through a definer function" -- described a path
-- that did not exist, and § DF9h passed only because the psql suite opened
-- the grant inside its own rolled-back transaction. A probe that is answered
-- by a MISSING PRIVILEGE rather than by the guard is the false-green shape
-- the whole Phase 7 lesson is about.
--
-- The export runner writes exactly two columns: `fulfilment_kind` (always
-- 'export') and `fulfilment_reference` (the export job's id).
-- `fulfilment_recorded_at` is stamped by the trigger and is deliberately NOT
-- granted -- a BEFORE trigger may assign a column the updating role holds no
-- privilege on, so the clock stays entirely the database's. The filter
-- columns are granted SELECT because Postgres requires SELECT on every
-- column an UPDATE's WHERE clause reads.
--
-- The precedent for the shape is public.incident_alerts, whose whole grant to
-- service_role is `update (notified_at)` and later `update
-- (account_notified_at)` -- never the table (20260909070000, 20260916001000).
--
-- WHY NOT A DEFINER RPC INSTEAD, which would need no grant at all: because
-- then § DF's probe would STILL be answered by a missing privilege and the
-- suite would still be unable to tell a working guard from an absent one.
-- The grant exists so that the positive control is a control.
--
-- ===========================================================================
-- 2. THE GUARD'S CLIENT-ROLE LEG WAS A CLOSED LIST; IT IS NOW AN OPEN ONE
-- ===========================================================================
-- private.data_subject_requests_before_update() refused a seam write from a
-- session whose `role` setting was `'authenticated'` or `'anon'`. Named
-- roles. A third client role added later -- a PostgREST persona, a read-only
-- reporting login, whatever a future phase needs -- would have been admitted
-- BY OMISSION, and with the grant above in place that omission becomes the
-- only thing between a new role and the seam.
--
-- INVERTED: a seam write is admitted only from `postgres`, `service_role` or
-- an unset role (a direct superuser session: pg_cron, a migration, a DBA),
-- AND only with no person's claims on the session. Anything else is refused.
-- A role added tomorrow arrives REFUSED, which is the direction a guard
-- should fail in. The refusal keeps its own hint
-- (`fulfilment_seam_is_server_only`) so a test can still tell it from a
-- missing privilege's 42501.
--
-- Rebuilt from its LATEST definition (20260925000000 § 5 -- no later
-- migration replaced it). The only change is those two lines and the comment.
--
-- ===========================================================================
-- 3. THE EXPORT HALF OF THE CONSTRAINT WAKES
-- ===========================================================================
-- private.dsr_fulfilment_job_ready('export') answers TRUE from here on: an
-- account-scope `access` or `portability` request can no longer be marked
-- fulfilled by hand. An export job for THAT requester must have completed
-- AFTER the request was made, and have recorded itself on the row. The
-- erasure half stays false for Task 5 -- that is exactly why Task 3 fix round
-- 1 split one boolean into one line per job (review finding I5a).
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE GRANT.
-- ---------------------------------------------------------------------------

grant select (id, user_id, subject_scope, right_type, status, requested_at,
              fulfilment_kind, fulfilment_reference, fulfilment_recorded_at)
  on public.data_subject_requests to service_role;

grant update (fulfilment_kind, fulfilment_reference)
  on public.data_subject_requests to service_role;

comment on column public.data_subject_requests.fulfilment_reference is
  'What the job that fulfilled this request produced -- for `export`, the public.export_jobs id whose archive answers it. Written by the export runner as `service_role`, through the two-column UPDATE grant added in 20260927003000 and nothing wider; fulfilment_recorded_at is stamped by the trigger and is deliberately outside that grant, so the clock stays the database''s. private.data_subject_requests_before_update() refuses the write from any session with a person on it, on a closed request, and for a kind the request''s right does not name.';


-- ---------------------------------------------------------------------------
-- 2. THE GUARD, REBUILT FROM ITS LATEST DEFINITION (20260925000000 § 5).
--    The ONLY change is the session test: a closed list of client roles
--    becomes an open list of SERVER roles.
-- ---------------------------------------------------------------------------

create or replace function private.data_subject_requests_before_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_is_owner   boolean := v_uid is not null and old.user_id = v_uid;
  v_operator   boolean := (select private.has_platform_permission('oversee_data_subject_requests'));
  -- THE SESSION, NOT THE DEFINER. SECURITY DEFINER switches the current USER
  -- to this function's owner; it does not touch the JWT claims and it does
  -- not touch the `role` SETTING (measured), so both still describe whoever
  -- issued the statement that fired this trigger.
  v_session_role   text := coalesce(pg_catalog.current_setting('role', true), 'none');
  -- INVERTED IN 20260927003000. This used to name the CLIENT roles
  -- ('authenticated', 'anon'), so a third client role added later would have
  -- been admitted by omission. It now names the SERVER ones, and everything
  -- else -- including a role that does not exist yet -- is refused.
  v_server_session boolean;
  v_required   text;
  v_name       text;
  v_seam_moved boolean;
  v_rest_moved boolean;
begin
  v_server_session := v_uid is null
                      and v_session_role in ('postgres', 'service_role', 'none', '');

  v_seam_moved :=
       new.fulfilment_kind        is distinct from old.fulfilment_kind
    or new.fulfilment_reference   is distinct from old.fulfilment_reference
    or new.fulfilment_recorded_at is distinct from old.fulfilment_recorded_at;

  -- Every mutable column that is neither the status, the seam nor the routed
  -- workspace's id: what a seam-only write and the foreign key's own nulling
  -- must each leave exactly as it was.
  v_rest_moved :=
       new.fulfilled_at     is distinct from old.fulfilled_at
    or new.rejected_at      is distinct from old.rejected_at
    or new.withdrawn_at     is distinct from old.withdrawn_at
    or new.rejection_reason is distinct from old.rejection_reason
    or new.routed_at        is distinct from old.routed_at
    or new.routed_to_organisation_name is distinct from old.routed_to_organisation_name;

  -- (0) THE SEAM IS NOT A CLIENT'S TO WRITE. fulfilment_* says "a job ran",
  -- and no session with a person on it may say that -- not through a grant,
  -- not through a definer RPC that one day forwards the column, not as the
  -- operator. Its own hint, so a test can tell this refusal from a missing
  -- privilege's 42501.
  if v_seam_moved and not v_server_session then
    raise exception 'data_subject_requests: the fulfilment record is written by the server-side job, never from a person''s session'
      using errcode = '42501', hint = 'fulfilment_seam_is_server_only';
  end if;

  -- (1) WHAT NEVER MOVES. The request itself is evidence: who asked, which
  -- right, in what words, when, and by when it is due.
  if new.id is distinct from old.id
     or new.seq is distinct from old.seq
     or new.user_id is distinct from old.user_id
     or new.user_email is distinct from old.user_email
     or new.right_type is distinct from old.right_type
     or new.subject_scope is distinct from old.subject_scope
     or new.detail is distinct from old.detail
     or new.requested_at is distinct from old.requested_at then
    raise exception 'data_subject_requests: the request itself is immutable -- only its state and its outcome may change'
      using errcode = '42501';
  end if;

  if new.status is not distinct from old.status then
    -- THREE writes change no state, and each is admitted ONLY in its own exact
    -- shape. None of them returns before the row's invariants: that was I5(d).

    -- (1a) THE FOREIGN KEY'S OWN NULLING (I4). ON DELETE SET NULL from
    -- public.organisations is an UPDATE of this one column. Admitted only when
    -- nothing else moves AND the workspace it named no longer exists -- the
    -- consent ledger's rule (20260923002000): prove the parent is gone rather
    -- than trust that "a trigger issued this" means "the cascade issued this".
    if old.routed_to_organisation_id is not null
       and new.routed_to_organisation_id is null
       and not v_seam_moved
       and not v_rest_moved
       and pg_catalog.pg_trigger_depth() >= 2
       and not exists (select 1 from public.organisations o
                        where o.id = old.routed_to_organisation_id) then
      return new;
    end if;

    -- (1b) THE JOB RECORDING ITS OUTCOME. Only the seam, only on a request
    -- that is still open, only the kind that request's right names.
    if v_seam_moved then
      if v_rest_moved
         or new.routed_to_organisation_id is distinct from old.routed_to_organisation_id then
        raise exception 'data_subject_requests: recording a fulfilment changes the fulfilment record and nothing else'
          using errcode = '42501', hint = 'seam_write_moves_only_the_seam';
      end if;
      if old.status in ('fulfilled', 'rejected', 'withdrawn') then
        raise exception 'data_subject_requests: a closed request is not rewritten, its fulfilment record included'
          using errcode = '22023', hint = 'request_is_closed';
      end if;
      select r.fulfilment_kind into v_required
        from private.dsr_rights() r where r.right_type = old.right_type;
      if old.subject_scope <> 'account'
         or v_required is null
         or new.fulfilment_kind is distinct from v_required
         or new.fulfilment_reference is null then
        raise exception 'data_subject_requests: a % request about % is not fulfilled by %',
          old.right_type, old.subject_scope, coalesce(new.fulfilment_kind, 'nothing')
          using errcode = '22023', hint = 'fulfilment_kind_mismatch';
      end if;
      -- The stamp is the database's, like every other stamp on this row.
      new.fulfilment_recorded_at := pg_catalog.now();
      return new;
    end if;

    -- (1c) A WRONG WORKSPACE IS CORRECTABLE (Q160c). Not a status transition
    -- -- the transition table has no X -> X pair and keeps none -- but the
    -- operator's, audited as its own action, and stamped afresh.
    if old.status = 'routed'
       and new.routed_to_organisation_id is not null
       and new.routed_to_organisation_id is distinct from old.routed_to_organisation_id then
      if not v_operator then
        raise exception 'data_subject_requests: only the platform operator may progress a request'
          using errcode = '42501';
      end if;
      select o.name into v_name from public.organisations o
       where o.id = new.routed_to_organisation_id;
      if not found then
        raise exception 'data_subject_requests: there is no such workspace to route to'
          using errcode = '22023', hint = 'unknown_workspace';
      end if;
      new.fulfilled_at     := old.fulfilled_at;
      new.rejected_at      := old.rejected_at;
      new.withdrawn_at     := old.withdrawn_at;
      new.rejection_reason := old.rejection_reason;
      new.routed_at        := pg_catalog.now();
      new.routed_to_organisation_name := v_name;
      return new;
    end if;

    raise exception 'data_subject_requests: % is not a transition', old.status
      using errcode = '22023', hint = 'not_a_transition';
  end if;

  -- (2) MAY THIS STATUS FOLLOW THAT ONE.
  if not private.dsr_transition_allowed(old.status, new.status) then
    raise exception 'data_subject_requests: a request cannot go from % to %', old.status, new.status
      using errcode = '22023', hint = 'illegal_transition';
  end if;

  -- (3) WHO. Withdrawal is the requester's and only the requester's; every
  -- other transition is the operator's and only the operator's. One check,
  -- not two guards, so neither can ever be given the other's power by
  -- accident.
  if new.status = 'withdrawn' then
    if not v_is_owner then
      raise exception 'data_subject_requests: only the person who made a request may withdraw it'
        using errcode = '42501';
    end if;
  elsif not v_operator then
    raise exception 'data_subject_requests: only the platform operator may progress a request'
      using errcode = '42501';
  end if;

  -- (4) THE STAMPS ARE THE DATABASE'S, so a closed request's timestamp says
  -- when it was closed rather than what a caller claimed.
  new.fulfilled_at := case when new.status = 'fulfilled' then pg_catalog.now() end;
  new.rejected_at  := case when new.status = 'rejected'  then pg_catalog.now() end;
  new.withdrawn_at := case when new.status = 'withdrawn' then pg_catalog.now() end;

  if new.status <> 'rejected' then
    new.rejection_reason := null;
  elsif new.rejection_reason is null or pg_catalog.btrim(new.rejection_reason) = '' then
    raise exception 'data_subject_requests: a refusal must say why -- the requester is shown this'
      using errcode = '22023', hint = 'rejection_needs_reason';
  else
    new.rejection_reason := pg_catalog.btrim(new.rejection_reason);
  end if;

  -- (5) ROUTING (Q132). Only a processor-scope request can be routed, only to
  -- a workspace that exists, and the routing stamp and the name snapshot are
  -- the database's.
  if new.status = 'routed' then
    if old.subject_scope <> 'workspace_records' then
      raise exception 'data_subject_requests: only a request about a workspace''s own records can be routed to that workspace'
        using errcode = '22023', hint = 'not_a_processor_request';
    end if;
    if new.routed_to_organisation_id is null then
      raise exception 'data_subject_requests: routing must name the workspace it goes to'
        using errcode = '22023', hint = 'routing_needs_workspace';
    end if;
    select o.name into v_name from public.organisations o
     where o.id = new.routed_to_organisation_id;
    if not found then
      raise exception 'data_subject_requests: there is no such workspace to route to'
        using errcode = '22023', hint = 'unknown_workspace';
    end if;
    new.routed_at := pg_catalog.now();
    new.routed_to_organisation_name := v_name;
  else
    -- Routing already recorded stays recorded: a request that was routed and
    -- is later closed keeps the evidence that it was routed, and to whom.
    new.routed_at := old.routed_at;
    new.routed_to_organisation_id   := old.routed_to_organisation_id;
    new.routed_to_organisation_name := old.routed_to_organisation_name;
  end if;

  -- (6) THE SEAM'S CONSTRAINT -- dormant PER JOB until that job exists.
  -- `export` is AWAKE from 20260927003000; `erasure` waits for Task 5.
  -- A transition always comes from a person's session, and (0) refuses a
  -- seam write from one, so new.fulfilment_* here is what a server-side
  -- session recorded earlier, or nothing.
  if new.status = 'fulfilled' and old.subject_scope = 'account' then
    select r.fulfilment_kind into v_required
      from private.dsr_rights() r where r.right_type = old.right_type;
    if v_required is not null
       and private.dsr_fulfilment_job_ready(v_required)
       and (new.fulfilment_kind is distinct from v_required
            or new.fulfilment_recorded_at is null) then
      raise exception 'data_subject_requests: a % request cannot be marked fulfilled until the % has actually run',
        old.right_type, v_required
        using errcode = '22023', hint = 'fulfilment_not_recorded';
    end if;
  end if;

  return new;
end;
$$;

comment on function private.data_subject_requests_before_update() is
  'BEFORE UPDATE on public.data_subject_requests, for EVERY writer -- the transition table, the who-may-do-it check and the stamper in one chokepoint (rebuilt in 20260927003000 from 20260925000000 § 5). THE SEAM''S SESSION TEST IS NOW AN OPEN LIST OF SERVER ROLES rather than a closed list of client ones: a fulfilment write is admitted only when auth.uid() is null AND the session''s role setting is postgres, service_role or unset, so a client role added by a later phase arrives REFUSED by omission instead of admitted by it (42501, hint fulfilment_seam_is_server_only -- its own hint, so a missing privilege''s 42501 is distinguishable). Everything else is unchanged: the request itself is immutable (42501); an illegal transition and a non-transition are refused (22023); withdrawal is the requester''s alone and every other transition the aal2 operator''s alone; a refusal must carry a reason; routing must be a processor-scope request naming a workspace that exists; with the status unchanged exactly three writes are admitted (the routed-workspace foreign key''s own nulling, a seam-only write, an operator''s re-route); a closed row is immutable, stamps included; and every stamp is the database''s. The Task 4/5 constraint (22023, fulfilment_not_recorded) is now AWAKE for `export` and still dormant for `erasure`.';


-- ---------------------------------------------------------------------------
-- 3. THE EXPORT HALF WAKES. Re-issued from its LATEST definition
--    (20260925000000 § 3); only the `export` line changes.
-- ---------------------------------------------------------------------------

create or replace function private.dsr_fulfilment_job_ready(p_kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_kind
           when 'export'  then true   -- Phase 8 Task 4 shipped: public.export_jobs
           when 'erasure' then false  -- Phase 8 Task 5 re-issues this function with `true` HERE
           else false
         end
$$;

comment on function private.dsr_fulfilment_job_ready(text) is
  'Has the job that fulfils this kind of request shipped? `export` (access, portability) is Phase 8 Task 4 and is TRUE from 20260927003000: an account-scope access or portability request can no longer be marked fulfilled until an export job for that requester has completed after the request was made and recorded itself on the row (private.data_subject_requests_before_update() § 6, 22023, hint fulfilment_not_recorded). `erasure` is Task 5 and is still FALSE, which is exactly why 20260925000000 split one boolean into one line per job (review finding I5a): waking the export constraint must not make every erasure request unfulfillable. rls_phase8_data_subject_requests.sql § DF flips each line alone inside a rolled-back transaction and asserts the refusal, the other kind''s freedom, and that a recorded seam IS admitted.';

revoke all on function private.dsr_fulfilment_job_ready(text) from public, anon, authenticated, service_role;

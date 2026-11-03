-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 1 -- M6: THE REGISTER ROW THE ERASURE ANSWERED
-- CLOSES ITSELF.
--
-- Q158 keeps the data subject request row through an erasure, anonymised, and
-- public.run_erasure_job() records the fulfilment seam on it -- and then
-- stopped. Nothing closed it. The operator COULD (and section ES proves they
-- can), but nothing tells them to: Q45 means no notification exists, so in
-- practice the row stays `open` for ever and
-- private.raise_dsr_deadline_alerts() re-raises `dsr_overdue` for it every
-- seven days (Q159) -- weekly alerts about a statutory request that was in
-- fact answered, which is the shape of alerting that teaches an operator to
-- ignore alerts.
--
-- THE ERASURE CLOSES IT, because the erasure IS the answer. The job has run,
-- in the same transaction, and the outcome is already recorded on the row; a
-- human confirmation step that nothing prompts and nobody is told about is
-- not oversight, it is a row that never closes.
--
-- WHAT IT DOES NOT DO: it closes `open` and `in_progress` account-scope
-- ERASURE requests of that subject and nothing else. A rejected, withdrawn or
-- already-fulfilled row is untouched, a request about a workspace's records is
-- untouched (GetSetPaid is not its controller -- Q132), and no other right is
-- touched. The branch that admits it is the same shape as Q158's
-- anonymisation branch: sessionless server role ONLY, and only while the
-- erasure job named in `fulfilment_reference` is `running` -- so it is
-- unreachable from any client session and unreachable even from `postgres`
-- unless a real erasure is in flight.
--
-- ADDITIVE. Both functions are rebuilt from their LATEST definitions
-- (20260930003000 section 2 and 20260930004000 section 3).
-- ===========================================================================

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
  v_session_role   text := coalesce(pg_catalog.current_setting('role', true), 'none');
  v_server_session boolean;
  v_required   text;
  v_name       text;
  v_seam_moved boolean;
  v_rest_moved boolean;
begin
  v_server_session := v_uid is null
                      and v_session_role in ('postgres', 'service_role', 'none', '');

  -- (-1) THE ERASURE ANONYMISATION (Q158, CHANGED to keep-the-row).
  -- The register row is the evidence that a statutory deadline was met, and
  -- the request most likely to be asked about later is the one that ASKED for
  -- the erasure -- so it is kept, re-pointed at the Q130 tombstone, with the
  -- three free-text/identifying columns replaced by a sentinel. `[erased]`
  -- rather than null because user_email and detail are NOT NULL, detail has a
  -- length >= 1 CHECK, and a rejected row must keep a non-null reason.
  --
  -- Admitted only from a sessionless server role AND only while an erasure
  -- job for exactly this requester is `running`, and only when NOTHING else
  -- moves. This branch is what makes the account deletable at all: user_id
  -- has no ON DELETE action (20260925000000 § 2) precisely so the cascade
  -- cannot destroy the row, which means something has to move it by hand.
  if new.user_id = private.erased_user_id()
     and old.user_id is distinct from private.erased_user_id() then
    if not v_server_session then
      raise exception 'data_subject_requests: only the erasure job anonymises a register row'
        using errcode = '42501', hint = 'erasure_anonymisation_is_server_only';
    end if;
    if not exists (select 1 from public.erasure_jobs j
                    where j.kind = 'account'
                      and j.subject_user_id = old.user_id
                      and j.status = 'running') then
      raise exception 'data_subject_requests: no erasure of that account is in flight'
        using errcode = '42501', hint = 'no_erasure_in_flight';
    end if;
    if new.user_email is distinct from '[erased]'
       or new.detail is distinct from '[erased]'
       or (old.rejection_reason is not null and new.rejection_reason is distinct from '[erased]')
       or (old.rejection_reason is null and new.rejection_reason is not null) then
      raise exception 'data_subject_requests: an anonymisation clears the email, the detail and the reason, and writes nothing else'
        using errcode = '22023', hint = 'anonymisation_shape';
    end if;
    if new.id is distinct from old.id
       or new.seq is distinct from old.seq
       or new.right_type is distinct from old.right_type
       or new.subject_scope is distinct from old.subject_scope
       or new.status is distinct from old.status
       or new.requested_at is distinct from old.requested_at
       or new.fulfilled_at is distinct from old.fulfilled_at
       or new.rejected_at is distinct from old.rejected_at
       or new.withdrawn_at is distinct from old.withdrawn_at
       or new.routed_at is distinct from old.routed_at
       or new.routed_to_organisation_id is distinct from old.routed_to_organisation_id
       or new.routed_to_organisation_name is distinct from old.routed_to_organisation_name
       or new.fulfilment_kind is distinct from old.fulfilment_kind
       or new.fulfilment_reference is distinct from old.fulfilment_reference
       or new.fulfilment_recorded_at is distinct from old.fulfilment_recorded_at then
      raise exception 'data_subject_requests: an anonymisation changes who it was about, and nothing about what happened'
        using errcode = '22023', hint = 'anonymisation_shape';
    end if;
    return new;
  end if;

  -- (-0.5) THE ERASURE CLOSING THE REQUEST IT ANSWERED (M6, fix round 1).
  -- Same admission shape as the anonymisation above: sessionless server role
  -- only, and only while the erasure job named on the row is `running`, so no
  -- client session can reach it and `postgres` cannot either unless a real
  -- erasure is in flight. It closes an account-scope ERASURE request and
  -- nothing else, and moves only the two stamps that say it is closed.
  -- NOTE THE TWO EXTRA TERMS IN THE CONDITION ITSELF, and why they are there
  -- rather than inside the branch: the OPERATOR closing an erasure request by
  -- hand is a legitimate, tested path (the seam's own positive control), and a
  -- branch that raised on everything of this shape would have taken it away.
  -- A session that is not the running erasure job falls THROUGH to the normal
  -- transition rules, which already know how to admit or refuse it.
  if old.status in ('open', 'in_progress')
     and new.status = 'fulfilled'
     and old.subject_scope = 'account'
     and old.right_type = 'erasure'
     and new.fulfilment_kind = 'erasure'
     and new.fulfilment_reference is not null
     and new.fulfilment_reference is not distinct from old.fulfilment_reference
     and v_server_session
     and exists (select 1 from public.erasure_jobs j
                  where j.id = new.fulfilment_reference
                    and j.kind = 'account'
                    and j.status = 'running') then
    if new.id is distinct from old.id
       or new.seq is distinct from old.seq
       or new.user_id is distinct from old.user_id
       or new.user_email is distinct from old.user_email
       or new.right_type is distinct from old.right_type
       or new.subject_scope is distinct from old.subject_scope
       or new.detail is distinct from old.detail
       or new.requested_at is distinct from old.requested_at
       or new.rejected_at is distinct from old.rejected_at
       or new.withdrawn_at is distinct from old.withdrawn_at
       or new.rejection_reason is distinct from old.rejection_reason
       or new.routed_at is distinct from old.routed_at
       or new.routed_to_organisation_id is distinct from old.routed_to_organisation_id
       or new.routed_to_organisation_name is distinct from old.routed_to_organisation_name
       or new.fulfilment_kind is distinct from old.fulfilment_kind then
      raise exception 'data_subject_requests: closing a request records that it is closed, and nothing else'
        using errcode = '22023', hint = 'closure_shape';
    end if;
    new.fulfilled_at := pg_catalog.now();
    if new.fulfilment_recorded_at is null then
      new.fulfilment_recorded_at := pg_catalog.now();
    end if;
    return new;
  end if;

  v_seam_moved :=
       new.fulfilment_kind        is distinct from old.fulfilment_kind
    or new.fulfilment_reference   is distinct from old.fulfilment_reference
    or new.fulfilment_recorded_at is distinct from old.fulfilment_recorded_at;

  v_rest_moved :=
       new.fulfilled_at     is distinct from old.fulfilled_at
    or new.rejected_at      is distinct from old.rejected_at
    or new.withdrawn_at     is distinct from old.withdrawn_at
    or new.rejection_reason is distinct from old.rejection_reason
    or new.routed_at        is distinct from old.routed_at
    or new.routed_to_organisation_name is distinct from old.routed_to_organisation_name;

  if v_seam_moved and not v_server_session then
    raise exception 'data_subject_requests: the fulfilment record is written by the server-side job, never from a person''s session'
      using errcode = '42501', hint = 'fulfilment_seam_is_server_only';
  end if;

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
    if old.routed_to_organisation_id is not null
       and new.routed_to_organisation_id is null
       and not v_seam_moved
       and not v_rest_moved
       and pg_catalog.pg_trigger_depth() >= 2
       and not exists (select 1 from public.organisations o
                        where o.id = old.routed_to_organisation_id) then
      return new;
    end if;

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
      new.fulfilment_recorded_at := pg_catalog.now();
      return new;
    end if;

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

  if not private.dsr_transition_allowed(old.status, new.status) then
    raise exception 'data_subject_requests: a request cannot go from % to %', old.status, new.status
      using errcode = '22023', hint = 'illegal_transition';
  end if;

  if new.status = 'withdrawn' then
    if not v_is_owner then
      raise exception 'data_subject_requests: only the person who made a request may withdraw it'
        using errcode = '42501';
    end if;
  elsif not v_operator then
    raise exception 'data_subject_requests: only the platform operator may progress a request'
      using errcode = '42501';
  end if;

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
    new.routed_at := old.routed_at;
    new.routed_to_organisation_id   := old.routed_to_organisation_id;
    new.routed_to_organisation_name := old.routed_to_organisation_name;
  end if;

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
  'BEFORE UPDATE on public.data_subject_requests, for EVERY writer (rebuilt in 20260930003000 from 20260927003000 § 2). Everything that migration described is unchanged. ONE branch is added, ahead of the immutability test that would otherwise refuse it: THE ERASURE ANONYMISATION (Q158 as changed). Re-pointing user_id at the Q130 tombstone, with user_email, detail and any rejection reason replaced by `[erased]` and every other column identical, is admitted only from a sessionless server role (42501, hint erasure_anonymisation_is_server_only) and only while an erasure job for exactly that requester is `running` (42501, hint no_erasure_in_flight); any other shape is 22023, hint anonymisation_shape. user_id has NO ON DELETE action precisely so the account''s deletion cannot take the row, which means something has to move it deliberately -- this is that something, and nothing else in the schema can reach it. SINCE FIX ROUND 1 A SECOND BRANCH is admitted on the same terms (M6): the erasure job CLOSING the account-scope erasure request it answered -- `status` to `fulfilled` plus the two stamps that say so, and nothing else (22023 closure_shape); any other session of that shape falls through to the ordinary transition rules, so the operator''s own closure is untouched. Before it nothing closed the row at all: the operator could, but nothing tells them to (Q45), so it stayed open and private.raise_dsr_deadline_alerts() re-raised dsr_overdue for it every seven days about a request that had in fact been answered.';


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

      -- ... AND THE ROW CLOSES (M6). This job is still `running` here, which
      -- is exactly what the trigger branch admitting the closure requires:
      -- the closure is part of the erasure's own transaction, so a rollback
      -- takes it back with everything else and there is no state in which a
      -- request says it was answered by an erasure that did not happen.
      update public.data_subject_requests d
         set status = 'fulfilled'
       where d.id = any (v_requests)
         and d.status in ('open', 'in_progress');
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
  'Runs a claimed erasure job and records its success IN THE SAME TRANSACTION, which is what makes the erasure all-or-nothing: a raise anywhere inside takes the work and the outcome back together, and there is no state in which some of an account is gone. For an `account` job it captures the subject''s OPEN account-scope erasure requests first, erases, and then records the fulfilment seam on those ids -- that order because writing the seam first would be a claim about the future, and finding the requests afterwards is impossible once they point at the shared tombstone. SINCE FIX ROUND 1 (M6) it also CLOSES those requests -- `fulfilled`, in the same transaction, while its own job row is still `running` -- because the erasure IS the answer and nothing else was ever going to close them. The FAILURE is deliberately not written here: public.fail_erasure_job() is a separate transaction because it has to survive the rollback it describes.';


--


create or replace function private.audit_dsr_transition()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    if old.status = 'routed'
       and new.routed_to_organisation_id is not null
       and new.routed_to_organisation_id is distinct from old.routed_to_organisation_id then
      perform private.log_audit_event(
        p_action          => 'data_subject_request.rerouted',
        p_target_type     => 'data_subject_request',
        p_organisation_id => new.routed_to_organisation_id,
        p_target_id       => new.id,
        p_before          => pg_catalog.jsonb_build_object(
                               'routed_to_organisation_id', old.routed_to_organisation_id,
                               'routed_at',                 old.routed_at),
        p_after           => pg_catalog.jsonb_build_object(
                               'status',                    new.status,
                               'right_type',                new.right_type,
                               'subject_scope',             new.subject_scope,
                               'due_by',                    new.due_by,
                               'routed_to_organisation_id', new.routed_to_organisation_id,
                               'routed_at',                 new.routed_at)
      );
    end if;
    -- A seam-only write and the foreign key's nulling: no person acted.
    return null;
  end if;

  -- THE ERASURE'S OWN CLOSURE (M6, fix round 1). The erasure job closes the
  -- request it answered, from a sessionless server role -- there is no
  -- auth.uid() and log_audit_event refuses an unattributable row, the same
  -- wall the seam hit in 20260924000000. The row is NOT skipped: a status
  -- change on the statutory register is exactly the kind of thing the audit
  -- log exists for. It is written directly with the ACTOR SET TO THE Q130
  -- TOMBSTONE, which is how every other row an erasure leaves behind is
  -- attributed -- the person who asked no longer exists by the time this runs.
  if (select auth.uid()) is null
     and new.status = 'fulfilled'
     and new.fulfilment_kind = 'erasure'
     and new.fulfilment_reference is not null
     and exists (select 1 from public.erasure_jobs j
                  where j.id = new.fulfilment_reference and j.status = 'running') then
    insert into public.audit_events
      (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, before, after)
    values (
      null, private.erased_user_id(), 'data_subject_request.fulfilled',
      'data_subject_request', new.id, new.fulfilment_reference,
      pg_catalog.jsonb_build_object('status', old.status),
      pg_catalog.jsonb_build_object(
        'status',               new.status,
        'right_type',           new.right_type,
        'subject_scope',        new.subject_scope,
        'due_by',               new.due_by,
        'on_time',              pg_catalog.now() <= new.due_by,
        'fulfilment_kind',      new.fulfilment_kind,
        'fulfilment_reference', new.fulfilment_reference,
        'closed_by',            'erasure_job'));
    return null;
  end if;

  perform private.log_audit_event(
    p_action          => 'data_subject_request.' || new.status,
    p_target_type     => 'data_subject_request',
    p_organisation_id => new.routed_to_organisation_id,
    p_target_id       => new.id,
    p_before          => pg_catalog.jsonb_build_object('status', old.status),
    p_after           => pg_catalog.jsonb_build_object(
                           'status',        new.status,
                           'right_type',    new.right_type,
                           'subject_scope', new.subject_scope,
                           'due_by',        new.due_by,
                           'routed_to_organisation_id', new.routed_to_organisation_id,
                           'reason_length',
                             case when new.rejection_reason is null then null
                                  else pg_catalog.length(new.rejection_reason) end,
                           'on_time',
                             case when new.status in ('fulfilled', 'rejected')
                                  then pg_catalog.now() <= new.due_by end,
                           'fulfilment_kind',
                             case when new.status = 'fulfilled' then new.fulfilment_kind end,
                           'fulfilment_reference',
                             case when new.status = 'fulfilled' then new.fulfilment_reference end)
  );
  return null;
end;
$$;

comment on function private.audit_dsr_transition() is
  'AFTER UPDATE on public.data_subject_requests: one row per transition, action data_subject_request.<new status>, carrying the old and new state, the right, the scope, the deadline, the workspace a routing named, the LENGTH of any rejection reason, for a closing transition whether it happened inside the 30 days, and for `fulfilled` the fulfilment kind and reference the operator relied on. A re-route (status unchanged, a different workspace) is data_subject_request.rerouted with both workspaces. NEVER the reason''s text, never the request''s detail and never the workspace''s name (audit_events is superuser-readable across tenants). A SEAM-ONLY WRITE AND THE FOREIGN KEY''S NULLING WRITE NOTHING: neither is a person''s action, there is no system actor, and log_audit_event refuses an unattributable row -- as shipped (20260924000000) that refusal made the seam unwritable by the only session allowed to write it. p_organisation_id is set for a routed request, so the workspace''s own audit filter shows that it was asked. SINCE FIX ROUND 1 (M6) one more case is handled rather than refused: the ERASURE JOB closing the request it answered has no auth.uid() either, and its row is written directly with the actor set to the Q130 tombstone -- the attribution every other row an erasure leaves behind carries -- because a status change on the statutory register is precisely what the audit log is for.';

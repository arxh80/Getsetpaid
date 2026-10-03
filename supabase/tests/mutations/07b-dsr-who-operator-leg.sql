-- PHASE 8 TASK 8 MUTANT 07b-dsr-who-operator-leg
-- guard:  private.data_subject_requests_before_update
-- change: anyone may progress a request (the operator-only check on a status change is removed)
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.data_subject_requests_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- has no ON DELETE action (20260925000000 Â§ 2) precisely so the cascade
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
  elsif false then
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
$function$;

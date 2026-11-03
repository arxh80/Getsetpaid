-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 2 -- REINSTATE REFUSES A WORKSPACE WITH NO ACTIVE
-- OWNER (re-review N2).
--
-- delete_closed_workspace() moves a closed workspace to `deleted`, "reversible
-- with reinstate_organisation() until the purge runs" (Q210). But a non-live
-- workspace does not block its last Owner's erasure -- which is what closing is
-- for -- so one deliberate superuser click could produce a LIVE workspace with
-- no Owner, the state Q131 exists to prevent. The same holds for a suspended
-- workspace whose last Owner erased.
--
-- THE RULE CHOSEN, AND WHY IT IS THE NARROWEST CORRECT ONE: refuse reinstate
-- while the workspace has no active Owner (the tombstone does not count).
-- The alternative -- refuse whenever the deletion came from the closure
-- decision -- would also remove the documented one-hour undo of a mistaken
-- "delete permanently" for a workspace whose Owner is still there (Q210), and
-- would leave the suspended-then-ownerless case open. The harm is "live with
-- no Owner"; the rule names exactly that.
--
-- private.lifecycle_has_active_owner() is SECURITY DEFINER because the
-- superuser has no tenant read of organisation_memberships (CLAUDE.md §
-- Superuser dashboard), and is guarded by the same aal2 platform-superuser
-- check as lifecycle_target(), so it is not a membership oracle for anyone.
--
-- Rebuilt from the LATEST pg_get_functiondef (20261028000000). ADDITIVE.
-- ===========================================================================

create or replace function private.lifecycle_has_active_owner(p_organisation_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('manage_organisation_lifecycle') then
    raise exception 'organisation lifecycle: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;
  return exists (
    select 1 from public.organisation_memberships m
     where m.organisation_id = p_organisation_id
       and m.role = 'owner'
       and m.status = 'active'
       and m.user_id <> private.erased_user_id());
end;
$$;
comment on function private.lifecycle_has_active_owner(uuid) is
  'Task 9c fix round 2 (N2, 20261028001000): does this workspace have an active Owner who is not the erasure tombstone? reinstate_organisation() refuses (reinstate_needs_an_active_owner) when it does not, so no reinstatement produces a live workspace nobody can manage (Q131). SECURITY DEFINER (the superuser has no tenant read of memberships), guarded by the aal2 platform-superuser check, returns one boolean.';
revoke all on function private.lifecycle_has_active_owner(uuid) from public, anon, authenticated, service_role;
grant execute on function private.lifecycle_has_active_owner(uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.reinstate_organisation(p_organisation_slug text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  -- 20261026000000 (Task 9c fix round 1, I1): AN OWNER-CLOSED WORKSPACE IS
  -- DECIDED AT /super/closures, NOT HERE. Reinstating it skipped the
  -- reassignment (a live workspace whose closing Owner may already be erased,
  -- with no Owner at all) and suspending or deleting it erased the
  -- owner_closed discriminator, re-stamped the 60-day clock and told nobody.
  -- reassign_closed_workspace() / delete_closed_workspace() are the two ways
  -- out of owner_closed.
  if v_target.lifecycle_state = 'owner_closed' then
    raise exception 'reinstate_organisation: that workspace was closed by its Owner; decide it on /super/closures (reassign or delete)'
      using errcode = '22023', hint = 'owner_closed_is_decided_at_super_closures';
  end if;

  if v_target.lifecycle_state = 'active' then
    raise exception 'reinstate_organisation: that workspace is not suspended or deleted'
      using errcode = '22023';
  end if;

  -- 20261028001000 (Task 9c fix round 2, N2): NEVER A LIVE WORKSPACE WITH NO
  -- OWNER (Q131). A workspace deleted by delete_closed_workspace() -- or any
  -- suspended/deleted one -- can have lost its last Owner meanwhile: a
  -- non-live workspace does not block its last Owner's erasure
  -- (account_last_owner_workspaces reads live workspaces only), which is the
  -- point of closing. Reinstating it would make it writable with nobody able
  -- to manage it. The tombstone is not an Owner. The closure path's way back
  -- with a new Owner is reassign_closed_workspace(), before the delete.
  if not private.lifecycle_has_active_owner(v_target.id) then
    raise exception 'reinstate_organisation: that workspace has no active Owner, so reinstating it would leave nobody able to manage it'
      using errcode = '22023', hint = 'reinstate_needs_an_active_owner';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'lifecycle_state', v_target.lifecycle_state,
    'deleted_at',      v_target.deleted_at);

  perform private.begin_lifecycle_transition(v_corr);

  -- Clearing deleted_at is the whole reinstatement: every gate in the schema
  -- reads that column, so the workspace becomes writable again the instant
  -- this commits. private.organisation_lifecycle_sync() clears the three
  -- lifecycle columns with it, so no live workspace carries a stale retention
  -- deadline or a stale suspension reason.
  --
  -- NOTE THE ABSENCE OF ANY WINDOW CHECK. Reinstatement is deliberately
  -- possible past retention_expires_at too: the 60 days is when the workspace
  -- stops being VISIBLE and becomes eligible for a future purge, not a
  -- deadline after which the operator is locked out of their own undo. A
  -- one-way door with a clock on it is the failure mode this whole task
  -- exists to avoid.
  update public.organisations
  set deleted_at = null
  where id = v_target.id
    and lifecycle_state = v_target.lifecycle_state;
  get diagnostics n = row_count;

  if n = 0 then
    -- 20261028000000 (N1): the UPDATE re-checks the state it was decided on.
    -- Zero rows with the row still there and in ANOTHER state means it moved
    -- under us: refuse distinguishably, write nothing.
    if exists (select 1 from public.organisations o
                where o.id = v_target.id
                  and o.lifecycle_state is distinct from v_target.lifecycle_state) then
      raise exception 'reinstate_organisation: that workspace changed while this ran; reload and decide again'
        using errcode = '40001', hint = 'lifecycle_changed_concurrently';
    end if;
    raise exception 'reinstate_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.reinstated', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$function$;

comment on function public.delete_closed_workspace(text, text) is
  'THE SUPERUSER''S SECOND DECISION ON A CLOSED WORKSPACE (Phase 8 Task 9c job 2; founder 2026-09-30). Platform superuser, at aal2, mandatory reason (<= 500), ONLY while owner_closed: moves the workspace to lifecycle_state deleted and makes it due for the EXISTING Q88 purge immediately (lifecycle_changed_at dated one retention period back, so retention_expires_at is in the past) -- the next hourly retention run purges its bytes and then calls private.erase_organisation() through sweep_expired_workspaces(), exactly as for a workspace whose 60 days ran out. No second deletion engine. Audited as organisation.closure_deleted with the remaining active Owners/Admins the notice goes to (snapshotted, because the purge cascades the memberships). Returns the audit row id. Reversible with reinstate_organisation() until the purge runs -- but only while the workspace still has an active Owner (20261028001000, N2: reinstate refuses reinstate_needs_an_active_owner otherwise).';

-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 1b -- THE SUPERUSER IS NEVER THE REASSIGN TARGET
-- (review m2, Q222 default).
--
-- reassign_closed_workspace() accepted, and closed_workspace_reassign_
-- candidates() listed, a public.platform_admins user who happened to be an
-- active member of the closed workspace. The first now refuses them (22023,
-- new_owner_is_platform_superuser) before the membership check; the second
-- excludes them, so the picker still offers exactly the set the decision
-- accepts. Both rebuilt from their LIVE definitions (standing lesson 4).
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.reassign_closed_workspace(p_organisation_slug text, p_new_owner_user_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t      record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_role   text;
  v_backup uuid;
  v_audit  uuid;
begin
  select * into v_t from private.closure_decision_target(p_organisation_slug, p_reason);

  if v_t.lifecycle_state is distinct from 'owner_closed' then
    raise exception 'reassign_closed_workspace: only a workspace its Owner closed awaits this decision'
      using errcode = '22023', hint = 'decision_workspace_not_owner_closed';
  end if;

  -- 20261027001000 (Task 9c fix round 1b, Q222 / review m2): NEVER THE
  -- PLATFORM SUPERUSER. The decision is the superuser's; making themselves the
  -- Owner of a customer's workspace would be tenant-data access outside the
  -- audited, admin-approved impersonation flow (CLAUDE.md § Superuser dashboard).
  if exists (select 1 from public.platform_admins pa where pa.user_id = p_new_owner_user_id) then
    raise exception 'reassign_closed_workspace: the platform superuser cannot be made the Owner of a closed workspace'
      using errcode = '22023', hint = 'new_owner_is_platform_superuser';
  end if;

  -- THE NEW OWNER IS AN EXISTING ACTIVE MEMBER -- never an outsider, never an
  -- invited or revoked row, never the tombstone.
  select m.role into v_role
    from public.organisation_memberships m
   where m.organisation_id = v_t.id
     and m.user_id = p_new_owner_user_id
     and m.status = 'active'
     and p_new_owner_user_id <> private.erased_user_id();
  if not found then
    raise exception 'reassign_closed_workspace: the new Owner must be an active member of this workspace'
      using errcode = '22023', hint = 'new_owner_must_be_active_member';
  end if;

  select j.id into v_backup
    from public.export_jobs j
   where j.organisation_id = v_t.id and j.closure_backup
   order by j.requested_at desc limit 1;

  perform private.begin_lifecycle_transition(v_corr);

  if v_role <> 'owner' then
    update public.organisation_memberships m
       set role = 'owner'
     where m.organisation_id = v_t.id and m.user_id = p_new_owner_user_id;
  end if;

  -- REOPEN. Clearing deleted_at is the whole of it: private.organisation_
  -- lifecycle_sync() returns the state to active and clears the reason and
  -- BOTH clocks, so the 60-day purge no longer selects it.
  update public.organisations set deleted_at = null where id = v_t.id;

  v_audit := private.log_audit_event(
    p_action          => 'organisation.closure_reassigned',
    p_target_type     => 'organisation',
    p_organisation_id => v_t.id,
    p_target_id       => v_t.id,
    p_correlation_id  => v_corr,
    p_before          => pg_catalog.jsonb_build_object(
      'lifecycle_state', v_t.lifecycle_state, 'deleted_at', v_t.deleted_at,
      'new_owner_previous_role', v_role),
    p_after           => pg_catalog.jsonb_build_object(
      'lifecycle_state',      'active',
      'reason',               v_t.reason,
      'new_owner_user_id',    p_new_owner_user_id,
      'backup_export_job_id', v_backup,
      'organisation_slug',    v_t.slug,
      'organisation_name',    v_t.name,
      'notify_user_ids',      private.closure_decision_recipients(v_t.id)));

  perform private.end_lifecycle_transition();
  return v_audit;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.closed_workspace_reassign_candidates(p_organisation_id uuid)
 RETURNS TABLE(user_id uuid, display_name text, role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.has_platform_permission('manage_organisation_lifecycle') then
    raise exception 'closed_workspace_reassign_candidates: caller is not the platform superuser at aal2'
      using errcode = '42501', hint = 'decision_needs_superuser';
  end if;

  if not exists (select 1 from public.organisations o
                  where o.id = p_organisation_id and o.lifecycle_state = 'owner_closed') then
    raise exception 'closed_workspace_reassign_candidates: only a workspace its Owner closed awaits this decision'
      using errcode = '22023', hint = 'closure_candidates_not_owner_closed';
  end if;

  return query
    select m.user_id, p.full_name, m.role
      from public.organisation_memberships m
      left join public.profiles p on p.id = m.user_id
     where m.organisation_id = p_organisation_id
       and m.status = 'active'
       and m.user_id <> private.erased_user_id()
       -- 20261027001000 (Q222): never the platform superuser -- the set stays
       -- exactly what reassign_closed_workspace() accepts.
       and not exists (select 1 from public.platform_admins pa where pa.user_id = m.user_id)
     order by (m.role = 'owner') desc, (m.role = 'admin') desc, p.full_name nulls last, m.user_id
     limit 200;
end;
$function$
;

-- =============================================================================
-- Phase 8 Task 9c job 3a: the /super/closures page's reassign picker.
-- =============================================================================
-- Founder 2026-09-30 (Q176/Q178). public.reassign_closed_workspace() takes a
-- new Owner's user id, and it must be an ACTIVE member of the closed
-- workspace. The operator has no way to name one: the superuser has no read of
-- organisation_memberships or profiles for a foreign tenant, by design.
--
-- This is the narrowest read that makes the decision possible:
--   * platform superuser at aal2 only (has_platform_permission, the same gate
--     closed_workspaces_awaiting_decision uses);
--   * ONLY for a workspace that is owner_closed -- an active, suspended or
--     superuser-closed workspace's roster is refused with the same hint, so
--     this is not a general member directory;
--   * ACTIVE members only, never the erasure tombstone -- exactly the set
--     reassign_closed_workspace() would accept, so every option the picker
--     offers is one the decision admits;
--   * three columns: user id, display name (profiles.full_name, which may be
--     null), role. No email, no record content, no activity;
--   * bounded: at most 200 rows (a workspace larger than that is not a
--     realistic MVP shape; Q215).
-- Unknown ids are refused identically to non-closed ones
-- (closure_candidates_not_owner_closed), so it is not an existence oracle
-- beyond what the list RPC already tells the same caller.
-- =============================================================================

create or replace function public.closed_workspace_reassign_candidates(p_organisation_id uuid)
returns table (user_id uuid, display_name text, role text)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
     order by (m.role = 'owner') desc, (m.role = 'admin') desc, p.full_name nulls last, m.user_id
     limit 200;
end;
$$;

comment on function public.closed_workspace_reassign_candidates(uuid) is
  'The /super/closures reassign picker (Phase 8 Task 9c job 3a; founder 2026-09-30, Q176/Q178). Platform superuser at aal2 only, and ONLY for an owner_closed workspace (anything else, unknown ids included, is 22023 closure_candidates_not_owner_closed). Returns the ACTIVE, non-tombstone members -- exactly the set reassign_closed_workspace() accepts -- as user id, display name (profiles.full_name, may be null) and role. No email, no record content. At most 200 rows (Q215).';
revoke all on function public.closed_workspace_reassign_candidates(uuid) from public, anon, authenticated, service_role;
grant execute on function public.closed_workspace_reassign_candidates(uuid) to authenticated;

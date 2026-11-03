-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 1b -- THE REASSIGN PICKER PAGES PAST 200
-- (review m3, Q224 default: keyset on (role rank, user id)).
--
-- public.closed_workspace_reassign_candidates() stopped at 200 rows with no
-- next page, so a valid target beyond row 200 -- one reassign_closed_
-- workspace() would accept -- was unreachable from /super/closures. It now
-- takes p_after (the last user id of the previous page) and orders by
-- (role rank, user id): Owners, then Admins, then everyone else, each by id.
-- The display-name sort is dropped because a nullable, non-unique, mutable
-- name is not a keyset. A cursor that is not itself a candidate is refused
-- (22023 closure_candidates_bad_cursor) rather than silently answering an
-- empty page. Page size is still at most 200.
--
-- The signature changes, so the function is DROPPED and re-created (with its
-- grants and comment re-stated), rebuilt from its LIVE body (20261027002000:
-- the Q222 exclusion and the Q223 audit row, which now also records whether
-- the read was a later page -- never the cursor, which is a member's id).
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

drop function public.closed_workspace_reassign_candidates(uuid);

create function public.closed_workspace_reassign_candidates(
  p_organisation_id uuid, p_after uuid default null)
returns table (user_id uuid, display_name text, role text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_n          bigint;
  v_after_rank int;
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

  -- THE CURSOR MUST BE A CANDIDATE: its rank is read from its own row, so the
  -- keyset comparison below is (rank, id) > (its rank, its id).
  if p_after is not null then
    select case m.role when 'owner' then 0 when 'admin' then 1 else 2 end
      into v_after_rank
      from public.organisation_memberships m
     where m.organisation_id = p_organisation_id
       and m.user_id = p_after
       and m.status = 'active'
       and m.user_id <> private.erased_user_id()
       and not exists (select 1 from public.platform_admins pa where pa.user_id = m.user_id);
    if not found then
      raise exception 'closed_workspace_reassign_candidates: the page cursor is not a candidate of this workspace'
        using errcode = '22023', hint = 'closure_candidates_bad_cursor';
    end if;
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
       and (p_after is null
            or (case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.user_id)
               > (v_after_rank, p_after))
     order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.user_id
     limit 200;
  get diagnostics v_n = row_count;

  -- 20261027002000 (Q223): THE READ AUDITS ITSELF. Counts only: no name, no
  -- role, no member id -- not even the cursor.
  perform private.log_audit_event(
    p_action          => 'organisation.closure_candidates_viewed',
    p_target_type     => 'organisation',
    p_organisation_id => p_organisation_id,
    p_target_id       => p_organisation_id,
    p_after           => pg_catalog.jsonb_build_object(
      'rows_returned', v_n, 'later_page', p_after is not null));
end;
$function$;

comment on function public.closed_workspace_reassign_candidates(uuid, uuid) is
  'The /super/closures reassign picker (Phase 8 Task 9c job 3a; founder 2026-09-30, Q176/Q178). Platform superuser at aal2 only, and ONLY for an owner_closed workspace (anything else, unknown ids included, is 22023 closure_candidates_not_owner_closed). Returns the ACTIVE, non-tombstone, non-superuser members (Q222) -- exactly the set reassign_closed_workspace() accepts -- as user id, display name (profiles.full_name, may be null) and role. No email, no record content. Keyset-paged, 200 per page, on (role rank: owner, admin, others; user id); p_after is the previous page''s last user id and must itself be a candidate (22023 closure_candidates_bad_cursor) (Q224). Each successful read writes organisation.closure_candidates_viewed with counts only (Q223).';
revoke all on function public.closed_workspace_reassign_candidates(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.closed_workspace_reassign_candidates(uuid, uuid) to authenticated;

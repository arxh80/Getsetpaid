-- ===========================================================================
-- OWNER ROWS ARE AN OWNER'S TO GIVE (Phase 10 Task 2, finding F2; Q248)
--
-- THE HOLE. The three client write policies on public.organisation_memberships
-- (20260828220000 § 3) gate on has_permission(org, 'manage_members') and
-- `role <> 'platform_superuser'`, and nothing else about the role. Admin holds
-- manage_members (20260826202023), so an aal2 Admin could, straight over
-- PostgREST:
--   1. PATCH their own membership to {"role":"owner"};
--   2. DELETE the founding Owner's membership (membership_keeps_an_owner()
--      passes, because the attacker is now another active Owner);
--   3. or POST a new membership with "role":"owner" for an accomplice.
-- INVITABLE_ROLES in the app omits 'owner', but that is UI. The PRD's role
-- table says an Admin has "no ownership transfer unless granted", and
-- 20260828220000's UPDATE policy comment claimed a "self-promotion rule" that
-- never existed.
--
-- THE RULE (Q248 default, per the PRD): only an active Owner of the workspace
-- may write a membership row whose role is 'owner' -- create one, promote to
-- one, demote or otherwise change one, or remove one. Expressed as one term,
-- `role <> 'owner' or private.is_active_owner(organisation_id)`, added to:
--   INSERT  WITH CHECK  (the new row)
--   UPDATE  USING       (the row as it was: an Owner's row is filtered out)
--   UPDATE  WITH CHECK  (the row as it will be: no promotion to owner)
--   DELETE  USING       (an Owner's row is filtered out)
-- So an Admin's attempt is ok(0) where it targets an Owner's row (USING) and
-- 42501 where it would create one (WITH CHECK) -- the same two mechanisms the
-- rest of this table's suite asserts.
--
-- WHAT THIS DOES NOT TOUCH. The SECURITY DEFINER paths that legitimately write
-- Owner rows -- create_organisation() (the founding Owner), accept_invite(),
-- erase_account()'s transfer, the closure and lifecycle RPCs -- run as the
-- table owner and are not subject to these policies, exactly as before. Task
-- 21's member-management UI, whichever path it takes, inherits the rule: an
-- RLS-client write meets these policies, and a definer RPC can call
-- private.is_active_owner() for the same answer.
--
-- Every other term of each policy is restated unchanged from 20260828220000
-- (the second suspension gate is asserted by rls_phase2_crm.sql P11e and
-- rls_phase8_workspace_closure.sql CW15h).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- private.is_active_owner(org): the caller holds an ACTIVE 'owner' membership
-- of that organisation. is_active_member()'s shape and reasons exactly
-- (20260826154304): SECURITY DEFINER because it is called from this table's own
-- policies and must not re-enter them; fail-closed on NULL by construction.
-- ---------------------------------------------------------------------------
create or replace function private.is_active_owner(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organisation_memberships m
    where m.organisation_id = p_org_id
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
      and m.status = 'active'
  );
$$;

comment on function private.is_active_owner(uuid) is
  'True iff auth.uid() holds an active owner membership of p_org_id. The Q248 rule (Phase 10 Task 2 F2): only an Owner may create, change or remove a membership row whose role is owner. Called from the organisation_memberships write policies (20261106000000); a definer RPC that writes memberships calls it for the same answer. SECURITY DEFINER to avoid RLS recursion; reads only the caller''s own rows.';

revoke all on function private.is_active_owner(uuid) from public, anon, authenticated, service_role;
grant execute on function private.is_active_owner(uuid) to authenticated;

alter policy organisation_memberships_insert_manage_members
  on public.organisation_memberships
  with check (
    public.has_permission(organisation_id, 'manage_members')
    and private.organisation_is_live(organisation_id)
    and role <> 'platform_superuser'
    and (role <> 'owner' or private.is_active_owner(organisation_id))
    and (invited_by is null or invited_by = (select auth.uid()))
    and status = 'invited'
    and joined_at is null
  );

alter policy organisation_memberships_update_manage_members
  on public.organisation_memberships
  using (
    public.has_permission(organisation_id, 'manage_members')
    and private.organisation_is_live(organisation_id)
    and role <> 'platform_superuser'
    and (role <> 'owner' or private.is_active_owner(organisation_id))
  )
  with check (
    public.has_permission(organisation_id, 'manage_members')
    and private.organisation_is_live(organisation_id)
    and role <> 'platform_superuser'
    and (role <> 'owner' or private.is_active_owner(organisation_id))
    and private.membership_update_is_permitted(id, organisation_id, user_id, status, joined_at)
  );

alter policy organisation_memberships_delete_manage_members
  on public.organisation_memberships
  using (
    public.has_permission(organisation_id, 'manage_members')
    and private.organisation_is_live(organisation_id)
    and role <> 'platform_superuser'
    and (role <> 'owner' or private.is_active_owner(organisation_id))
  );

comment on policy organisation_memberships_insert_manage_members on public.organisation_memberships is
  'Invite a member. TWO INDEPENDENT SUSPENSION GATES (has_permission(...,''manage_members'') and private.organisation_is_live()). No platform_superuser row may be created here; an OWNER row only by an active Owner of the workspace (20261106000000, Q248: an Admin cannot invite an Owner); invited_by must be the caller or null; a row must arrive as status=''invited'' with no joined_at.';

comment on policy organisation_memberships_update_manage_members on public.organisation_memberships is
  'Change a membership (role, status). TWO INDEPENDENT SUSPENSION GATES in BOTH USING and WITH CHECK. Since 20261106000000 (Q248) an Owner''s row is invisible to a non-Owner''s UPDATE (USING) and no non-Owner may write role = owner (WITH CHECK): an Admin can neither promote anyone, themselves included, to Owner nor demote or suspend an Owner. private.membership_update_is_permitted() pins identity columns and the invited->active transition; the last-owner rule is the membership_keeps_an_owner trigger (20261001001000), not this policy. The "self-promotion rule" an earlier comment here claimed did not exist until 20261106000000.';

comment on policy organisation_memberships_delete_manage_members on public.organisation_memberships is
  'Remove a membership. TWO INDEPENDENT SUSPENSION GATES. No platform_superuser row may be deleted here; an Owner''s row only by an active Owner of the workspace (20261106000000, Q248).';

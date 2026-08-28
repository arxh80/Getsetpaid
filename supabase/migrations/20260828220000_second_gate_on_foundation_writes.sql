-- Phase 2 (Core CRM), Task 3a FIX ROUND 1: the second gate the documents
-- already claimed existed.
--
-- ===========================================================================
-- THE FINDING (task-3a-review.md § I-3)
-- ===========================================================================
-- Three documents -- SECURITY.md § Known risk areas, 20260828210000's own
-- header, and DECISIONS-QUEUE § Q6 -- assert that a suspended organisation's
-- writes are protected by two independent gates, and that "either alone would
-- close the write".
--
-- That is TRUE of the 25 CRM write policies, which name BOTH
-- private.permitted_organisations('manage_*') AND
-- private.crm_write_organisations(), the latter carrying its own unconditional
-- `o.deleted_at is null`.
--
-- IT WAS FALSE of the four FOUNDATION write policies, which consult
-- public.has_permission() and nothing else:
--
--     INSERT public.organisation_memberships organisation_memberships_insert_manage_members
--     UPDATE public.organisation_memberships organisation_memberships_update_manage_members
--     DELETE public.organisation_memberships organisation_memberships_delete_manage_members
--     UPDATE public.organisations           organisations_update_manage_organisation
--
-- The reviewer flipped ONE boolean --
-- `update public.permissions set survives_suspension = true
--    where key = 'manage_organisation'` -- and an aal2 Owner UN-SUSPENDED THEIR
-- OWN ORGANISATION. The same flip on `manage_members` let an Owner INVITE A NEW
-- ADMIN INTO A SUSPENDED ORGANISATION and REMOVE an existing member. The same
-- flip on a CRM key (`manage_contacts`) was refused, because the second gate
-- was there.
--
-- So DECISIONS-QUEUE consequence P7 -- the consequence the brief calls the one
-- that would "make the control meaningless" if broken -- rested on a single
-- boolean in a single table row, with the security documents saying otherwise.
--
-- ===========================================================================
-- THE CHOICE, AND WHY IT IS THIS ONE
-- ===========================================================================
-- Two honest options: correct the claim, or make the claim true. This migration
-- makes it true, for three reasons.
--
--   1. `manage_organisation` on a suspended organisation is EXACTLY the
--      "superuser action, not self-service" boundary of CLAUDE.md § Superuser
--      dashboard. Defence in depth on that specific boundary is not
--      belt-and-braces for its own sake; it is the boundary the whole control
--      exists to hold.
--   2. It costs four ALTER POLICY statements and one helper, and it introduces
--      NO new coupling: `private.crm_write_organisations()` is already exactly
--      this shape -- a second, unconditional `deleted_at is null` on the write
--      path, evaluated beside the permission engine rather than inside it.
--      This is that pattern applied to the four policies it had never reached.
--   3. It changes NO behaviour today. Every one of these writes is already
--      denied in a suspended organisation, so nothing that passes now stops
--      passing. What changes is what happens when the FIRST gate is wrong --
--      and that case is now asserted rather than assumed
--      (rls_phase2_crm.sql P11-P11d, which flip the catalogue boolean in the
--      test and prove the write is still refused).
--
-- ===========================================================================
-- CORRECTIONS THAT CANNOT BE MADE IN PLACE
-- ===========================================================================
-- 20260828210000's header says, under "WHAT DOES *NOT* CHANGE":
--
--     "Either alone would close the write."
--
-- That sentence was true of the CRM tables and false of the four policies
-- above. The additive-only rule (DECISIONS-QUEUE § Q9: `supabase db push` skips
-- a version the remote already records, so an in-place amendment can never
-- reach a database that already ran it) forbids editing that file, so the
-- correction lives HERE, in the migration that makes the sentence true, and in
-- the policy comments below, which DO travel in the database.
--
-- The accurate statement, as of this migration:
--
--     Every organisation-scoped WRITE policy in the product now has two
--     independent `deleted_at` gates. For the 25 CRM write policies the second
--     gate is private.crm_write_organisations(). For the four Foundation write
--     policies it is private.organisation_is_live(), added here. Either alone
--     closes the write, and `public.permissions.survives_suspension` being
--     wrong for a write key no longer opens one.
--
-- A SECOND, SMALLER CORRECTION TO THE SAME HEADER (review finding M-4). It says
-- of the two permission functions:
--
--     "The join is written IDENTICALLY in both bodies, deliberately, so a diff
--      of the two is empty on the part that matters."
--
-- A literal diff is NOT empty: the indentation differs (four spaces in
-- has_permission, two in permitted_organisations). What IS byte-identical is
-- the parenthesised clause `(o.deleted_at is null or perm.survives_suspension)`,
-- and that is the property worth stating, because it is the one the replacement
-- shape guard is anchored on -- rls_phase2_crm.sql M1c matches that exact
-- substring in both bodies with SQL comments stripped first, and M1d asserts it
-- is the ONLY suspension term in either body.
--
-- ===========================================================================
-- MIGRATION DISCIPLINE
-- ===========================================================================
-- Additive only. No existing migration file is edited. `alter policy` is the
-- supported way to change a policy expression; `create or replace policy` DOES
-- NOT EXIST in Postgres (42601). ALTER POLICY leaves an omitted USING or WITH
-- CHECK clause unchanged, which is used deliberately below.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE SECOND GATE, as a helper
--
-- SECURITY DEFINER on purpose. A defence-in-depth check must not itself depend
-- on another policy being right: an INVOKER function here would read
-- public.organisations under organisations_select_member, so its answer would
-- be a function of the SELECT policy it is meant to be independent of. Owned by
-- postgres, so the read happens with RLS off, exactly like
-- private.crm_write_organisations().
--
-- No recursion is introduced: the body reads one table and calls no function,
-- and it is never named by a policy ON public.organisations (that policy uses
-- the row's own deleted_at column directly -- see § 2).
-- ---------------------------------------------------------------------------
create function private.organisation_is_live(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organisations o
    where o.id = p_org_id
      and o.deleted_at is null
  );
$$;

comment on function private.organisation_is_live(uuid) is
  'True iff p_org_id exists and is NOT soft-deleted (suspended). THE SECOND GATE ON FOUNDATION WRITES, and the whole point is that it is UNCONDITIONAL: it does not consult public.permissions, so it holds even when survives_suspension is wrong for a write key. Task 3a review § I-3 flipped manage_organisation.survives_suspension to true and an Owner un-suspended their own organisation; flipping manage_members let one invite a new admin into a suspended organisation. The 25 CRM write policies were never exposed to that, because private.crm_write_organisations() carries the same unconditional clause for them. This is that function''s counterpart for the four Foundation write policies, which consulted public.has_permission() and nothing else. SECURITY DEFINER so the check does not depend on organisations_select_member being right -- a defence-in-depth term that is a function of the gate beside it is not depth. rls_phase2_crm.sql P11-P11d assert it by disabling the first gate.';

revoke all on function private.organisation_is_live(uuid) from public, anon, authenticated, service_role;
grant execute on function private.organisation_is_live(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. public.organisations -- the P7 policy
--
-- This one needs no helper: the policy is ON public.organisations, so the row's
-- own `deleted_at` is in scope. Reading the column directly rather than calling
-- organisation_is_live(id) is both cheaper and stricter -- it is the row being
-- updated, not a second lookup that could in principle see a different row.
--
-- USING ONLY, and WITH CHECK DELIBERATELY UNCHANGED. USING decides which rows
-- the statement may touch, so a suspended organisation becomes untouchable:
-- deleted_at cannot be cleared, the name cannot be changed, nothing can. WITH
-- CHECK is left alone because adding `deleted_at is null` there would forbid
-- SETTING deleted_at -- i.e. it would remove an aal2 Owner's ability to
-- soft-delete their own organisation, which is existing behaviour this fix
-- round has no mandate to change. The asymmetry is the correct one: suspending
-- is a door you can walk through, un-suspending is not.
-- ---------------------------------------------------------------------------
alter policy organisations_update_manage_organisation
  on public.organisations
  using (
    public.has_permission(id, 'manage_organisation')
    and deleted_at is null
  );

comment on policy organisations_update_manage_organisation on public.organisations is
  'Rename / edit the organisation. TWO INDEPENDENT GATES since Task 3a fix round 1: public.has_permission(id,''manage_organisation''), which is false in a suspended organisation because public.permissions.survives_suspension is false for that key; AND an unconditional `deleted_at is null` in USING, which does not consult the catalogue at all. DECISIONS-QUEUE consequence P7 -- an Owner cannot un-suspend their own organisation -- previously rested on the catalogue boolean alone, and the Task 3a review demonstrated an Owner clearing deleted_at after one wrong UPDATE to public.permissions. WITH CHECK is deliberately NOT gated on deleted_at: that would forbid setting it, removing an Owner''s ability to soft-delete their own organisation. Reinstatement stays a privileged path Phase 7 must ship as a SEPARATE policy (permissive policies OR together, so a superuser policy is unaffected by the term added here).';

-- ---------------------------------------------------------------------------
-- 3. public.organisation_memberships -- the manage_members policies
--
-- Three policies, one rule. INSERT gets the term in WITH CHECK (there is no old
-- row); DELETE gets it in USING; UPDATE gets it in BOTH -- USING is what
-- actually closes it, and WITH CHECK costs nothing and closes the theoretical
-- case of a row being moved INTO a suspended organisation.
--
-- public.accept_invite() already refuses to activate a membership in a
-- soft-deleted organisation and is unchanged; this closes the direct-PostgREST
-- path beside it.
-- ---------------------------------------------------------------------------
alter policy organisation_memberships_insert_manage_members
  on public.organisation_memberships
  with check (
    public.has_permission(organisation_id, 'manage_members')
    and private.organisation_is_live(organisation_id)
    and role <> 'platform_superuser'
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
  )
  with check (
    public.has_permission(organisation_id, 'manage_members')
    and private.organisation_is_live(organisation_id)
    and role <> 'platform_superuser'
    and private.membership_update_is_permitted(id, organisation_id, user_id, status, joined_at)
  );

alter policy organisation_memberships_delete_manage_members
  on public.organisation_memberships
  using (
    public.has_permission(organisation_id, 'manage_members')
    and private.organisation_is_live(organisation_id)
    and role <> 'platform_superuser'
  );

comment on policy organisation_memberships_insert_manage_members on public.organisation_memberships is
  'Invite a member. TWO INDEPENDENT SUSPENSION GATES since Task 3a fix round 1: has_permission(...,''manage_members''), which the catalogue makes false in a suspended organisation, AND private.organisation_is_live(), which does not consult the catalogue. The Task 3a review flipped manage_members.survives_suspension to true and invited a new admin into a suspended organisation; that is now refused twice. The rest of the clause is unchanged Foundation logic: no platform_superuser row may be created here, invited_by must be the caller or null, and a row must arrive as status=''invited'' with no joined_at.';

comment on policy organisation_memberships_update_manage_members on public.organisation_memberships is
  'Change a membership (role, status). TWO INDEPENDENT SUSPENSION GATES since Task 3a fix round 1 -- has_permission(...,''manage_members'') and the unconditional private.organisation_is_live() -- in BOTH USING and WITH CHECK. USING is what closes the write; the WITH CHECK copy also refuses a row moved INTO a suspended organisation. private.membership_update_is_permitted() is unchanged and still carries Foundation''s last-owner and self-promotion rules.';

comment on policy organisation_memberships_delete_manage_members on public.organisation_memberships is
  'Remove a membership. TWO INDEPENDENT SUSPENSION GATES since Task 3a fix round 1: has_permission(...,''manage_members'') and the unconditional private.organisation_is_live(). The Task 3a review flipped the catalogue boolean and removed a member from a suspended organisation; that is now refused twice. No platform_superuser row may be deleted here, unchanged.';

-- ---------------------------------------------------------------------------
-- 4. THE CLAIM, corrected where it travels in the database
--
-- public.permissions.survives_suspension's comment already says the right thing
-- about the DEFAULT. What it did not say is how much weight a wrong value
-- carries, which is the only thing I-3 was actually about.
-- ---------------------------------------------------------------------------
-- 20260827015924's accept_invite() body carries an inline comment justifying its
-- soft-deleted-organisation refusal as "joining a soft-deleted tenant would
-- produce an active membership of an organisation the user can never see
-- (organisations_select_member does not filter deleted_at, but every product
-- surface does...)". THE PARENTHESIS IS FALSE SINCE Q6: a member of a suspended
-- organisation reads its CRM. The REFUSAL is still right, for the reason that
-- always mattered and is the second half of that same sentence -- accepting an
-- invite is a WRITE, and a suspended organisation must not gain members. The
-- file cannot be edited (additive-only), so the correction goes in the object
-- comment, which does travel.
comment on function public.accept_invite(uuid) is
  'Flips the CALLER''S OWN pending organisation_memberships row from ''invited'' to ''active'' and stamps joined_at, then audits it as ''membership.accepted''. The only sanctioned path for that transition -- the client-facing UPDATE policy refuses it for everyone including the invitee. Ownership is enforced as user_id = auth.uid() in the lookup itself; a row that does not exist and a row belonging to someone else raise the identical error. REFUSES A SOFT-DELETED (SUSPENDED) ORGANISATION, and the reason recorded in the body''s inline comment is now half wrong: it says such a membership would be "of an organisation the user can never see", which stopped being true at 20260828210000 (DECISIONS-QUEUE § Q6 -- suspension is read-only, members DO see their own CRM). The refusal stands on the other half, which is the load-bearing one: accepting an invite is a WRITE, and a suspended organisation must not gain members. 20260828220000 puts the same rule on the direct-PostgREST path beside it (organisation_memberships_insert_manage_members now also calls private.organisation_is_live()).';

comment on column public.permissions.survives_suspension is
  'True iff this permission is still held in a SOFT-DELETED (suspended) organisation. Founder decision, DECISIONS-QUEUE § Q6, 2026-08-28: suspension stops work without hiding a customer''s own data, so READ keys are true and every write key is false. DEFAULT FALSE IS DELIBERATE AND LOAD-BEARING -- a permission added by a later phase that never considers suspension gets the safe answer, and the failure mode is a suspended user missing a capability (visible, complained about) rather than a suspended user still writing (silent). Consequence: manage_organisation is false, so an Owner cannot un-suspend their own organisation -- intended, see DECISIONS-QUEUE consequence P7 and CLAUDE.md § Superuser dashboard. HOW MUCH A WRONG VALUE HERE COSTS, corrected in Task 3a fix round 1: setting this true for a WRITE key no longer opens the write, because every organisation-scoped write policy now carries a SECOND, unconditional deleted_at gate beside the permission engine -- private.crm_write_organisations() for the 25 CRM write policies, private.organisation_is_live() for the four Foundation ones (20260828220000). Before that migration the four Foundation policies had no second gate and one wrong boolean here let an Owner un-suspend their own organisation. rls_phase2_crm.sql M1g still asserts exactly one key is true today, and P11-P11d assert the second gate by disabling this one.';

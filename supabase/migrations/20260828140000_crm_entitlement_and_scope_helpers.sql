-- Phase 2 (Core CRM), Task 2 fix round 1: the helper half.
--
-- Responds to the independent review in
-- .superpowers/sdd/phase-2-core-crm/task-2-review.md. This file changes the
-- vocabulary; 20260828140500 changes the policies that use it and
-- 20260828141000 adds the audit triggers. Additive throughout -- no previously
-- applied migration is edited.
--
--   IMP-1  subscription entitlement is enforced nowhere  -> crm_write_organisations()
--   IMP-3  child tables are NOT org-immutable            -> five new dispatch branches
--   IMP-4  a soft-deleted organisation keeps everything  -> deleted_at clause, BOTH forms
--   MIN-2  20260828120000 names a helper that never shipped -> corrected on the object
--
-- ===========================================================================
-- IMP-4 FIRST, BECAUSE IT TOUCHES A FOUNDATION FUNCTION
-- ===========================================================================
-- CLAUDE.md § Superuser dashboard ships organisation suspend/reinstate and
-- delete as SOFT delete. `organisations.deleted_at` is that marker. Nothing in
-- the permission engine looked at it, so a suspended tenant was functionally
-- unsuspended at the only layer that enforces anything -- reproduced by the
-- reviewer: 8 contacts still readable and a write still accepted inside an
-- organisation whose `deleted_at` was set.
--
-- The clause goes on BOTH public.has_permission() and
-- private.permitted_organisations(), in the same migration, for the reason M1
-- exists: they are one rule in two representations and the mirror test asserts
-- they agree. Moving one without the other would make M1 red, which is the
-- test working, but shipping the pair together is the point.
--
-- WHAT SUSPENSION NOW MEANS, and what it deliberately does not:
--   * No permission is held in a soft-deleted organisation. No CRM read, no
--     CRM write, no member management, no organisation rename -- everything
--     that goes through either form of the permission check closes at once.
--   * private.is_active_member() is UNCHANGED, so members still see the
--     organisation row, their own membership rows and their profiles. That is
--     deliberate and it is the same reasoning as the MFA enrolment path: the
--     app has to be able to render "this workspace is suspended" rather than a
--     blank screen or an error, and the workspace switcher has to keep working
--     so the user can move to a workspace that is not suspended.
--
-- THE CONSEQUENCE THAT MUST BE ROUTED, AND IS:
--   organisations_update_manage_organisation gates on has_permission, so once
--   an organisation is soft-deleted its own Owner can no longer clear
--   `deleted_at`. Reinstatement becomes a privileged action with no client path
--   -- and there is no superuser write policy on public.organisations yet, so
--   today reinstatement is a DBA action. That is the fail-closed direction and
--   it matches CLAUDE.md (suspend/reinstate is a superuser function, not an
--   org-owner one), but Phase 7 must ship the superuser reinstate path in the
--   same change as the suspend button or it will ship a one-way door.
--   Recorded in FOLLOW-UPS.md § Phase 7 and raised in DECISIONS-QUEUE, because
--   whether suspension means "no CRM at all" or "read-only" is a founder
--   decision and this migration implements a default.
--
-- RECURSION: public.has_permission is SECURITY INVOKER, so its new read of
-- public.organisations is subject to that table's RLS. The only SELECT policy
-- there is organisations_select_member -> private.is_active_member (DEFINER,
-- terminal). organisations_update_manage_organisation does call has_permission,
-- but it is an UPDATE policy and UPDATE policies are not applied to a SELECT,
-- so no cycle is created. Design note (h) of 20260826154304 gains one edge and
-- no cycle:
--     public.has_permission [INV] -> organisations  RLS ON
--                                    -> organisations_select_member
--                                       -> private.is_active_member [DEF]  TERMINAL
-- private.permitted_organisations is DEFINER, so its join reads with RLS off
-- and stays terminal. Verified empirically: the full suite raises no 42P17.

create or replace function public.has_permission(p_org_id uuid, p_permission text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.organisation_memberships m
    join public.role_permissions rp
      on rp.role_key = m.role
    -- IMP-4: a soft-deleted (suspended) organisation grants nothing. Mirrored
    -- character-for-character in private.permitted_organisations below; M1
    -- asserts the two agree.
    join public.organisations o
      on o.id = m.organisation_id
     and o.deleted_at is null
    where m.user_id = (select auth.uid())
      and m.organisation_id = p_org_id
      and m.status = 'active'
      and rp.permission_key = p_permission
      -- CLAUDE.md § Session security, enforced in the database: a role that
      -- requires MFA holds no permission on a session that never presented it.
      and (
        not private.role_requires_mfa(m.role)
        or private.session_is_aal2()
      )
  );
$$;

comment on function public.has_permission(uuid, text) is
  'Organisation-scoped permission check for auth.uid(). Requires an active membership of a NOT-soft-deleted p_org_id whose role grants p_permission AND -- when that role is one CLAUDE.md § Session security requires MFA for -- a session that has actually reached aal2. Returns false (never raises) for every negative case, including a NULL p_org_id: NULL is not overloaded to mean "platform level", use has_platform_permission() for that. The deleted_at clause is mirrored in private.permitted_organisations(); rls_phase2_crm.sql § M asserts the two agree.';

revoke all on function public.has_permission(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.has_permission(uuid, text) to authenticated;

create or replace function private.permitted_organisations(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.organisation_memberships m
  join public.role_permissions rp
    on rp.role_key = m.role
  -- IMP-4, mirrored from public.has_permission.
  join public.organisations o
    on o.id = m.organisation_id
   and o.deleted_at is null
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and rp.permission_key = p_permission
    and (
      not private.role_requires_mfa(m.role)
      or private.session_is_aal2()
    );
$$;

comment on function private.permitted_organisations(text) is
  'Set form of public.has_permission(): every NOT-soft-deleted organisation in which auth.uid() currently holds p_permission, including the aal2/MFA condition. Exists so a policy can say `organisation_id in (select ...)`, which the planner hoists into a per-statement InitPlan -- measured at 5210 ms -> 23 ms on a 50k-row paginated list versus the per-row form. It restates has_permission''s body; rls_phase2_crm.sql § M asserts the two agree for every user x organisation x permission, and is what catches drift. Change one, change both.';

revoke all on function private.permitted_organisations(text) from public, anon, authenticated, service_role;
grant execute on function private.permitted_organisations(text) to authenticated;

-- ---------------------------------------------------------------------------
-- IMP-1 -- crm_write_organisations()
--
-- SUBSCRIPTION ENTITLEMENT, the second of the five terms in CLAUDE.md
-- § Permissions' intersection (platform policy ∩ ENTITLEMENT ∩ role ∩ record
-- scope ∩ exception) and the one Task 2 shipped without. CLAUDE.md
-- § Subscription tiers gives Free `crm_writes: No`; the reviewer POSTed
-- artists, contacts and venues into a Free-tier organisation over real HTTP
-- and got 201 three times, rows verified present.
--
-- The argument for building it rather than recording it is the one this task
-- already made to justify the updated_at trigger, and failed to carry across:
-- the anon key ships in the browser bundle by design, so a POST reaches
-- PostgREST without touching a line of application code, and
-- lib/entitlements/policy.ts is on a path an attacker simply does not use.
-- "Entitlements are enforced server-side -- hiding UI is not enforcement" is a
-- non-negotiable rule, and the database is the only chokepoint.
--
-- IT IS INERT TODAY, DELIBERATELY, AND THAT IS THE WHOLE DESIGN.
--   public.create_organisation() writes no organisation_subscriptions row, so
--   every organisation that exists resolves to "no subscription" -- which
--   lib/entitlements/policy.ts maps to Free, whose crm_writes is false. A gate
--   without the `s.organisation_id is null` escape would therefore deny every
--   CRM write in the product to every user, immediately. The escape reads "not
--   yet billed, therefore not yet gated".
--
--   So this ships as machinery with the gate open, not as a switched-on
--   control. What it buys is that entitlement is threaded through all 25 write
--   policies NOW, while there are 25 of them and a test suite pointed at them,
--   instead of being retrofitted into a much larger schema during a billing
--   integration. Phase 7 removes the escape and backfills subscription rows in
--   the same migration; that is one clause, not thirty policies.
--
--   BECAUSE IT IS INERT, THE TEST IS THE ONLY THING THAT WILL NOTICE IF IT
--   BREAKS. rls_phase2_crm.sql § N drives it directly: it inserts a real
--   `free` subscription row for the fixture organisation, proves every CRM
--   write is then refused for every role, proves reads still work, upgrades
--   the row to `starter` and proves writes come back. Those assertions fail if
--   this function is reverted, if a policy loses its conjunct, or if a future
--   plan row flips crm_writes.
--
-- WHAT `status` MEANS HERE, and the question it raises.
--   Only `status = 'active'` counts. The other two values in the CHECK
--   constraint are 'past_due' and 'cancelled'. Treating past_due as
--   non-writing means a failed card payment freezes the CRM read-only with no
--   grace period -- which is consistent with CLAUDE.md ("Downgrading a
--   subscription makes features read-only or limited; it must never silently
--   delete data") but is a harsher product decision than that sentence
--   requires, and CLAUDE.md defines no grace period. Implemented as the
--   conservative reading, raised in DECISIONS-QUEUE rather than settled here,
--   and inert until Phase 7 in any case.
--
-- ONE FUNCTION, NOT A `crm_writes` ARGUMENT. subscription_plans carries four
-- other entitlement columns (network_publish, custom_field_limit,
-- finance_module, storage_limit_gb). None of them is a boolean gate on a CRM
-- write, and custom_field_limit is explicitly NOT expressible as a policy (it
-- is a count against a per-plan limit, and a downgrade must make existing
-- fields read-only rather than invalid -- Task 5). Generalising now would
-- invent an abstraction over one real case.
-- ---------------------------------------------------------------------------
create or replace function private.crm_write_organisations()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.organisation_memberships m
  join public.organisations o
    on o.id = m.organisation_id
   and o.deleted_at is null
  left join public.organisation_subscriptions s
    on s.organisation_id = m.organisation_id
  left join public.subscription_plans p
    on p.key = s.plan_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (
      -- No subscription row => not yet billed => not yet gated. Phase 7
      -- removes this branch in the same migration that backfills the rows.
      s.organisation_id is null
      or (s.status = 'active' and p.crm_writes)
    );
$$;

comment on function private.crm_write_organisations() is
  'Subscription entitlement (CLAUDE.md § Permissions, second term): the organisations in which auth.uid() is an active member AND the organisation''s plan permits CRM writes. Set-returning so a policy can say `organisation_id in (select ...)` and have it hoisted into one InitPlan per statement. DELIBERATELY INERT TODAY: create_organisation() writes no subscription row, so `s.organisation_id is null` -- "not yet billed, therefore not yet gated" -- matches every existing organisation. Without that branch this gate would deny every CRM write in the product. Phase 7 removes the branch and backfills in one migration; rls_phase2_crm.sql § N is what proves the machinery works while it is inert, by inserting a real free-tier row and watching every write close.';

revoke all on function private.crm_write_organisations() from public, anon, authenticated, service_role;
grant execute on function private.crm_write_organisations() to authenticated;

-- ---------------------------------------------------------------------------
-- IMP-3 -- five more branches on entity_org_unchanged()
--
-- 20260828121000 design note (e) claimed the child tables get organisation_id
-- immutability "from their tenant-scoped composite FK and from the parent
-- EXISTS instead". THAT CLAIM IS FALSE and the reviewer proved it: as an admin
-- of both organisations, one statement moved a custom_field_values row --
-- carrying its value, its id and its created_at -- from tenant A into tenant B.
--
-- Why the stated reasons do not hold:
--   * The composite FK enforces INTERNAL CONSISTENCY OF THE NEW VALUES, not
--     immutability. Change the child's organisation_id AND its parent id
--     together and the constraint is satisfied by the new pair. It refuses a
--     re-home of organisation_id ALONE, which is a much weaker statement than
--     the note made.
--   * custom_field_values has no composite FK to the entity at all -- its
--     composite FK points at the DEFINITION. Its entity side is polymorphic,
--     which is the entire subject of 20260828120500's header, and the note
--     forgot it.
--   * The parent EXISTS re-validates the NEW parent, which is exactly what a
--     caller authorised in both tenants can satisfy.
--
-- So the rule the top-level tables get ("a tenant-to-tenant record transfer
-- that passes every other control in this schema") was being applied to six
-- tables and not to five others, for a reason that was not true. Extended
-- rather than downgraded: the argument for pinning contacts is the argument
-- for pinning the row that hangs off it.
--
-- merges is not in the list because it has no UPDATE policy at all.
--
-- The names are table-shaped rather than entity-shaped ('venue_room', not
-- 'venue') because this function answers a question about a TABLE. That is
-- already true of 'custom_field_definition'. The five CRM entity_type values
-- keep their existing meaning in entity_is_visible/entity_is_manageable, which
-- are a different question and must not gain these.
-- ---------------------------------------------------------------------------
create or replace function private.entity_org_unchanged(
  p_entity_type text,
  p_id          uuid,
  p_org_id      uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_entity_type
    -- The five top-level entities.
    when 'company' then exists (
      select 1 from public.companies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'contact' then exists (
      select 1 from public.contacts e where e.id = p_id and e.organisation_id = p_org_id)
    when 'agency' then exists (
      select 1 from public.agencies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist' then exists (
      select 1 from public.artists e where e.id = p_id and e.organisation_id = p_org_id)
    when 'venue' then exists (
      select 1 from public.venues e where e.id = p_id and e.organisation_id = p_org_id)
    -- Organisation configuration.
    when 'custom_field_definition' then exists (
      select 1 from public.custom_field_definitions e where e.id = p_id and e.organisation_id = p_org_id)
    -- IMP-3: the five child/join tables that carry an UPDATE policy. Named
    -- after the TABLE, not after a CRM entity type.
    when 'contact_company' then exists (
      select 1 from public.contact_companies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist_representation' then exists (
      select 1 from public.artist_representations e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist_fee' then exists (
      select 1 from public.artist_fee_history e where e.id = p_id and e.organisation_id = p_org_id)
    when 'venue_room' then exists (
      select 1 from public.venue_rooms e where e.id = p_id and e.organisation_id = p_org_id)
    when 'custom_field_value' then exists (
      select 1 from public.custom_field_values e where e.id = p_id and e.organisation_id = p_org_id)
    else false
  end;
$$;

comment on function private.entity_org_unchanged(text, uuid, uuid) is
  'UPDATE guard: true iff the row stored under p_id (read on the statement-start snapshot, STABLE) still has organisation_id = p_org_id. Called from WITH CHECK with the NEW values, so it pins BOTH organisation_id and id immutable through the client UPDATE policies -- closing the tenant-to-tenant record transfer available to a user who holds the manage key in two organisations, which multi-org membership at MVP makes an ordinary case. Covers ELEVEN tables as of fix round 1: the five top-level entities, custom_field_definitions, and the five child/join tables with an UPDATE policy. The child tables were previously excluded on the false grounds that their composite FK made them immutable -- it enforces internal consistency of the NEW values, not immutability, and a caller authorised in both tenants can move the child and its parent reference together. Fail-closed if p_id names no row.';

revoke all on function private.entity_org_unchanged(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.entity_org_unchanged(text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- MIN-2 -- a correction that has to travel in the database
--
-- 20260828120000's header, at two places, tells the reader that record scope is
-- enforced "via private.record_in_scope() in 20260828120500". THAT FUNCTION
-- DOES NOT EXIST: it was designed, measured, and deleted before shipping
-- because a boolean helper taking a COLUMN is evaluated once per row and
-- nothing hoists it (task-2-report § 3.1; the measurement is 5210 ms versus
-- 23 ms on a fifty-row page).
--
-- The applied migration is not edited -- that is Task 1's precedent, and its
-- reasoning holds: the correction is attached to the object it is about, which
-- is the copy that travels with the database rather than with the repository.
-- ---------------------------------------------------------------------------
comment on function private.full_scope_organisations() is
  'Record scope (DECISIONS-QUEUE Q3), set form: the organisations where auth.uid()''s active role is NOT record-scoped, i.e. sees every row rather than only their own. standard_user and read_only are the record-scoped roles, written as a constant rather than as a column on public.roles so the rule is not client-readable reference data. Always used as `org_id in (select ...) or owner_user_id = (select auth.uid())` -- the owner half names a column and cannot live in a set-returning helper. Grants nothing on its own; it narrows a permission that permitted_organisations() has already granted. CORRECTION TO 20260828120000''s HEADER (lines 50 and 128): that file says record scope is enforced "via private.record_in_scope() in 20260828120500". No such function exists or ever shipped -- it was designed and then removed because a boolean helper taking a column cannot be hoisted out of a per-row filter. THIS function, plus the inline owner clause, is the mechanism; 20260828121000 design note (a) states the shape.';

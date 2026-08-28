-- Phase 2 (Core CRM), Task 2b: the RLS policy helpers the CRM policies are
-- built from. Creates no table, no policy and no grant on any table --
-- 20260828121000 does all of that and this file is its vocabulary.
--
-- Every function here lives in `private`. That is a security control, not
-- organisation: supabase/config.toml exposes only ["public", "graphql_public"]
-- through the Data API, and all five are SECURITY DEFINER, i.e. they read rows
-- with RLS switched off. In `public` an EXECUTE grant would publish each one as
-- a PostgREST RPC -- and three of them take a caller-supplied uuid and answer a
-- question about a row the caller may have no right to see. That is exactly the
-- shape of the leak 20260826154304's `private` schema block describes
-- (stored_membership_status(), which returned any membership row's status
-- cross-tenant over HTTP). The rule from that block applies unchanged: a
-- SECURITY DEFINER function belongs in `public` only if being a client-callable
-- endpoint is its actual purpose. None of these is.
--
-- ===========================================================================
-- WHY TWO OF THEM RETURN A SET INSTEAD OF A BOOLEAN
-- ===========================================================================
-- permitted_organisations() and full_scope_organisations() are the set-valued
-- inverses of the obvious per-row predicates. `has_permission(organisation_id,
-- 'view_crm')` takes a COLUMN, so it is evaluated once per row and nothing can
-- hoist it. `organisation_id in (select private.permitted_organisations(
-- 'view_crm'))` takes a CONSTANT, so the planner evaluates the subquery once
-- per statement and the per-row work collapses to a hash probe.
--
-- THE DIFFERENCE WAS MEASURED, ON THE POLICIES THIS PHASE ACTUALLY SHIPS, and
-- it is not a micro-optimisation. 50,000 contacts in one organisation, the
-- paginated list shape CLAUDE.md § Non-negotiable rules mandates
-- (`where organisation_id = $1 and deleted_at is null order by name limit 50`):
--
--   per-row form   Seq Scan, Filter: has_permission(organisation_id,'view_crm')
--                    AND private.record_in_scope(organisation_id, owner_user_id)
--                  Buffers: shared hit=401125
--                  Execution Time: 5210.502 ms
--
--   set form       Seq Scan, Filter: ANY (organisation_id = (hashed SubPlan 1))
--                    AND (ANY (organisation_id = (hashed SubPlan 2))
--                         OR owner_user_id = (InitPlan 3))
--                  Buffers: shared hit=962
--                  Execution Time: 23.281 ms
--
-- 5.2 seconds to render one page of fifty contacts, versus 23 ms. The same
-- query as `count(*)` went 5172 ms -> 13.8 ms, and the equivalent child-table
-- page (50,000 venue_rooms) went 12830 ms -> 19.6 ms. Both forms return
-- identical rows for every fixture user -- asserted, not assumed:
-- rls_phase2_crm.sql § M binds the two representations together.
--
-- PAGINATION DOES NOT RESCUE THE PER-ROW FORM, which is the thing that makes
-- this a correctness-of-design issue rather than a tuning note. `limit 50` with
-- an `order by` sorts the whole tenant's rows before it can take fifty, so the
-- policy is evaluated on every row either way. Only a primary-key fetch escapes
-- it (measured at 0.78 ms in both forms).
--
-- ===========================================================================
-- THE COST OF THE SET FORM: ONE RULE, TWO REPRESENTATIONS
-- ===========================================================================
-- permitted_organisations() is public.has_permission() with the organisation
-- pin removed, and it necessarily restates that function's body -- including
-- the MFA gate 20260827210000 added. Two copies of a security rule is exactly
-- the drift risk that migration's own header warns about for
-- role_requires_mfa() and lib/auth/mfa-gate.ts's MFA_REQUIRED_ROLES.
--
-- It is handled the same way that pair is: a LIVE MIRROR TEST rather than a
-- comment. rls_phase2_crm.sql § M asserts, for every fixture user x every
-- organisation x all six CRM permission keys, that
--
--     public.has_permission(org, key)  ==  org IN permitted_organisations(key)
--
-- and fails if the two ever disagree. IF YOU CHANGE ONE, CHANGE BOTH; the test
-- is what tells you that you did not.
--
-- has_permission() is deliberately NOT reimplemented in terms of this function
-- (`select p_org_id in (select private.permitted_organisations(p_permission))`),
-- which would have removed the duplication outright. Two reasons: it is
-- SECURITY INVOKER by design and this is DEFINER, so routing it through here
-- would silently give every existing Foundation policy an RLS-free read of
-- organisation_memberships; and it is a client-callable API
-- (`grant execute ... to authenticated`), so changing what it reads is a
-- change to a published surface. Restating the body and testing the equality
-- is the smaller risk.
--
-- ===========================================================================
-- WHY SECURITY DEFINER
-- ===========================================================================
-- has_permission is SECURITY INVOKER because it only ever reads the caller's
-- OWN membership row, which the caller can always see. These read somebody
-- else's CRM row -- the entity a custom field value is filed against -- and
-- must return a correct answer whether or not that row is visible to the caller
-- under RLS. For the polymorphic dispatch that distinction is the whole point:
-- `entity_id points at a row in another tenant` must resolve to
-- FALSE-because-the-organisations-differ, not to FALSE-because-RLS-hid-it, or
-- the check stops meaning what it says.
--
-- DEFINER also makes all five TERMINAL in the recursion graph of
-- 20260826154304 design note (h): they read organisation_memberships,
-- role_permissions and the entity tables with RLS off, so no policy on those
-- tables is re-entered. The graph:
--
--   <CRM policy> -> private.permitted_organisations   [DEF] -> memberships +
--                                                      role_permissions  RLS OFF  TERMINAL
--                -> private.full_scope_organisations  [DEF] -> memberships RLS OFF TERMINAL
--                -> private.entity_is_visible         [DEF] -> entity table RLS OFF
--                     -> the two set helpers          [DEF]                TERMINAL
--                -> private.entity_is_manageable      [DEF]  (same shape)
--                -> private.entity_org_unchanged      [DEF] -> entity table RLS OFF TERMINAL
--
-- Maximum depth 3, no cycle. NOTE: the CHILD-table policies in 20260828121000
-- do name their parent table inline, which is a departure from Foundation's
-- "no table named inline in a policy" rule; that file's design note (b)
-- explains why it is safe there and what it buys.
--
-- ===========================================================================
-- MFA
-- ===========================================================================
-- permitted_organisations() carries the aal2 requirement, because it is the
-- permission check. full_scope_organisations() deliberately does not: it
-- NARROWS a permission rather than granting one, and every policy AND-s the two
-- together, so adding the gate there would only duplicate it. Same reasoning as
-- record scope generally -- scope is not authorisation.

-- ---------------------------------------------------------------------------
-- permitted_organisations(permission)
--
-- Every organisation in which the caller currently holds `permission`. The set
-- form of public.has_permission(); see the header for the equality that binds
-- them and the test that enforces it.
--
-- Returns the empty set -- never NULL, never an error -- for an unknown
-- permission key, an unauthenticated caller, a user with no memberships, and
-- an MFA-required role on a session below aal2. `x in (select <empty>)` is
-- false, so every one of those fails closed at the call site too.
-- ---------------------------------------------------------------------------
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
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and rp.permission_key = p_permission
    -- CLAUDE.md § Session security, enforced in the database: a role that
    -- requires MFA holds no permission on a session that never presented it.
    -- Character-for-character public.has_permission()'s clause; see the header.
    and (
      not private.role_requires_mfa(m.role)
      or private.session_is_aal2()
    );
$$;

comment on function private.permitted_organisations(text) is
  'Set form of public.has_permission(): every organisation in which auth.uid() currently holds p_permission, including the aal2/MFA condition. Exists so a policy can say `organisation_id in (select ...)`, which the planner hoists into a per-statement InitPlan -- measured at 5210 ms -> 23 ms on a 50k-row paginated list versus the per-row form. It restates has_permission''s body; rls_phase2_crm.sql § M asserts the two agree for every user x organisation x permission, and is what catches drift. Change one, change both.';

revoke all on function private.permitted_organisations(text) from public, anon, authenticated, service_role;
grant execute on function private.permitted_organisations(text) to authenticated;

-- ---------------------------------------------------------------------------
-- full_scope_organisations()
--
-- RECORD SCOPE, the fourth term of CLAUDE.md § Permissions' intersection
-- (platform policy ∩ entitlement ∩ role ∩ RECORD SCOPE ∩ exception), and the
-- founder-answered Q3: Standard User and Read Only see and touch only rows they
-- own; every other role sees the whole organisation.
--
-- This returns the organisations where the caller's role is NOT record-scoped.
-- The other half of the rule -- `or owner_user_id = (select auth.uid())` --
-- is written at the call site, because it names a column and cannot live here.
-- The two together are the scope predicate, and they always appear together;
-- 20260828121000 design note (a) is the single place that shape is stated.
--
-- WHY THE ROLE LIST IS A CONSTANT AND NOT A COLUMN ON public.roles
--   Same reasoning as private.role_requires_mfa (20260827210000): public.roles
--   is SELECTable by every authenticated user, so a `record_scoped boolean`
--   column would publish the rule as client-readable reference data AND make a
--   security decision editable by anyone who can write a reference-data
--   migration, without that showing up as a change to the permission engine.
--
-- AN UNOWNED ROW (owner_user_id IS NULL) IS INVISIBLE TO A SCOPED ROLE.
--   A decision, and the fail-closed one. `owner_user_id = auth.uid()` is
--   already false for a NULL owner without anything being written to make it
--   so -- but it IS a reachable state (the column is nullable, `on delete set
--   null` clears it when the owning account is deleted, and a bulk import may
--   arrive unowned), so it is decided rather than inherited:
--     * visible-to-all would mean deleting one Standard User's account silently
--       republishes every record they owned to every other Standard User;
--     * invisible means an orphaned record needs a full-scope role to see and
--       reassign, which is what "this record has no owner" should mean
--       operationally.
--   Consequence for Task 4: after an owner's account is deleted, their records
--   are visible only to Manager and above. Intended, not a bug to patch in a
--   policy. Asserted by rls_phase2_crm.sql D4 / D30.
--
-- NOTE what this function does NOT check: that the caller is a member at all is
-- implied (no membership row, no result), but nothing here checks a permission.
-- It is always AND-ed with permitted_organisations() at the call site, which is
-- where authorisation is decided.
-- ---------------------------------------------------------------------------
create or replace function private.full_scope_organisations()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.organisation_memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and m.role not in ('standard_user', 'read_only');
$$;

comment on function private.full_scope_organisations() is
  'Record scope (DECISIONS-QUEUE Q3), set form: the organisations where auth.uid()''s active role is NOT record-scoped, i.e. sees every row rather than only their own. standard_user and read_only are the record-scoped roles, written as a constant rather than as a column on public.roles so the rule is not client-readable reference data. Always used as `org_id in (select ...) or owner_user_id = (select auth.uid())` -- the owner half names a column and cannot live in a set-returning helper. Grants nothing on its own; it narrows a permission that permitted_organisations() has already granted.';

revoke all on function private.full_scope_organisations() from public, anon, authenticated, service_role;
grant execute on function private.full_scope_organisations() to authenticated;

-- ---------------------------------------------------------------------------
-- entity_is_visible(entity_type, entity_id, org_id)
-- entity_is_manageable(entity_type, entity_id, org_id)
--
-- THE POLYMORPHIC DISPATCH. This is the control SECURITY.md § 10 sends a
-- pentester to and the one 20260827232512's header names as Task 2's job:
--
--   "Task 2's write policies ... must resolve entity_id against the physical
--    table for entity_type and confirm the resolved row's organisation_id
--    matches -- an EXISTS per entity type, in a helper."
--
-- WHAT IT IS FOR
--   Three columns in this schema name a row in one of five different tables,
--   chosen by a sibling `entity_type` column: custom_field_values.entity_id,
--   merges.winner_id and merges.loser_id. No foreign key can express
--   "references whichever table this other column names", so all three are
--   unvalidated uuids -- verified in Task 1's re-review, an org A user could
--   file a custom field value against an org B contact, and the victim's own
--   parent-derived read policy would then serve that attacker-controlled jsonb
--   back to them on their own contact page.
--
--   `e.organisation_id = p_org_id` in every branch is the line that closes
--   that. It is not decoration: it is the entire point of the function. The
--   row's own organisation_id (which its foreign key to organisations makes
--   real) is compared against the resolved entity's, so a value row can only
--   ever name an entity in the tenant it claims to belong to.
--
-- WHY THESE TWO ARE STILL PER-ROW FUNCTIONS WHEN NOTHING ELSE IS
--   entity_type varies per row, so the branch cannot be chosen at plan time and
--   there is no set to hoist. The two callers -- custom_field_values and merges
--   -- are always queried through an index for one entity or one record
--   (`where entity_type = $1 and entity_id = $2`, served by
--   custom_field_values_entity_idx), so the number of rows the dispatch is
--   evaluated on is bounded by that lookup rather than by the table size. Both
--   policies additionally lead with the hoistable organisation test, so a row
--   in another tenant is discarded by a hash probe before the dispatch is
--   reached at all.
--
--   The CHILD tables with a single fixed parent type -- venue_rooms,
--   contact_companies, artist_representations, artist_fee_history -- do NOT use
--   these helpers, and used to. They now inline an EXISTS against their one
--   parent, which the planner can hoist; see 20260828121000 design note (b).
--
-- ELSE FALSE
--   An unknown entity_type -- including NULL, including 'event' before Phase 3
--   adds it to the three CHECK allowlists AND to these two CASEs -- resolves to
--   false. PHASE 3 MUST EDIT THIS FILE'S SUCCESSOR: adding 'event' to the CHECK
--   constraints without adding a branch here makes every event custom field
--   value silently unreadable and unwritable, which will look like a policy bug
--   and is this comment.
--
-- WHY TWO FUNCTIONS AND NOT ONE WITH A PERMISSION ARGUMENT
--   The permission key differs PER ENTITY TYPE, not per call site. The mapping,
--   in one place, is:
--     company | contact | agency  ->  manage_contacts
--     artist                      ->  manage_artists
--     venue                       ->  manage_venues
--     (all five)                  ->  view_crm, for the read half
--   Passing the key in from the policy would put that mapping in twelve places.
-- ---------------------------------------------------------------------------
create or replace function private.entity_is_visible(
  p_entity_type text,
  p_entity_id   uuid,
  p_org_id      uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_entity_type
    when 'company' then exists (
      select 1 from public.companies e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'contact' then exists (
      select 1 from public.contacts e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'agency' then exists (
      select 1 from public.agencies e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'artist' then exists (
      select 1 from public.artists e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'venue' then exists (
      select 1 from public.venues e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    else false
  end;
$$;

comment on function private.entity_is_visible(text, uuid, uuid) is
  'Polymorphic read dispatch: true iff p_entity_id resolves to a row of p_entity_type whose organisation_id equals p_org_id AND which the caller may read (view_crm + record scope). The organisation comparison is the control that closes the cross-tenant hole in custom_field_values.entity_id and merges.winner_id/loser_id, which no foreign key can reach -- see SECURITY.md § 10 and 20260827232512''s header. Unknown or NULL p_entity_type returns false; Phase 3 must add an ''event'' branch here at the same time it adds ''event'' to the three CHECK allowlists.';

revoke all on function private.entity_is_visible(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.entity_is_visible(text, uuid, uuid) to authenticated;

create or replace function private.entity_is_manageable(
  p_entity_type text,
  p_entity_id   uuid,
  p_org_id      uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_entity_type
    when 'company' then exists (
      select 1 from public.companies e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'contact' then exists (
      select 1 from public.contacts e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'agency' then exists (
      select 1 from public.agencies e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'artist' then exists (
      select 1 from public.artists e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_artists'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'venue' then exists (
      select 1 from public.venues e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_venues'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    else false
  end;
$$;

comment on function private.entity_is_manageable(text, uuid, uuid) is
  'Polymorphic write dispatch: true iff p_entity_id resolves to a row of p_entity_type whose organisation_id equals p_org_id AND which the caller may write. The permission key is chosen by entity type -- company/contact/agency -> manage_contacts, artist -> manage_artists, venue -> manage_venues -- so that mapping lives here rather than in twelve policies. Same organisation comparison, same reason, as entity_is_visible. Backs custom_field_values'' write policies (a Booker editing an artist fills in that artist''s custom fields via manage_artists, NOT via manage_custom_fields, which governs the DEFINITION only) and merges'' insert policy.';

revoke all on function private.entity_is_manageable(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.entity_is_manageable(text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- entity_org_unchanged(entity_type, id, org_id)
--
-- Pins organisation_id (and id itself) IMMUTABLE through the client UPDATE
-- policies on the six tables that carry a freely-writable organisation_id.
--
-- WHY THIS IS NEEDED AT ALL, given the WITH CHECK already re-evaluates the
-- permission against the NEW organisation_id:
--   That check stops a member of org A moving a row into org B when they hold
--   nothing in B. It does NOT stop someone who holds the key in BOTH -- and
--   CLAUDE.md § Tenancy model ships multi-org membership at MVP, so an admin of
--   two client organisations is an ordinary user, not a contrived one. For
--   them, `UPDATE contacts SET organisation_id = <org B>` is a tenant-to-tenant
--   record transfer that passes every other control in this schema. Task 1's
--   re-review flagged exactly this residue (RR6, "a childless parent can still
--   be re-homed at the constraint layer") and routed it here.
--
--   The CHILD tables need no such guard and do not get one: their tenant-scoped
--   composite FK already refuses re-homing in both directions (measured in
--   Task 1's fix round), and their policy refuses it before the FK is reached
--   (rls_phase2_crm.sql G6/G7 assert both layers, in that order). This function
--   covers the six tables where nothing else does -- the five top-level
--   entities plus custom_field_definitions.
--
-- HOW IT SEES THE OLD ROW (the mechanism is Foundation's, verbatim -- see
-- private.membership_update_is_permitted's header, and rls_foundation.sql
-- C9-C20 which prove it rather than asserting it):
--   WITH CHECK is evaluated against the NEW row. This function re-reads the row
--   under the SAME primary key and is STABLE, so it runs on the calling
--   statement's snapshot and a command does not see its own effects -- it reads
--   the row as it was at statement start. That holds for multi-row UPDATEs too.
--
-- FAIL-CLOSED ON A REWRITTEN PRIMARY KEY: p_id is itself the NEW value, so
-- rewriting `id` to a uuid that names no row makes EXISTS false and the update
-- is refused; rewriting it to another existing row's id is rejected by the
-- primary key. `id` is therefore immutable through these policies too, which is
-- a second thing nothing else in the schema was enforcing.
--
-- 'custom_field_definition' IS NOT ONE OF THE FIVE entity_type VALUES. It is
-- accepted here and nowhere else, because this function answers a question
-- about a table rather than about a CRM entity. Kept in the same dispatch
-- rather than given its own function so there is one place to edit when a
-- table is added.
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
    when 'custom_field_definition' then exists (
      select 1 from public.custom_field_definitions e where e.id = p_id and e.organisation_id = p_org_id)
    else false
  end;
$$;

comment on function private.entity_org_unchanged(text, uuid, uuid) is
  'UPDATE guard: true iff the row stored under p_id (read on the statement-start snapshot, STABLE) still has organisation_id = p_org_id. Called from WITH CHECK with the NEW values, so it pins BOTH organisation_id and id immutable through the client UPDATE policies -- closing the tenant-to-tenant record transfer available to a user who holds the manage key in two organisations, which multi-org membership at MVP makes an ordinary case. Child tables need no such guard: their tenant-scoped composite FK already refuses re-homing in both directions. Fail-closed if p_id names no row.';

revoke all on function private.entity_org_unchanged(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.entity_org_unchanged(text, uuid, uuid) to authenticated;

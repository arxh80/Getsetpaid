-- Phase 2 (Core CRM), Task 3a: SUSPENSION BECOMES READ-ONLY, and the
-- permission catalogue that makes that expressible.
--
-- FOUNDER DECISION, .superpowers/sdd/phase-2-core-crm/DECISIONS-QUEUE.md § Q6,
-- ANSWERED 2026-08-28: **READ-ONLY. THE DEFAULT WAS OVERRULED.**
--
-- What shipped in Task 2 fix round 1 (IMP-4, 20260828140000): a soft-deleted
-- organisation grants NOTHING. Both public.has_permission() and
-- private.permitted_organisations() carry an unconditional
-- `join public.organisations o on o.id = m.organisation_id and o.deleted_at is
-- null`, so every permission -- view_crm included -- evaluates false and a
-- suspended customer sees an empty application.
--
-- What the founder decided instead: suspension stops WORK, it does not hide a
-- customer's own records from them. Reads stay open; every write closes. A
-- customer suspended for non-payment who cannot reach their own contact list is
-- a customer mid-incident, not a customer mid-collections -- and CLAUDE.md
-- § Legal is the harder constraint: a data subject's access rights do not pause
-- because their organisation's card was declined.
--
-- ===========================================================================
-- WHY A CATALOGUE TABLE AND NOT A STRING LITERAL
-- ===========================================================================
-- The one-line version of this change is:
--
--     and (o.deleted_at is null or p_permission = 'view_crm')   -- REJECTED
--
-- It is rejected. There are eight permission keys today and Phases 3-10 add
-- more -- view_events, view_finance, view_network. Every one of them is a read
-- that must survive suspension, and under that shape every one of them is a
-- line somebody has to remember to add to a string literal buried in two
-- function bodies, twice, identically. The failure mode is silent and it points
-- at a suspended customer losing access to data they are entitled to see.
--
-- So the property gets a place to live. `role_permissions.permission_key` has
-- been free text since Foundation, which said so in as many words
-- (20260826151656 line 104: "Permission keys are free-text at this stage (no
-- separate permissions catalogue table exists yet)"), and Phase 2's own
-- 20260828120000_crm_permission_catalogue.sql is named for a catalogue it never
-- built -- it only seeds grants. This migration builds it, because this
-- decision needs somewhere to record a per-permission property and there was
-- nowhere.
--
-- `survives_suspension boolean not null DEFAULT FALSE` is the load-bearing
-- part. A permission added in Phase 5 by someone who never reads this file gets
-- the safe answer -- it does not survive suspension -- and the wrong outcome is
-- "a suspended user cannot do something they could have", which is visible and
-- complained about, rather than "a suspended user can still write", which is
-- silent. New permissions arrive denied. Opening one is a deliberate act with a
-- diff.
--
-- ===========================================================================
-- THE CONSEQUENCE THAT IS NOT A BUG (DECISIONS-QUEUE consequence P7)
-- ===========================================================================
-- `manage_organisation` is a write, so it is false in a suspended organisation,
-- so AN OWNER CANNOT UN-SUSPEND THEIR OWN ORGANISATION. That is intended.
-- Suspension is a superuser action under CLAUDE.md § Superuser dashboard, with
-- step-up re-auth and admin notification; a self-service undo would make the
-- control meaningless. Do not add a "the Owner can always X" branch here.
-- Reinstatement stays a privileged path Phase 7 must ship alongside the
-- suspend button (FOLLOW-UPS.md § Phase 7).
--
-- ===========================================================================
-- WHAT DOES *NOT* CHANGE, AND WHY EACH ONE IS RIGHT
-- ===========================================================================
--   * private.crm_write_organisations() keeps its UNCONDITIONAL
--     `o.deleted_at is null`. It is the subscription-entitlement gate and it is
--     reached from 25 policies, all of them INSERT/UPDATE/DELETE and not one of
--     them `for select` (verified against pg_policies, not assumed). Leaving
--     the clause there makes the write half of this decision doubly enforced:
--     a suspended organisation is absent from crm_write_organisations() AND
--     absent from permitted_organisations('manage_*'). Either alone would
--     close the write.
--   * private.full_scope_organisations() has no deleted_at clause and gains
--     none. It is a record-scope narrower, always AND-ed with
--     permitted_organisations() at the call site, and it grants nothing on its
--     own -- the suspension check arrives from the term beside it.
--   * private.is_active_member() is unchanged, which is what keeps a suspended
--     organisation's own row, its membership rows and its subscription row
--     readable to its members. Without that the workspace switcher breaks and
--     the read-only state is unreachable.
--   * public.accept_invite() keeps its own `deleted_at is not null` refusal. It
--     is a WRITE (it activates a membership) and a suspended organisation must
--     not gain members.
--
-- ===========================================================================
-- RECURSION AND VISIBILITY -- public.has_permission is SECURITY INVOKER
-- ===========================================================================
-- has_permission reads its tables under the CALLER's RLS. It already reads
-- public.role_permissions and public.organisations that way. public.permissions
-- therefore needs a permissive SELECT policy and a SELECT grant for
-- `authenticated`, or has_permission would return false for everyone -- a
-- total lockout, fail-closed but total. It is modelled exactly on
-- public.roles / public.role_permissions, which are already
-- authenticated-readable reference data: RLS on, one `using (true)` SELECT
-- policy, SELECT granted to authenticated and to nobody else.
--
-- No cycle is introduced. The policy on public.permissions calls no function,
-- so design note (h) of 20260826154304 gains one TERMINAL edge:
--     public.has_permission [INV] -> permissions  RLS ON
--                                    -> permissions_select_authenticated
--                                       -> using (true)   TERMINAL
-- private.permitted_organisations is SECURITY DEFINER and owned by postgres,
-- so its join reads with RLS off.
--
-- ===========================================================================
-- MIGRATION DISCIPLINE
-- ===========================================================================
-- Additive only. No previously applied migration is edited -- including the
-- unapplied Phase 2 ones -- because `supabase db push` skips a version the
-- remote already records, so an in-place amendment can never reach a database
-- that already ran it (DECISIONS-QUEUE § Q9). `create or replace function`
-- throughout. `create or replace policy` DOES NOT EXIST in Postgres (42601);
-- nothing here needs it, but the note stays because two earlier briefs got it
-- wrong.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE CATALOGUE
-- ---------------------------------------------------------------------------
create table public.permissions (
  key                 text primary key,
  survives_suspension boolean not null default false,
  description         text    not null,
  created_at          timestamptz not null default now()
);

comment on table public.permissions is
  'Catalogue of every organisation-scoped permission key in the product. Foundation left permission_key free text (20260826151656 line 104); this table closes that, and public.role_permissions.permission_key now references it. THE COLUMN THAT MATTERS IS survives_suspension: DECISIONS-QUEUE § Q6 (founder, 2026-08-28) makes suspension READ-ONLY rather than a lockout, so public.has_permission() and private.permitted_organisations() join here and admit a soft-deleted organisation only for keys marked true. Adding a permission is one INSERT here plus the role_permissions grants; the default is FALSE, so a key added without thinking about suspension arrives closed rather than open.';

comment on column public.permissions.key is
  'The permission key as it appears in public.role_permissions.permission_key and in every has_permission()/permitted_organisations() call site. Free text with a primary key rather than an enum, so a phase can add one in a data migration without an ALTER TYPE.';

comment on column public.permissions.survives_suspension is
  'True iff this permission is still held in a SOFT-DELETED (suspended) organisation. Founder decision, DECISIONS-QUEUE § Q6, 2026-08-28: suspension stops work without hiding a customer''s own data, so READ keys are true and every write key is false. DEFAULT FALSE IS DELIBERATE AND LOAD-BEARING -- a permission added by a later phase that never considers suspension gets the safe answer, and the failure mode is a suspended user missing a capability (visible, complained about) rather than a suspended user still writing (silent). Consequence: manage_organisation is false, so an Owner cannot un-suspend their own organisation -- intended, see DECISIONS-QUEUE consequence P7 and CLAUDE.md § Superuser dashboard.';

comment on column public.permissions.description is
  'What the key permits, in one line. Reference data for humans, not consumed by any policy.';

alter table public.permissions enable row level security;

-- Reference data, same posture as public.roles and public.role_permissions:
-- readable by any authenticated session, writable by nobody through the API.
-- It has to be readable, because public.has_permission() is SECURITY INVOKER
-- and joins it -- see the header.
create policy permissions_select_authenticated
  on public.permissions
  for select
  to authenticated
  using (true);

comment on policy permissions_select_authenticated on public.permissions is
  'Catalogue reference data, readable by any authenticated session -- identical posture to roles_select_authenticated and role_permissions_select_authenticated. IT IS NOT OPTIONAL: public.has_permission() is SECURITY INVOKER and joins this table, so withdrawing this policy makes has_permission() return false for every user in the product. No INSERT/UPDATE/DELETE policy exists, so the catalogue is migration-only.';

-- 20260827232507 set the schema default to "new tables arrive with no grants",
-- so the SELECT grant is explicit and is the whole ACL.
revoke all on public.permissions from public, anon, authenticated, service_role;
grant select on public.permissions to authenticated;

-- ---------------------------------------------------------------------------
-- 2. SEED -- all eight keys that exist today.
--
-- view_crm is the ONLY one that survives suspension. The other seven are
-- writes: four CRM manage keys, the merge key, and Foundation's two
-- organisation-administration keys.
--
-- Seeded BEFORE the foreign key is added, or the constraint fails on the
-- 31 existing role_permissions rows.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, survives_suspension, description) values
  -- The one read key in the product today.
  ('view_crm',             true,
   'Read the CRM: SELECT on every Phase 2 entity table, narrowed by record scope. The only key that survives suspension (DECISIONS-QUEUE Q6) -- a suspended organisation stays readable to its own members.'),

  -- Writes. Every one of these closes the moment deleted_at is set.
  ('manage_contacts',      false,
   'Write companies, contacts, agencies and the contact<->company link. The relationship layer moves together in practice, so it shares one key.'),
  ('manage_artists',       false,
   'Write artists, artist representations and artist fee history.'),
  ('manage_venues',        false,
   'Write venues and venue rooms.'),
  ('manage_custom_fields', false,
   'Define custom fields (the definition, not the value). Owner/Admin only -- a definition is schema, and schema changes are an admin act.'),
  ('merge_records',        false,
   'Run a duplicate merge and write the merges audit row.'),

  -- Foundation's two organisation keys (20260826202023_reference_data.sql).
  ('manage_members',       false,
   'Invite, update and remove organisation memberships.'),
  ('manage_organisation',  false,
   'Rename the organisation and edit its settings. FALSE ON PURPOSE: this is the key that would let an Owner clear their own organisation''s deleted_at, and suspension is a superuser action, not a self-service one (DECISIONS-QUEUE consequence P7).')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. THE FOREIGN KEY
--
-- ON DELETE RESTRICT (the default) is right: removing a permission that roles
-- still grant should be loud, not a silent revocation of a capability across
-- every role that held it. ON UPDATE is left at NO ACTION for the same reason
-- -- renaming a key in place would silently rewrite grants.
--
-- CLAUDE.md § Non-negotiable rules: index every foreign key. permission_key is
-- the TRAILING column of role_permissions' composite primary key, so the PK
-- index cannot serve a lookup by permission_key alone -- which is exactly the
-- lookup this FK forces on every DELETE from public.permissions, and exactly
-- the lookup has_permission()/permitted_organisations() now perform.
-- ---------------------------------------------------------------------------
create index role_permissions_permission_key_idx
  on public.role_permissions (permission_key);

comment on index public.role_permissions_permission_key_idx is
  'Covers role_permissions.permission_key -> permissions.key. permission_key is the TRAILING column of the (role_key, permission_key) primary key, so the PK index cannot answer a lookup by permission_key alone; without this, a DELETE from public.permissions seq-scans role_permissions and the referential check on the join in has_permission() has no index to fall back on.';

alter table public.role_permissions
  add constraint role_permissions_permission_key_fkey
  foreign key (permission_key) references public.permissions (key);

comment on constraint role_permissions_permission_key_fkey on public.role_permissions is
  'Closes the free-text permission_key Foundation shipped with (20260826151656: "Permission keys are free-text at this stage"). A grant naming a key with no catalogue row is now rejected at write time instead of silently granting nothing -- and, since Q6, instead of silently inheriting the WRONG suspension behaviour, because a key absent from the catalogue is also absent from the join in has_permission().';

-- ---------------------------------------------------------------------------
-- 4. THE TWO FUNCTIONS -- one rule, two representations, changed together.
--
-- They must stay semantically identical. rls_phase2_crm.sql § M (the M1 mirror
-- test) is what asserts that against the live database, over every user x
-- {aal1,aal2} x every organisation x nine keys -- and § M is extended by this
-- task with M1b, the same sweep run against a genuinely SUSPENDED organisation,
-- because M1 as it stood could not see this clause at all: no organisation is
-- soft-deleted at the point M1 runs, so the deleted_at join was dead code for
-- the whole sweep.
--
-- The join is written IDENTICALLY in both bodies, deliberately, so a diff of
-- the two is empty on the part that matters.
-- ---------------------------------------------------------------------------
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
    -- Q6: the catalogue decides whether this key survives suspension.
    -- Mirrored character-for-character in private.permitted_organisations
    -- below; M1/M1b assert the two agree, M1b with an organisation actually
    -- soft-deleted.
    join public.permissions perm
      on perm.key = rp.permission_key
    join public.organisations o
      on o.id = m.organisation_id
     and (o.deleted_at is null or perm.survives_suspension)
    where m.user_id = (select auth.uid())
      and m.organisation_id = p_org_id
      and m.status = 'active'
      and rp.permission_key = p_permission
      -- CLAUDE.md § Session security, enforced in the database: a role that
      -- requires MFA holds no permission on a session that never presented it.
      -- This composes WITH suspension rather than being replaced by it -- an
      -- aal1 Owner of a suspended organisation still holds nothing.
      and (
        not private.role_requires_mfa(m.role)
        or private.session_is_aal2()
      )
  );
$$;

comment on function public.has_permission(uuid, text) is
  'Organisation-scoped permission check for auth.uid(). Requires an active membership of p_org_id whose role grants p_permission AND -- when that role is one CLAUDE.md § Session security requires MFA for -- a session that has actually reached aal2. SUSPENSION IS READ-ONLY, NOT A LOCKOUT (founder decision, DECISIONS-QUEUE § Q6, 2026-08-28): if p_org_id is soft-deleted, the key is held only when public.permissions.survives_suspension is true for it, which today means view_crm and nothing else. That property lives in a catalogue table rather than in a string literal here, because every later phase adds read keys and a literal is a line someone has to remember to edit in two function bodies. Returns false (never raises) for every negative case, including a NULL p_org_id: NULL is not overloaded to mean "platform level", use has_platform_permission() for that. The whole body is mirrored in private.permitted_organisations(); rls_phase2_crm.sql § M asserts the two agree, including against a suspended organisation.';

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
  -- Q6, mirrored from public.has_permission.
  join public.permissions perm
    on perm.key = rp.permission_key
  join public.organisations o
    on o.id = m.organisation_id
   and (o.deleted_at is null or perm.survives_suspension)
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and rp.permission_key = p_permission
    and (
      not private.role_requires_mfa(m.role)
      or private.session_is_aal2()
    );
$$;

comment on function private.permitted_organisations(text) is
  'Set form of public.has_permission(): every organisation in which auth.uid() currently holds p_permission, including the aal2/MFA condition and the Q6 suspension rule -- a soft-deleted organisation appears only for keys whose public.permissions.survives_suspension is true (today: view_crm). Exists so a policy can say `organisation_id in (select ...)`, which the planner hoists into a per-statement InitPlan -- measured at 5210 ms -> 23 ms on a 50k-row paginated list versus the per-row form. It restates has_permission''s body; rls_phase2_crm.sql § M asserts the two agree for every user x organisation x permission, live AND suspended, and is what catches drift. Change one, change both.';

revoke all on function private.permitted_organisations(text) from public, anon, authenticated, service_role;
grant execute on function private.permitted_organisations(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. CORRECTIONS THAT HAVE TO TRAVEL IN THE DATABASE
--
-- 20260828140000's comments on the two functions above are replaced by the
-- ones written here, so that is handled. What is NOT is the comment on
-- crm_write_organisations(), which is still accurate, and the FOUNDATION
-- comment on role_permissions, which now understates the schema: it says
-- permission_key "has no catalogue table yet". It does now.
-- ---------------------------------------------------------------------------
comment on table public.role_permissions is
  'Grants a permission_key to a role_key. SUPERSEDES the Foundation comment "permission_key has no catalogue table yet": since Phase 2 Task 3a (20260828210000) permission_key references public.permissions (key), which is also where public.permissions.survives_suspension records whether the key is still held in a soft-deleted organisation (DECISIONS-QUEUE § Q6). Adding a permission is two steps now: the catalogue row first, then the grants.';

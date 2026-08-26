-- Foundation phase, Task 4: permission engine + Row Level Security.
--
-- Depends on 20260826151656_foundation_schema.sql, which created the eight
-- Foundation tables deliberately without RLS. This migration:
--
--   1. Creates the permission-engine functions (has_permission,
--      has_platform_permission, is_active_member, shares_active_organisation).
--   2. Creates the two privileged write paths (create_organisation,
--      log_audit_event) that exist because RLS blocks the corresponding
--      direct client writes entirely.
--   3. Enables RLS on all eight tables and creates the policies.
--   4. Fixes table/function GRANTs, which are a *separate* control from RLS:
--      RLS decides which rows are visible once a table is reachable at all,
--      GRANTs decide whether it is reachable. See SECURITY.md s2.
--
-- ===========================================================================
-- Design notes -- read before changing anything in this file
-- ===========================================================================
--
-- (a) SECURITY INVOKER vs SECURITY DEFINER.
--     SECURITY.md s2 requires SECURITY DEFINER only "where necessary, with
--     search_path locked and EXECUTE restricted; every one is reviewed
--     individually". Four functions here are DEFINER and each has a specific
--     reason:
--       - is_active_member / shares_active_organisation: they are called FROM
--         the RLS policies on public.organisation_memberships itself. A policy
--         on a table that sub-queries that same table under RLS raises
--         Postgres error 42P17 "infinite recursion detected in policy for
--         relation". Running the membership lookup with RLS bypassed is the
--         standard, and here the only, way to break that cycle. Both are
--         read-only, both are anchored to auth.uid() internally, and neither
--         accepts a caller-supplied identity.
--       - create_organisation: a brand-new user has no membership anywhere, so
--         they cannot satisfy has_permission() for their own first org, and
--         public.organisations has no INSERT policy at all. This function is
--         the single sanctioned bypass.
--       - log_audit_event: public.audit_events has no INSERT policy for any
--         client role, by design (SECURITY.md s7, "append-only from the
--         application"). This function is the only write path.
--
--     has_permission and has_platform_permission are SECURITY INVOKER. They
--     only ever read the caller's own membership rows, which the caller can
--     always see under the "select own rows" policy below, so no elevated
--     privilege is needed and none is taken.
--
-- (b) NULL organisation_id is NOT overloaded to mean "platform level".
--     The task brief floated has_permission(NULL, 'view_audit_log') for the
--     platform-superuser check. That is rejected here. In SQL, NULL means
--     "unknown", and a security predicate that turns an accidental NULL --
--     an unset variable, a nullable column, a missing route param -- into a
--     *platform-wide* grant is failing open on exactly the input most likely
--     to arrive by mistake. Instead:
--       - has_permission(NULL, ...) returns false, always, fail-closed.
--       - has_platform_permission(permission) is a separate, explicitly named
--         function for org-independent checks.
--
-- (c) The platform_superuser role is not assignable through the Data API.
--     public.organisation_memberships.role is FK-constrained to public.roles,
--     which includes 'platform_superuser', and that role is the one that grants
--     'view_audit_log' -- i.e. read access to every organisation's audit trail.
--     Without a guard, any org owner/admin (who by definition holds
--     'manage_members') could simply UPDATE their own membership row to
--     role='platform_superuser' and read the whole platform's audit log. That
--     is a cross-tenant breakout, so the membership INSERT/UPDATE/DELETE
--     policies below refuse to create, modify or remove a platform_superuser
--     row. Granting that role is a migration/DBA action only.
--
-- (d) RLS is enabled but NOT forced. The eight tables are owned by `postgres`,
--     and a table owner is exempt from its own RLS unless FORCE ROW LEVEL
--     SECURITY is set. That exemption is what lets the SECURITY DEFINER
--     functions above do their job; forcing RLS would break them. No client
--     role (anon/authenticated) is a table owner, so this does not weaken the
--     tenant boundary.
--
-- (e) GRANTs are the outer gate, and this project does not auto-expose new
--     tables (see supabase/config.toml, `auto_expose_new_tables` unset). After
--     Task 3, all eight tables had only the residual TRUNCATE/REFERENCES/
--     TRIGGER/MAINTAIN privileges that Supabase's default ACL hands to
--     anon/authenticated/service_role -- no SELECT/INSERT/UPDATE/DELETE at
--     all. Those residual privileges are revoked here (anon holding TRUNCATE
--     on every tenant table is not a privilege anyone intended to grant), and
--     DML is granted back narrowly, matching the policy shape exactly: a table
--     gets an INSERT grant only if it has an INSERT policy, and so on.
--
--     service_role is deliberately granted nothing. It bypasses RLS entirely,
--     nothing in the Foundation phase needs it, and leaving it ungranted means
--     a leaked service key is not, by itself, a read of every tenant's data.
--     If a future server-side path genuinely needs RLS bypass, grant it
--     narrowly and deliberately in that task's migration.
--
-- (f) organisations UPDATE requires 'manage_organisation', not merely active
--     membership. This is a DELIBERATE DEVIATION from the task brief, which
--     specified "SELECT/UPDATE only if an active membership exists". That shape
--     was tested empirically and is unsafe: public.organisations carries
--     `deleted_at`, so "UPDATE if you are a member" means a Read Only or
--     Standard User can soft-delete the entire tenant, and rename it. Confirmed
--     against the draft policy -- an active standard_user set
--     name + deleted_at on an org they did not own, 1 row updated.
--
--     'manage_organisation' is a new permission key, seeded to owner and admin
--     (supabase/seed.sql). SELECT is unchanged: any active member reads.
--
-- (g) organisation_subscriptions writes are platform-superuser-only. Also a
--     deviation in letter from the brief's `has_permission(org_id,
--     'manage_billing')` -- but not in spirit: the brief's own parenthetical
--     says "scoped to platform superuser only for now (no payment webhook
--     handler exists yet in this phase)". The draft implemented the org-scoped
--     half and dropped the superuser scoping, which was tested empirically and
--     is an entitlement bypass: 'manage_billing' is seeded to `owner`, and an
--     owner INSERTing (plan_id='pro', status='active') for their own org is
--     free Pro, enforced nowhere else. Confirmed against the draft policy --
--     1 row inserted.
--
--     The check is has_platform_permission('manage_billing'), which is
--     org-independent by design: superuser billing overrides span orgs
--     (CLAUDE.md, "Superuser dashboard" -> Billing overrides). The step-up
--     re-auth, mandatory reason and admin notification that CLAUDE.md requires
--     around those overrides are application-layer concerns for the superuser
--     dashboard task; this policy only decides who may write the row at all.
--
-- (h) RECURSION CALL GRAPH -- re-verify this before adding any policy.
--
--     No policy expression here names a table inline; every table access is
--     behind a function call. The graph:
--
--       is_active_member          [DEFINER] -> memberships, RLS OFF -> TERMINAL
--       shares_active_organisation[DEFINER] -> memberships, RLS OFF -> TERMINAL
--       has_permission            [INVOKER] -> memberships + role_permissions,
--                                              RLS ON  -> re-enters policies
--       has_platform_permission   [INVOKER] -> memberships + role_permissions,
--                                              RLS ON  -> re-enters policies
--
--     The property that bounds the whole graph: the two SELECT policies on
--     organisation_memberships -- the only table an INVOKER function re-enters
--     -- resolve to `user_id = auth.uid()` (no call at all) and
--     is_active_member (DEFINER, RLS off). NEITHER calls an INVOKER function.
--     role_permissions' SELECT policy is `true`. So every INVOKER path bottoms
--     out after exactly one re-entry:
--
--       <any write policy> -> has_permission
--                          -> SELECT memberships
--                             -> {auth.uid() | is_active_member[RLS off]}  DONE
--                          -> SELECT role_permissions -> true              DONE
--
--     Maximum depth 2; no policy transitively depends on itself. Empirically
--     confirmed: supabase/tests/rls_foundation.sql exercises every policy and
--     raises zero 42P17 ("infinite recursion detected in policy for relation").
--
--     THE RULE THIS IMPLIES: a SELECT policy on organisation_memberships (or
--     on role_permissions) must never call has_permission /
--     has_platform_permission, or any future SECURITY INVOKER helper that
--     reads organisation_memberships. Those two tables' read policies are the
--     base case; keep them calling DEFINER helpers or nothing.

-- ===========================================================================
-- 1. Permission engine
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- is_active_member(org_id)
-- True iff the calling user has an ACTIVE membership of that organisation.
--
-- SECURITY DEFINER: see design note (a) -- this is called from the RLS
-- policies on organisation_memberships itself and must not re-enter them.
--
-- Fail-closed on NULL by construction: EXISTS returns false (never NULL), and
-- `organisation_id = NULL` / `user_id = NULL` match no rows, so a NULL org id
-- or an unauthenticated caller both yield false rather than an error or a pass.
-- ---------------------------------------------------------------------------
create or replace function public.is_active_member(p_org_id uuid)
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
      and m.status = 'active'
  );
$$;

comment on function public.is_active_member(uuid) is
  'True iff auth.uid() has an active membership of p_org_id. SECURITY DEFINER to avoid RLS recursion when called from organisation_memberships policies; reads only the caller''s own rows.';

revoke all on function public.is_active_member(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_active_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- shares_active_organisation(user_id)
-- True iff the calling user and p_user_id are both ACTIVE members of at least
-- one organisation in common. Backs the profiles "fellow member" read policy.
--
-- SECURITY DEFINER for the same anti-recursion reason, and because the
-- correctness of the answer must not depend on whether the *other* user's
-- membership row happens to be visible to the caller under RLS.
-- ---------------------------------------------------------------------------
create or replace function public.shares_active_organisation(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organisation_memberships me
    join public.organisation_memberships them
      on them.organisation_id = me.organisation_id
    where me.user_id = (select auth.uid())
      and me.status = 'active'
      and them.user_id = p_user_id
      and them.status = 'active'
  );
$$;

comment on function public.shares_active_organisation(uuid) is
  'True iff auth.uid() and p_user_id share at least one organisation in which both memberships are active.';

revoke all on function public.shares_active_organisation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.shares_active_organisation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- has_permission(org_id, permission)
-- The organisation-scoped permission check. True iff the calling user has an
-- ACTIVE membership of that organisation AND that membership's role grants the
-- requested permission key.
--
-- SECURITY INVOKER (the default, stated explicitly for reviewability): it
-- reads only the caller's own membership row -- always visible under the
-- "select own rows" policy -- plus public.role_permissions, which is readable
-- by every authenticated user. No elevated privilege is required.
--
-- The org match is pinned on BOTH user_id and organisation_id, and
-- (organisation_id, user_id) is UNIQUE on organisation_memberships, so at most
-- one membership row is ever considered: a permission held in organisation A
-- cannot satisfy a check for organisation B.
--
-- Never raises for the "no permission" case -- no membership, wrong status,
-- unknown permission key, NULL org id, NULL permission and unauthenticated
-- caller all return false.
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
    where m.user_id = (select auth.uid())
      and m.organisation_id = p_org_id
      and m.status = 'active'
      and rp.permission_key = p_permission
  );
$$;

comment on function public.has_permission(uuid, text) is
  'Organisation-scoped permission check for auth.uid(). Requires an active membership of p_org_id whose role grants p_permission. Returns false (never raises) for every negative case, including a NULL p_org_id -- NULL is not overloaded to mean "platform level"; use has_platform_permission() for that.';

revoke all on function public.has_permission(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.has_permission(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- has_platform_permission(permission)
-- The organisation-independent counterpart, for platform-level permissions
-- such as 'view_audit_log'.
--
-- The platform_superuser role is deliberately hardcoded rather than "any role
-- that happens to grant this key in any org": that keeps the platform surface
-- explicitly non-reachable through org-scoped permissions, so seeding a normal
-- org role with a platform permission key by mistake cannot open it up. See
-- design note (c) for why no client role can assign platform_superuser.
-- ---------------------------------------------------------------------------
create or replace function public.has_platform_permission(p_permission text)
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
    where m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = 'platform_superuser'
      and rp.permission_key = p_permission
  );
$$;

comment on function public.has_platform_permission(text) is
  'Platform-level (organisation-independent) permission check. True only if auth.uid() holds an active platform_superuser membership whose role grants p_permission. platform_superuser is assignable by migration/DBA only -- the organisation_memberships write policies refuse it.';

revoke all on function public.has_platform_permission(text) from public, anon, authenticated, service_role;
grant execute on function public.has_platform_permission(text) to authenticated;

-- ===========================================================================
-- 2. Privileged write paths
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- log_audit_event(...)
-- The only write path into public.audit_events. actor_user_id is always
-- auth.uid() and is NOT a parameter: a caller must never be able to attribute
-- an audit record to another user.
--
-- EXECUTE is granted to NO client role. Its only callers are other SECURITY
-- DEFINER functions in this schema (which run as the owner and therefore have
-- EXECUTE implicitly). Exposing it as a PostgREST RPC would let any signed-in
-- user mint audit records with an arbitrary action, organisation_id and
-- before/after payload -- audit-content forgery and log pollution across every
-- tenant. Granting it out is a deliberate decision for a later task, not a
-- default.
-- ---------------------------------------------------------------------------
create or replace function public.log_audit_event(
  p_action          text,
  p_target_type     text,
  p_organisation_id uuid  default null,
  p_target_id       uuid  default null,
  p_correlation_id  uuid  default null,
  p_before          jsonb default null,
  p_after           jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
begin
  -- Defence in depth: RLS and the EXECUTE grants should already guarantee an
  -- authenticated caller, but audit_events.actor_user_id is NOT NULL and an
  -- unattributable audit record is worse than a failed write.
  if v_actor is null then
    raise exception 'log_audit_event: no authenticated user (auth.uid() is null)'
      using errcode = '28000';
  end if;

  if p_action is null or pg_catalog.btrim(p_action) = '' then
    raise exception 'log_audit_event: action is required' using errcode = '22023';
  end if;

  if p_target_type is null or pg_catalog.btrim(p_target_type) = '' then
    raise exception 'log_audit_event: target_type is required' using errcode = '22023';
  end if;

  insert into public.audit_events (
    organisation_id, actor_user_id, action, target_type,
    target_id, correlation_id, before, after
  )
  values (
    p_organisation_id,
    v_actor,
    p_action,
    p_target_type,
    p_target_id,
    coalesce(p_correlation_id, pg_catalog.gen_random_uuid()),
    p_before,
    p_after
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.log_audit_event(text, text, uuid, uuid, uuid, jsonb, jsonb) is
  'Sole write path into public.audit_events (which has no INSERT policy). actor_user_id is forced to auth.uid() and cannot be supplied by the caller. EXECUTE is intentionally granted to no client role -- callers are other SECURITY DEFINER functions.';

revoke all on function public.log_audit_event(text, text, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- create_organisation(name, slug)
-- The only sanctioned way to create an organisation. public.organisations has
-- no INSERT policy, and a user with no membership anywhere cannot satisfy
-- has_permission(org, 'manage_members') to insert their own first membership
-- row -- so both inserts have to happen here, under SECURITY DEFINER.
--
-- Atomic by construction: a function body runs inside the caller's
-- transaction, and nothing below catches an exception, so any failure rolls
-- back the organisation, the membership and the audit record together.
-- ---------------------------------------------------------------------------
create or replace function public.create_organisation(p_name text, p_slug text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_name  text := pg_catalog.btrim(coalesce(p_name, ''));
  v_slug  text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, '')));
  v_org   uuid;
begin
  -- Defence in depth: this function bypasses RLS, so it re-checks the one
  -- thing RLS would otherwise have guaranteed.
  if v_actor is null then
    raise exception 'create_organisation: no authenticated user (auth.uid() is null)'
      using errcode = '28000';
  end if;

  if v_name = '' then
    raise exception 'create_organisation: name is required' using errcode = '22023';
  end if;

  -- Slugs address organisations in URLs; constrain the shape here rather than
  -- accepting whatever a client sends into a user-facing identifier.
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.length(v_slug) < 2 or pg_catalog.length(v_slug) > 63 then
    raise exception 'create_organisation: slug must be 2-63 chars of lowercase letters, digits and single hyphens (got %)', p_slug
      using errcode = '22023';
  end if;

  insert into public.organisations (name, slug)
  values (v_name, v_slug)
  returning id into v_org;

  insert into public.organisation_memberships
    (organisation_id, user_id, role, status, joined_at)
  values
    (v_org, v_actor, 'owner', 'active', now());

  perform public.log_audit_event(
    p_action          => 'organisation.created',
    p_target_type     => 'organisation',
    p_organisation_id => v_org,
    p_target_id       => v_org,
    p_after           => pg_catalog.jsonb_build_object('name', v_name, 'slug', v_slug)
  );

  return v_org;
end;
$$;

comment on function public.create_organisation(text, text) is
  'Creates an organisation plus the caller''s owner membership atomically, and audits it. The only sanctioned path -- public.organisations has no INSERT policy.';

revoke all on function public.create_organisation(text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_organisation(text, text) to authenticated;

-- ===========================================================================
-- 3. Row Level Security
-- ===========================================================================

alter table public.profiles                   enable row level security;
alter table public.organisations              enable row level security;
alter table public.organisation_memberships   enable row level security;
alter table public.roles                      enable row level security;
alter table public.role_permissions           enable row level security;
alter table public.subscription_plans         enable row level security;
alter table public.organisation_subscriptions enable row level security;
alter table public.audit_events               enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- Own row: read and update. Fellow members of a shared organisation: read only.
-- No INSERT and no DELETE policy: profile rows are provisioned alongside the
-- auth.users row (Task 6) and removed by that table's ON DELETE CASCADE.
-- ---------------------------------------------------------------------------
create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using ( id = (select auth.uid()) );

create policy "profiles_select_shared_organisation"
  on public.profiles for select to authenticated
  using ( public.shares_active_organisation(id) );

-- WITH CHECK as well as USING: without it a user could rewrite the row's id
-- and hand their profile to someone else.
create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using      ( id = (select auth.uid()) )
  with check ( id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- organisations
-- Any active member reads. Only 'manage_organisation' writes. No INSERT policy
-- -- create_organisation() only. No DELETE policy -- deletion is soft-delete
-- via deleted_at, i.e. an UPDATE.
--
-- The UPDATE gate deviates from the task brief ("UPDATE only if an active
-- membership exists"); see design note (f) -- that shape lets a Read Only
-- member soft-delete the tenant.
-- ---------------------------------------------------------------------------
create policy "organisations_select_member"
  on public.organisations for select to authenticated
  using ( public.is_active_member(id) );

create policy "organisations_update_manage_organisation"
  on public.organisations for update to authenticated
  using      ( public.has_permission(id, 'manage_organisation') )
  with check ( public.has_permission(id, 'manage_organisation') );

-- ---------------------------------------------------------------------------
-- organisation_memberships
--
-- Two permissive SELECT policies, OR'd:
--   * own rows at ANY status, so a user can see a pending 'invited' row and
--     a 'revoked' one; and
--   * everyone else's rows in an organisation the caller is active in.
--
-- Writes require 'manage_members' in the row's organisation, plus the
-- platform_superuser guard from design note (c). Note the WITH CHECK on UPDATE
-- re-evaluates has_permission against the NEW organisation_id, so a row cannot
-- be moved into an organisation the caller does not administer.
-- ---------------------------------------------------------------------------
create policy "organisation_memberships_select_own"
  on public.organisation_memberships for select to authenticated
  using ( user_id = (select auth.uid()) );

create policy "organisation_memberships_select_same_organisation"
  on public.organisation_memberships for select to authenticated
  using ( public.is_active_member(organisation_id) );

-- invited_by is the audit trail of who issued an invite. On INSERT it must be
-- the caller or nothing -- a client must not be able to attribute an invite it
-- issued to a different admin. (The guard is INSERT-only on purpose: on UPDATE
-- the NEW row still carries the ORIGINAL inviter, so the same predicate would
-- wrongly block a second admin from ever editing that membership.)
create policy "organisation_memberships_insert_manage_members"
  on public.organisation_memberships for insert to authenticated
  with check (
    public.has_permission(organisation_id, 'manage_members')
    and role <> 'platform_superuser'
    and (invited_by is null or invited_by = (select auth.uid()))
  );

create policy "organisation_memberships_update_manage_members"
  on public.organisation_memberships for update to authenticated
  using (
    public.has_permission(organisation_id, 'manage_members')
    and role <> 'platform_superuser'
  )
  with check (
    public.has_permission(organisation_id, 'manage_members')
    and role <> 'platform_superuser'
  );

create policy "organisation_memberships_delete_manage_members"
  on public.organisation_memberships for delete to authenticated
  using (
    public.has_permission(organisation_id, 'manage_members')
    and role <> 'platform_superuser'
  );

-- ---------------------------------------------------------------------------
-- roles / role_permissions
-- Seeded reference data, readable by any signed-in user (the client needs it
-- to render role pickers and to reason about entitlements). No write policy
-- for any client role: these change by migration only.
-- ---------------------------------------------------------------------------
create policy "roles_select_authenticated"
  on public.roles for select to authenticated
  using ( true );

create policy "role_permissions_select_authenticated"
  on public.role_permissions for select to authenticated
  using ( true );

-- ---------------------------------------------------------------------------
-- subscription_plans
-- Same, plus anon: the public pricing page has to render before sign-in.
-- Every column here is public pricing/entitlement data.
-- ---------------------------------------------------------------------------
create policy "subscription_plans_select_public"
  on public.subscription_plans for select to anon, authenticated
  using ( true );

-- ---------------------------------------------------------------------------
-- organisation_subscriptions
-- Any active member may read their organisation's subscription.
--
-- Writes are PLATFORM SUPERUSER ONLY, not org-scoped 'manage_billing'. This
-- row IS the entitlement (plan_id drives crm_writes / finance_module /
-- storage_limit_gb), and no payment processor or webhook handler exists yet in
-- this phase -- so an org-scoped write path is an unpaid self-upgrade to Pro
-- for anyone who signs up. See design note (g). Once billing is integrated,
-- the webhook (server-side, its own privileged path) becomes the writer and
-- this policy is revisited deliberately.
--
-- No DELETE policy -- a cancelled subscription is a status change, not a row
-- removal.
-- ---------------------------------------------------------------------------
create policy "organisation_subscriptions_select_member"
  on public.organisation_subscriptions for select to authenticated
  using ( public.is_active_member(organisation_id) );

create policy "organisation_subscriptions_insert_platform_billing"
  on public.organisation_subscriptions for insert to authenticated
  with check ( public.has_platform_permission('manage_billing') );

create policy "organisation_subscriptions_update_platform_billing"
  on public.organisation_subscriptions for update to authenticated
  using      ( public.has_platform_permission('manage_billing') )
  with check ( public.has_platform_permission('manage_billing') );

-- ---------------------------------------------------------------------------
-- audit_events
-- Read: platform superuser only -- an org owner reading their own org's audit
-- trail is a superuser-dashboard/impersonation concern, not a client one.
-- Write: no policy at all, for any operation. Inserts go through
-- log_audit_event(); the table is append-only, so UPDATE and DELETE have no
-- policy by design and are unreachable from any client role.
-- ---------------------------------------------------------------------------
create policy "audit_events_select_platform_superuser"
  on public.audit_events for select to authenticated
  using ( public.has_platform_permission('view_audit_log') );

-- ===========================================================================
-- 4. Table privileges
-- ===========================================================================
-- See design note (e). Revoke the residual default-ACL privileges, then grant
-- DML back to match the policy shape one-for-one.

revoke all on public.profiles                   from anon, authenticated, service_role;
revoke all on public.organisations              from anon, authenticated, service_role;
revoke all on public.organisation_memberships   from anon, authenticated, service_role;
revoke all on public.roles                      from anon, authenticated, service_role;
revoke all on public.role_permissions           from anon, authenticated, service_role;
revoke all on public.subscription_plans         from anon, authenticated, service_role;
revoke all on public.organisation_subscriptions from anon, authenticated, service_role;
revoke all on public.audit_events               from anon, authenticated, service_role;

-- profiles: select own + fellow members, update own.
grant select, update on public.profiles to authenticated;

-- organisations: select + update for active members; no insert (function only),
-- no delete (soft-delete is an update).
grant select, update on public.organisations to authenticated;

-- organisation_memberships: full DML, gated by the policies above.
grant select, insert, update, delete on public.organisation_memberships to authenticated;

-- Reference data: read-only.
grant select on public.roles            to authenticated;
grant select on public.role_permissions to authenticated;

-- Pricing catalogue: read-only, and readable logged-out.
grant select on public.subscription_plans to anon, authenticated;

-- Subscriptions: no delete grant, matching the absent DELETE policy.
grant select, insert, update on public.organisation_subscriptions to authenticated;

-- audit_events: SELECT only. No INSERT/UPDATE/DELETE grant to any client role
-- -- writes go through log_audit_event(), and the table is append-only.
grant select on public.audit_events to authenticated;

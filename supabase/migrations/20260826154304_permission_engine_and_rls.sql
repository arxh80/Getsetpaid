-- Foundation phase, Task 4: permission engine + Row Level Security.
--
-- Depends on 20260826151656_foundation_schema.sql, which created the eight
-- Foundation tables deliberately without RLS. This migration:
--
--   1. Creates the `private` schema -- not exposed through the Data API -- and
--      the RLS policy helpers that live in it (is_active_member,
--      shares_active_organisation, has_platform_permission,
--      membership_update_is_permitted, log_audit_event).
--   2. Creates the two `public` functions that are genuinely client-facing:
--      has_permission (SECURITY INVOKER, self-scoped) and create_organisation
--      (the sanctioned org-creation RPC).
--   3. Creates public.platform_admins, the platform-superuser allowlist.
--   4. Enables RLS on all nine tables and creates the policies.
--   5. Fixes table/function GRANTs, which are a *separate* control from RLS:
--      RLS decides which rows are visible once a table is reachable at all,
--      GRANTs decide whether it is reachable. See SECURITY.md s2.
--
-- SCHEMA PLACEMENT IS A SECURITY CONTROL HERE, not organisation. See the
-- `private` schema block in section 1 before moving anything between schemas.
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
--       - has_platform_permission: public.platform_admins has RLS enabled with
--         no policies and no client GRANT, so an INVOKER version would raise
--         42501 rather than returning false for every ordinary user. See its
--         own header comment.
--
--       - membership_update_is_permitted: called from the UPDATE policy ON
--         organisation_memberships and reads organisation_memberships. Same
--         42P17 reason as is_active_member.
--
--     public.has_permission is SECURITY INVOKER. It only ever reads the
--     caller's own membership rows, which the caller can always see under the
--     "select own rows" policy below, so no elevated privilege is needed and
--     none is taken. That, plus being useful to the app ("may I do X?"), is why
--     it is the one permission helper that stays in `public`.
--
--     EVERY SECURITY DEFINER helper above lives in `private`, which the Data
--     API does not route to. A DEFINER function reads with RLS off, so in
--     `public` an EXECUTE grant publishes it as an HTTP endpoint -- which is
--     exactly how an earlier revision of membership_update_is_permitted's
--     predecessor leaked arbitrary rows' status cross-tenant. create_organisation
--     is the sole DEFINER function in `public`, because being a client-callable
--     endpoint is its entire purpose.
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
-- (c) The platform superuser is not reachable through the Data API at all.
--     Platform superuser status lives in public.platform_admins (see the table
--     comment and design note (i)) -- a table with no policies and no client
--     grants, writable only by migration/DBA action. There is no client write
--     path to escalate through.
--
--     The `role <> 'platform_superuser'` guards on the membership write
--     policies below are retained as defence in depth. They are currently dead
--     code -- 'platform_superuser' is no longer seeded into public.roles, so
--     the FK on organisation_memberships.role already rejects it -- but they
--     cost nothing and they hold if that key is ever re-introduced to the roles
--     catalogue for an unrelated reason.
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
--     in 20260826202023_reference_data.sql. SELECT is unchanged: any active
--     member reads.
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
--       private.is_active_member               [DEF] -> memberships     RLS OFF  TERMINAL
--       private.shares_active_organisation     [DEF] -> memberships     RLS OFF  TERMINAL
--       private.has_platform_permission        [DEF] -> platform_admins RLS OFF  TERMINAL
--       private.membership_update_is_permitted [DEF] -> memberships     RLS OFF  TERMINAL
--       public.has_permission                  [INV] -> memberships + role_permissions
--                                                       RLS ON -> re-enters policies
--
--     private.membership_update_is_permitted is called from a policy ON
--     organisation_memberships and reads organisation_memberships -- the one
--     shape that genuinely would recurse if it were written inline as a
--     subquery instead of behind a DEFINER function. It is the clearest
--     illustration of why the rule at the end of this note exists.
--
--     has_permission is now the ONLY function in the graph that re-enters RLS
--     at all. The property that bounds it: the two SELECT policies on
--     organisation_memberships -- the only table it re-enters -- resolve to
--     `user_id = auth.uid()` (no call at all) and is_active_member (DEFINER,
--     RLS off). NEITHER calls an INVOKER function. role_permissions' SELECT
--     policy is `true`. So every INVOKER path bottoms out after exactly one
--     re-entry:
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
--     on role_permissions) must never call has_permission, or any future
--     SECURITY INVOKER helper that reads organisation_memberships. Those two
--     tables' read policies are the base case; keep them calling DEFINER
--     helpers or nothing.
--
-- (i) The platform superuser is NOT an organisation_memberships row.
--     An earlier revision of this migration modelled platform_superuser as a
--     role in the roles catalogue, held via a normal membership. That is
--     wrong, for a reason that only shows up when you look at what else a
--     membership row does: organisation_memberships.organisation_id is NOT
--     NULL, so granting the platform role required pinning the superuser to
--     some arbitrary organisation -- and that made them an ordinary active
--     member of it, with ordinary member visibility into that tenant's data,
--     through their own session, with no audit record and no impersonation
--     request.
--
--     That directly contradicts CLAUDE.md § "Superuser dashboard": "No direct
--     tenant-data access outside impersonation ... Any deeper look goes through
--     the audited, admin-approved impersonation flow." A superuser silently
--     reading one org for free because that is where their allowlist row
--     happened to live is exactly the hole that rule exists to close.
--
--     public.platform_admins carries no organisation, so there is no tenant to
--     leak. The superuser now has NO org-scoped read anywhere; every look at
--     tenant data has to go through the impersonation flow, which is where the
--     audit and the admin approval live. It also drops role_permissions out of
--     the platform path entirely, which is what makes
--     has_platform_permission terminal in note (h).

-- ===========================================================================
-- 1. Permission engine
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The `private` schema: policy helpers that must NOT be a public API.
--
-- supabase/config.toml exposes only ["public", "graphql_public"] through the
-- Data API, so nothing in here is routable as a PostgREST RPC. That matters:
-- every SECURITY DEFINER helper below reads rows with RLS switched off, and in
-- `public` an EXECUTE grant would silently publish it as an HTTP endpoint.
--
-- This is not hypothetical. An earlier revision put stored_membership_status()
-- in public and granted EXECUTE to authenticated; that made it callable over
-- HTTP with an arbitrary membership UUID, handing back the status of a row in
-- an organisation the caller had no membership in -- RLS hid the row from a
-- SELECT and the function returned its contents anyway.
--
-- THE RULE: a SECURITY DEFINER function belongs in `public` only if being a
-- client-callable API endpoint is its actual purpose (create_organisation).
-- Anything that exists to serve an RLS policy goes here.
--
-- USAGE is granted to `authenticated` because RLS policy expressions execute
-- as the querying role, so it must be able to call them. It is NOT granted to
-- anon (no anon policy calls a helper) and NOT to service_role.
-- ---------------------------------------------------------------------------
create schema if not exists private;

comment on schema private is
  'Internal helpers for RLS policies. Not exposed through the Data API (see supabase/config.toml [api] schemas). SECURITY DEFINER functions that bypass RLS live here, never in public, so an EXECUTE grant cannot turn one into an HTTP endpoint.';

revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- platform_admins
-- The platform-superuser allowlist. Membership in this table IS platform
-- superuser status; there is no role, no organisation and no tier.
--
-- This is deliberately NOT an organisation_memberships row (see design note
-- (i)). RLS is enabled with ZERO policies and no client GRANTs, so the table
-- is unreachable from anon/authenticated/service_role by any path -- it is
-- read only by has_platform_permission() below, which is SECURITY DEFINER.
-- Rows are added by migration/DBA action only.
--
-- Seeded EMPTY on purpose. There is no founder user id wired up yet, and an
-- empty allowlist is the correct, safe MVP state: nobody holds platform
-- superuser access until a later migration deliberately grants it.
-- ---------------------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.platform_admins is
  'Platform superuser allowlist. RLS enabled with no policies and no client grants -- readable only via private.has_platform_permission() (SECURITY DEFINER). Rows are added by migration/DBA action only, never by any client. Intentionally empty at MVP.';

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
create or replace function private.is_active_member(p_org_id uuid)
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

comment on function private.is_active_member(uuid) is
  'True iff auth.uid() has an active membership of p_org_id. SECURITY DEFINER to avoid RLS recursion when called from organisation_memberships policies; reads only the caller''s own rows.';

revoke all on function private.is_active_member(uuid) from public, anon, authenticated, service_role;
grant execute on function private.is_active_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- shares_active_organisation(user_id)
-- True iff the calling user and p_user_id are both ACTIVE members of at least
-- one organisation in common. Backs the profiles "fellow member" read policy.
--
-- SECURITY DEFINER for the same anti-recursion reason, and because the
-- correctness of the answer must not depend on whether the *other* user's
-- membership row happens to be visible to the caller under RLS.
-- ---------------------------------------------------------------------------
create or replace function private.shares_active_organisation(p_user_id uuid)
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

comment on function private.shares_active_organisation(uuid) is
  'True iff auth.uid() and p_user_id share at least one organisation in which both memberships are active.';

revoke all on function private.shares_active_organisation(uuid) from public, anon, authenticated, service_role;
grant execute on function private.shares_active_organisation(uuid) to authenticated;

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
-- such as 'view_audit_log'. True iff the caller is on the platform_admins
-- allowlist above.
--
-- SECURITY DEFINER, and it has to be: public.platform_admins has RLS enabled
-- with no policies and no client GRANT, so a SECURITY INVOKER version would
-- raise 42501 "permission denied for table platform_admins" for every ordinary
-- user. That error would propagate out of the RLS policies that call this
-- (audit_events SELECT, organisation_subscriptions), turning "you are not a
-- superuser, see nothing" into a hard failure. DEFINER makes the negative case
-- return false, which is what a permission predicate must do.
--
-- Read-only, anchored to auth.uid(), accepts no caller-supplied identity --
-- the same discipline as is_active_member / shares_active_organisation.
--
-- ON THE p_permission ARGUMENT -- read this before adding a platform tier.
--   It is accepted and deliberately NOT consulted. Per CLAUDE.md
--   § "Superuser dashboard" there is a single hardcoded superuser at MVP with
--   no granular platform permission tiers, so allowlist membership genuinely
--   IS the answer for every platform permission -- there is nothing to consult
--   yet. The parameter is kept so that call sites already name the permission
--   they are asserting, which means introducing real granularity later is a
--   change to THIS FUNCTION BODY ONLY, not to every policy that calls it.
--   Until then, treat has_platform_permission('anything') as "is the caller
--   the platform superuser" -- it does not verify that 'anything' was granted.
-- ---------------------------------------------------------------------------
create or replace function private.has_platform_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = (select auth.uid())
  );
$$;

comment on function private.has_platform_permission(text) is
  'Platform-level (organisation-independent) permission check: true iff auth.uid() is on the public.platform_admins allowlist. SECURITY DEFINER because platform_admins is unreadable by any client role. p_permission is accepted but NOT consulted -- at MVP there is one all-powerful superuser and no platform permission tiers; the argument exists so call sites document intent and granularity can be added in this function body alone.';

revoke all on function private.has_platform_permission(text) from public, anon, authenticated, service_role;
grant execute on function private.has_platform_permission(text) to authenticated;

-- ---------------------------------------------------------------------------
-- membership_update_is_permitted(id, organisation_id, user_id, status, joined_at)
--
-- Compares a PROPOSED membership row against the one currently STORED under the
-- same primary key, and answers whether the client-facing UPDATE policy should
-- allow it. Everything that must not change through that policy is checked
-- here, in one place, against one read of the stored row.
--
-- WHAT IT ENFORCES
--   organisation_id  IMMUTABLE via this policy
--   user_id          IMMUTABLE via this policy
--   joined_at        IMMUTABLE via this policy
--   status           may be anything EXCEPT a transition INTO 'active'
--
--   Immutable rather than allow-listed, because there is no legitimate
--   client-facing "edit" that changes which user or which organisation a
--   membership points at. Moving someone between organisations is not an edit,
--   it is revoke-and-re-invite. joined_at records acceptance and is written
--   only by the sanctioned acceptance path.
--
--   Each of these was a live consent bypass before it was pinned, all reaching
--   the same outcome by different columns:
--     - status:          INSERT 'invited', then UPDATE straight to 'active'.
--     - user_id:         UPDATE an ALREADY-ACTIVE row to point at an arbitrary
--                        user. status never changes, so a status-only guard
--                        passes cleanly, and the victim is an active member of
--                        an organisation they never heard of.
--     - organisation_id: the same trick aimed at the other identity column.
--     - joined_at:       an invited -> invited edit that forges an acceptance
--                        timestamp while status stays 'invited'.
--
-- WHY IT SEES THE OLD ROW (verified empirically -- see rls_foundation.sql
-- C9-C20, do not take it on trust if you change any of this):
--   WITH CHECK is evaluated against the NEW row, so the values passed in are
--   the proposed ones. This function re-reads the same row by primary key. It
--   is STABLE, so it runs on the calling statement's snapshot and a command
--   does not see its own effects -- it therefore reads the row as of the start
--   of the UPDATE. That holds for multi-row UPDATEs too: every row is evaluated
--   against the same statement-start snapshot, so rows updated earlier in the
--   command cannot shift the answer for rows evaluated later.
--
-- FAIL-CLOSED ON A REWRITTEN PRIMARY KEY
--   The lookup is by p_id, which is itself the NEW value. If a caller rewrites
--   `id` to something that names no stored row, EXISTS is false (never NULL)
--   and the update is refused. If they rewrite it to another EXISTING row's id,
--   the primary key rejects it. Either way there is no path through.
--
-- WHY SECURITY DEFINER, and why this does not re-open the recursion problem:
--   It is called from a policy ON organisation_memberships and reads
--   organisation_memberships. Written inline as a subquery this would be
--   textbook 42P17 ("infinite recursion detected in policy for relation").
--   DEFINER runs it as the table owner with RLS off, so it is TERMINAL in the
--   graph of design note (h) -- exactly like is_active_member.
--
-- WHY IT LIVES IN `private`
--   It reads a row the caller may have no right to see. Its predecessor
--   returned a bare status and sat in `public` with EXECUTE to authenticated,
--   which published it as a PostgREST RPC: pass any membership UUID, get that
--   row's status back, regardless of tenant. Returning a boolean about a row
--   the caller already had to name, from a schema the Data API does not route
--   to, closes that off structurally rather than by comment.
--
-- WHY A POLICY AND NOT A TRIGGER:
--   A BEFORE UPDATE trigger would give OLD/NEW directly with no snapshot
--   subtlety -- but it would apply to EVERY writer, including the SECURITY
--   DEFINER acceptance function Task 6 has to write (whose entire job is to
--   make the invited -> active transition) and including DBA/migration repair.
--   The constraint belongs on the client path only, and RLS is precisely the
--   layer that SECURITY DEFINER functions bypass. That is the deciding reason.
-- ---------------------------------------------------------------------------
create or replace function private.membership_update_is_permitted(
  p_id              uuid,
  p_organisation_id uuid,
  p_user_id         uuid,
  p_status          text,
  p_joined_at       timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organisation_memberships m
    where m.id = p_id
      -- identity columns are immutable through the client UPDATE policy
      and m.organisation_id = p_organisation_id
      and m.user_id         = p_user_id
      -- joined_at records acceptance; not writable here (NULL-safe compare)
      and m.joined_at is not distinct from p_joined_at
      -- and no transition INTO 'active'
      and (p_status <> 'active' or m.status = 'active')
  );
$$;

comment on function private.membership_update_is_permitted(uuid, uuid, uuid, text, timestamptz) is
  'Guard for the client-facing organisation_memberships UPDATE policy. Compares the proposed row against the row stored under the same id at statement start (STABLE = statement snapshot). Refuses any change to organisation_id, user_id or joined_at, and any transition into status=''active''. SECURITY DEFINER to avoid RLS self-recursion; lives in `private` so the Data API cannot route to it.';

revoke all on function private.membership_update_is_permitted(uuid, uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.membership_update_is_permitted(uuid, uuid, uuid, text, timestamptz)
  to authenticated;

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
create or replace function private.log_audit_event(
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

comment on function private.log_audit_event(text, text, uuid, uuid, uuid, jsonb, jsonb) is
  'Sole write path into public.audit_events (which has no INSERT policy). actor_user_id is forced to auth.uid() and cannot be supplied by the caller. EXECUTE is intentionally granted to no client role -- callers are other SECURITY DEFINER functions.';

revoke all on function private.log_audit_event(text, text, uuid, uuid, uuid, jsonb, jsonb)
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

  perform private.log_audit_event(
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
-- No policies are created for platform_admins, on purpose: RLS with zero
-- policies denies every row to every non-owner role. Combined with the GRANT
-- revocation in section 4, the table is unreachable from any client.
alter table public.platform_admins            enable row level security;

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
  using ( private.shares_active_organisation(id) );

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
  using ( private.is_active_member(id) );

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
  using ( private.is_active_member(organisation_id) );

-- THE CONSENT INVARIANT, and where it is enforced.
--
-- The invariant: holding 'manage_members' lets you INVITE someone and manage
-- people who have already joined. It must NOT let you produce an ACTIVE
-- membership for a user who never accepted -- because 'active' is what every
-- read policy in this schema keys off, so minting one silently exposes that
-- org's data to a person who never agreed to join, through their own session.
--
-- Enforcing it needs BOTH policies below, and it took three attempts to get the
-- UPDATE half right. Each earlier revision closed one column and left another
-- route to the identical outcome -- an active membership for someone who never
-- accepted -- so read the whole list before relaxing any of it:
--
--     guarded status only    -> INSERT 'invited', UPDATE it to 'active'.
--     pinned the transition  -> UPDATE an ALREADY-ACTIVE row's user_id to point
--                               at an arbitrary user. status never changes, so
--                               a status-only guard passes cleanly.
--     (same via organisation_id, aimed at the other identity column)
--     joined_at unpinned     -> invited -> invited edit that forges an
--                               acceptance timestamp while status stays
--                               'invited'.
--
-- So:
--
--   INSERT policy: a client INSERT is an INVITE, never a completed membership.
--     status = 'invited'   -- no minting an already-active row
--     joined_at is null    -- joined_at records ACCEPTANCE; it cannot be
--                             back-dated at invite time
--     invited_by           -- the caller or nothing, so an invite cannot be
--                             attributed to a different admin
--
--   UPDATE policy: delegates to private.membership_update_is_permitted(), which
--   compares the proposed row against the stored one and enforces:
--     organisation_id  IMMUTABLE through this policy
--     user_id          IMMUTABLE through this policy
--     joined_at        IMMUTABLE through this policy
--     status           anything EXCEPT a transition INTO 'active'
--
--   The identity columns are pinned outright rather than allow-listed, because
--   there is no legitimate client-facing edit that changes which user or which
--   organisation a membership row points at. Moving someone between
--   organisations is not "editing a membership", it is revoke-and-re-invite.
--   That leaves no exception to reason about and nothing to get wrong later.
--
-- What the UPDATE policy deliberately still ALLOWS, because these are the
-- legitimate reasons it exists:
--     active  -> active    change an existing member's role, or any other
--                          non-pinned field on someone who really did join
--     active  -> revoked   revoke a member
--     invited -> revoked   withdraw a pending invite
--     invited -> invited   correct the role on a pending invite
--     revoked -> invited   re-invite someone previously removed
-- and blocks exactly:
--     invited -> active    consent-free activation
--     revoked -> active    silent reinstatement of a removed member
--     any change to organisation_id, user_id or joined_at
--
-- The invited_by guard stays INSERT-only on purpose: on UPDATE the NEW row
-- still carries the ORIGINAL inviter, so the same predicate would wrongly block
-- a second admin from ever editing that membership.
--
-- FOLLOW-ON, NOT BUILT HERE (Task 6): something has to make the
-- invited -> active transition when an invitee actually accepts. It cannot be
-- this policy (the invitee does not hold 'manage_members' in the org inviting
-- them) and it must not be a loosening of it. It needs its own SECURITY DEFINER
-- function, scoped to the caller's OWN membership row, same pattern as
-- create_organisation -- which bypasses RLS and so is unaffected by the guard
-- above. Deliberately out of scope for Task 4; asserted as pending by test C8.
create policy "organisation_memberships_insert_manage_members"
  on public.organisation_memberships for insert to authenticated
  with check (
    public.has_permission(organisation_id, 'manage_members')
    and role <> 'platform_superuser'
    and (invited_by is null or invited_by = (select auth.uid()))
    and status = 'invited'
    and joined_at is null
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
    -- Pins organisation_id, user_id and joined_at immutable through this
    -- policy, and refuses any transition into status='active'. Fail-closed if
    -- `id` itself is rewritten.
    and private.membership_update_is_permitted(
          id, organisation_id, user_id, status, joined_at)
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
  using ( private.is_active_member(organisation_id) );

-- Second permissive SELECT policy, OR'd with the member one above. This is NOT
-- cosmetic and NOT just "so the dashboard can list subscriptions": Postgres
-- applies SELECT policies to an UPDATE's row-matching as well. Without it, the
-- superuser write policies below are half-working in a dangerous way -- a
-- targeted `UPDATE ... WHERE organisation_id = <an org the superuser is not a
-- member of>` silently matches 0 rows, while an unqualified
-- `UPDATE ... SET seat_count = 5` still succeeds against whatever rows the
-- member policy did expose. A write path that fails when aimed and succeeds
-- when unaimed is worse than one that just fails.
create policy "organisation_subscriptions_select_platform_billing"
  on public.organisation_subscriptions for select to authenticated
  using ( private.has_platform_permission('manage_billing') );

create policy "organisation_subscriptions_insert_platform_billing"
  on public.organisation_subscriptions for insert to authenticated
  with check ( private.has_platform_permission('manage_billing') );

create policy "organisation_subscriptions_update_platform_billing"
  on public.organisation_subscriptions for update to authenticated
  using      ( private.has_platform_permission('manage_billing') )
  with check ( private.has_platform_permission('manage_billing') );

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
  using ( private.has_platform_permission('view_audit_log') );

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
revoke all on public.platform_admins           from anon, authenticated, service_role;

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

-- platform_admins: NOTHING, to any client role, for any operation. The
-- revocation above is the whole story -- it is read only by
-- has_platform_permission() (SECURITY DEFINER, runs as the owner) and written
-- only by migration/DBA action. There is no policy to fall back on either.

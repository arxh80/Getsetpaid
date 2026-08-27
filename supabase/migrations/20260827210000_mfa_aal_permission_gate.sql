-- Foundation phase, final fix wave: push the MFA requirement into the
-- permission engine, so it is enforced BY THE DATABASE and not only by which
-- component app/(app)/layout.tsx chooses to render.
--
-- ===========================================================================
-- THE GAP THIS CLOSES
-- ===========================================================================
-- CLAUDE.md § Session security: "MFA is required for: Platform Superuser,
-- Organisation Owner, Admin, Finance." Before this migration that requirement
-- existed in exactly one place -- lib/auth/mfa-gate.ts's evaluateMfaGate(),
-- called once, from app/(app)/layout.tsx, where it swaps what <main> renders.
-- It did not redirect, no Server Action called it, and NO POLICY IN THIS
-- SCHEMA LOOKED AT THE JWT's `aal` CLAIM AT ALL. So:
--
--   stolen Owner password -> signInWithPassword() returns an aal1 session
--     -> POST the inviteMemberAction endpoint {role:"admin"}       ALLOWED
--     -> POST /rest/v1/organisation_memberships directly with the
--        session token + the public anon key                       ALLOWED
--
-- The second path is why an application-layer fix alone is not sufficient and
-- why this migration exists. Anyone holding a session token and the anon key
-- (which ships in the browser bundle by design) can talk to PostgREST and
-- route around the entire Next.js app. The database is the only chokepoint
-- that path cannot avoid. mfa-gate.ts's own header comment named this gap
-- honestly and judged it acceptable because "there is no table for an
-- aal2-gated policy to protect"; organisation_memberships is such a table and
-- shipped in the same phase, so the judgement no longer holds.
--
-- The application layer is fixed too (lib/auth/mfa-gate.ts's
-- assertMfaSatisfied(), called at the top of the privileged Server Actions).
-- Neither layer is redundant: the app layer gives the user a readable message
-- instead of an opaque 42501, and this layer is what actually enforces.
--
-- ===========================================================================
-- THE GATE IS ON THE PERMISSION, NOT ON THE ABILITY TO EXIST
-- ===========================================================================
-- This is the single most dangerous thing to get wrong here, so it is stated
-- before the code rather than after it.
--
-- MFA is required for owner/admin/finance and the platform superuser ONLY. It
-- is OPTIONAL for every other role at MVP. And a user who has not yet enrolled
-- must still be able to load the app far enough to enrol -- otherwise the
-- first Owner of every new organisation is permanently locked out with no path
-- back in.
--
-- So NOTHING below touches a read path. Specifically, these still work at
-- aal1, unchanged, and must continue to:
--
--   * organisation_memberships_select_own        -- the workspace switcher and
--                                                   the whole post-auth hub
--   * organisation_memberships_select_same_organisation
--   * profiles_select_own / _select_shared_organisation
--   * organisations_select_member                -- so the enrolling Owner can
--                                                   still see their own org
--   * public.is_platform_admin()                 -- see its section below
--   * public.accept_invite() / public.create_organisation()  (SECURITY
--     DEFINER, do not consult has_permission at all)
--
-- None of those five policies calls has_permission (verified: design note (h)
-- in 20260826154304 spells out the call graph, and the two membership SELECT
-- policies deliberately resolve to `user_id = auth.uid()` and
-- private.is_active_member, neither of which is touched here). That property
-- is what makes this change safe, and it is the property to re-check before
-- adding any new policy.
--
-- What DOES change: has_permission() now returns false for a caller whose
-- membership role is one CLAUDE.md requires MFA for, when the calling session
-- has not actually reached aal2. Every write policy in the schema is built on
-- has_permission, so all of them tighten at once and none of them had to be
-- rewritten.
--
-- ===========================================================================
-- WHY ROLE-SCOPED AND NOT "aal2 FOR EVERY WRITE"
-- ===========================================================================
-- A blanket `and session_is_aal2()` on the write policies would be simpler and
-- would be a LOCKOUT. 'manage_members' is currently seeded to owner and admin
-- only, but the roles catalogue also carries manager, booker, venue_manager,
-- marketing, standard_user and read_only -- roles for which MFA is explicitly
-- optional at MVP. The first time a later phase grants one of those a write
-- permission, a blanket rule would demand a factor those users were never
-- asked to enrol and have no reason to have. Keying on the role reproduces
-- CLAUDE.md's actual rule instead of an approximation of it, and it keeps this
-- function and lib/auth/mfa-gate.ts's MFA_REQUIRED_ROLES saying the same
-- thing. Keep them in step: they are two halves of one requirement.

-- ---------------------------------------------------------------------------
-- session_is_aal2()
-- Has THIS session actually completed an MFA challenge?
--
-- `aal` is a top-level JWT claim, verified against the running stack rather
-- than assumed: a password grant returns "aal":"aal1" alongside amr/session_id,
-- and mfa.challengeAndVerify() moves the SAME session to "aal2" in place (the
-- session_id and auth.sessions.created_at are unchanged -- measured in
-- lib/auth/mfa-gate.ts's header).
--
-- FAILS CLOSED BY CONSTRUCTION. A missing claim, a NULL jwt (no claims set at
-- all), an unparseable value or literally anything other than the exact string
-- 'aal2' collapses to false via coalesce. That direction matters: this is a
-- predicate that GRANTS a privileged capability, so "could not tell" must read
-- as "no". Test K17 asserts the no-claim case directly.
--
-- SECURITY INVOKER (the default, stated for reviewability): it reads a session
-- GUC, not a table, so there is nothing to elevate for. It lives in `private`
-- anyway because it exists to serve policies -- the rule from
-- 20260826154304's `private` schema block.
-- ---------------------------------------------------------------------------
create or replace function private.session_is_aal2()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(((select auth.jwt()) ->> 'aal') = 'aal2', false);
$$;

comment on function private.session_is_aal2() is
  'True iff the calling session''s JWT carries aal=aal2, i.e. an MFA challenge has actually been completed on THIS session. Fails closed (false) on a missing, null or unrecognised claim. Reads no table.';

revoke all on function private.session_is_aal2() from public, anon, authenticated, service_role;
grant execute on function private.session_is_aal2() to authenticated;

-- ---------------------------------------------------------------------------
-- role_requires_mfa(role_key)
-- The database half of CLAUDE.md § Session security's role list. Mirrors
-- MFA_REQUIRED_ROLES in lib/auth/mfa-gate.ts exactly; if one moves, move both.
--
-- IMMUTABLE and table-free on purpose. The obvious alternative -- a
-- `mfa_required boolean` column on public.roles -- would make the requirement
-- client-readable reference data (roles is SELECTable by every authenticated
-- user) and, worse, would make a security rule editable by whoever can write a
-- reference-data migration without that showing up as a policy change. It is a
-- constant in the security engine, so it is written as one.
-- ---------------------------------------------------------------------------
create or replace function private.role_requires_mfa(p_role text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_role in ('owner', 'admin', 'finance');
$$;

comment on function private.role_requires_mfa(text) is
  'True iff CLAUDE.md § Session security requires MFA for this organisation role (owner, admin, finance). Mirrors MFA_REQUIRED_ROLES in lib/auth/mfa-gate.ts -- keep the two in step. Deliberately a constant rather than a column on public.roles, so the rule is not client-readable reference data and cannot be edited without editing the permission engine.';

revoke all on function private.role_requires_mfa(text) from public, anon, authenticated, service_role;
grant execute on function private.role_requires_mfa(text) to authenticated;

-- ---------------------------------------------------------------------------
-- has_permission(org_id, permission)  -- REPLACED
--
-- Unchanged from 20260826154304 except for the final predicate. Everything the
-- original header said still holds and is not repeated here: SECURITY INVOKER
-- and self-scoped, pinned on BOTH user_id and organisation_id so a permission
-- held in org A cannot satisfy a check for org B, and never raising for any
-- negative case (no membership, wrong status, unknown key, NULL org id, NULL
-- permission, unauthenticated caller).
--
-- ADDED: an MFA-required role only carries its permissions on an aal2 session.
-- Note the predicate reads m.role -- the role IN THIS ORGANISATION, from the
-- row already being matched -- not "does this user hold a privileged role
-- anywhere". That is deliberately NARROWER than lib/auth/mfa-gate.ts, which
-- gates the whole app on any privileged membership because it has no current
-- org to scope to. Here there IS an org in hand, so the check is scoped to it.
-- The two disagreeing is correct: the app-level gate is the conservative
-- routing decision, this is the precise authorisation decision.
--
-- RECURSION: unchanged. Both helpers added above are terminal (one reads a
-- GUC, one is a pure constant), so the call graph in design note (h) of
-- 20260826154304 gains no new edge into a table and max depth is still 2.
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
      -- CLAUDE.md § Session security, enforced in the database: a role that
      -- requires MFA holds no permission on a session that never presented it.
      and (
        not private.role_requires_mfa(m.role)
        or private.session_is_aal2()
      )
  );
$$;

comment on function public.has_permission(uuid, text) is
  'Organisation-scoped permission check for auth.uid(). Requires an active membership of p_org_id whose role grants p_permission AND -- when that role is one CLAUDE.md § Session security requires MFA for -- a session that has actually reached aal2. Returns false (never raises) for every negative case, including a NULL p_org_id: NULL is not overloaded to mean "platform level", use has_platform_permission() for that. Reads only the caller''s own membership row, so SECURITY INVOKER.';

revoke all on function public.has_permission(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.has_permission(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- has_platform_permission(permission)  -- REPLACED
--
-- Same addition, for the platform superuser -- CLAUDE.md § Session security
-- names Platform Superuser first in the MFA-required list, and this predicate
-- gates the two most sensitive surfaces in the schema (reading audit_events
-- across every tenant, and writing organisation_subscriptions, i.e. any org's
-- entitlements).
--
-- The p_permission argument is still accepted and still not consulted; the
-- original header explains why and that reasoning is unchanged.
-- ---------------------------------------------------------------------------
create or replace function private.has_platform_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_is_aal2() and exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = (select auth.uid())
  );
$$;

comment on function private.has_platform_permission(text) is
  'Platform-level (organisation-independent) permission check: true iff auth.uid() is on the public.platform_admins allowlist AND this session has reached aal2 (CLAUDE.md § Session security requires MFA for the Platform Superuser). SECURITY DEFINER because platform_admins is unreadable by any client role. p_permission is accepted but NOT consulted -- at MVP there is one all-powerful superuser and no platform permission tiers. NOTE: this is a PERMISSION check and is aal-gated; for the identity question ("is this account the superuser at all") use public.is_platform_admin(), which is deliberately not.';

revoke all on function private.has_platform_permission(text) from public, anon, authenticated, service_role;
grant execute on function private.has_platform_permission(text) to authenticated;

-- ---------------------------------------------------------------------------
-- is_platform_admin()  -- REPLACED, AND DELIBERATELY *NOT* aal-GATED
--
-- READ THIS BEFORE "fixing" THE INCONSISTENCY BELOW. It is the whole reason
-- this function stops delegating to has_platform_permission().
--
-- lib/auth/mfa-gate.ts calls is_platform_admin() to answer "does the MFA
-- requirement APPLY to this caller?" -- and it necessarily asks that question
-- from an aal1 session, because a superuser who has not yet presented their
-- factor is exactly the caller the gate exists to stop. If this function
-- inherited the aal2 requirement, then for that caller it would return false,
-- the gate would conclude MFA does not apply, and the superuser would be waved
-- straight through to the app WITHOUT MFA. The aal check would have inverted
-- itself into the hole it was added to close.
--
-- So the two functions answer two different questions and only one of them is
-- aal-gated:
--
--   public.is_platform_admin()               IDENTITY  -- who is this account?
--                                            aal-independent. Consumed by the
--                                            MFA gate, which must be able to
--                                            ask before MFA is satisfied.
--   private.has_platform_permission(perm)    PERMISSION -- may this SESSION
--                                            act? aal2 required. Consumed by
--                                            the RLS policies.
--
-- It therefore reads the allowlist directly rather than calling the (now
-- aal-gated) private helper. It grants nothing on its own: the only thing a
-- caller learns is whether they themselves are the superuser, which they know.
--
-- Also normalises the ACL to the house pattern (review M-6): every sibling
-- function in this schema revokes from public, anon, authenticated,
-- service_role and then grants back. The net ACL is identical; the point of
-- the pattern is that it can be audited by eye.
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
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

comment on function public.is_platform_admin() is
  'IDENTITY check, not a permission check: true iff auth.uid() is on public.platform_admins, regardless of assurance level. Client-reachable (public schema) because the private-schema helpers are not exposed to PostgREST at all. Consumed by lib/auth/mfa-gate.ts to decide whether the Platform Superuser MFA requirement APPLIES -- which it must be able to ask from an aal1 session, so this function is deliberately NOT aal-gated. Use private.has_platform_permission() for anything that authorises an action.';

revoke all on function public.is_platform_admin() from public, anon, authenticated, service_role;
grant execute on function public.is_platform_admin() to authenticated;

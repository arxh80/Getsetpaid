-- Task 7 (Middleware & session security): a client-reachable way to ask "is
-- the signed-in caller the platform superuser".
--
-- WHY THIS MIGRATION EXISTS AT ALL -- a gap found, not assumed away.
--   The MFA-enrollment gate (lib/auth/mfa-gate.ts) has to block access for
--   Owner/Admin/Finance in any org OR the Platform Superuser (CLAUDE.md
--   § Session security). The org-role half is a plain SELECT against
--   organisation_memberships, already reachable under the caller's own RLS.
--   The superuser half has NO reachable path today:
--
--     private.has_platform_permission(text), added in
--     20260826154304_permission_engine_and_rls.sql, lives in the `private`
--     schema. supabase/config.toml's api.schemas = ["public",
--     "graphql_public"] does not expose `private` to PostgREST AT ALL -- not
--     "denied for non-superusers", literally not a routable HTTP endpoint for
--     ANY caller. tests/integration/rls/rls.test.ts section F
--     ("private schema helpers are not routable HTTP endpoints") asserts
--     exactly this with a table-driven 404 check that includes
--     has_platform_permission by name, for both an authenticated owner AND
--     anon. That test is correct and stays exactly as it is; this migration
--     does not touch it or the function it names.
--
--   So a upstream task brief describing has_platform_permission as "callable
--   via supabase.rpc(...)" does not hold under the migration as it actually
--   shipped. The fix is the same shape already used for the org-scoped
--   equivalent: public.has_permission(org, permission) is a SEPARATE, public-
--   schema function, not the private one made reachable. This migration adds
--   its platform-level counterpart the same way.
--
-- SECURITY DEFINER, for the same reason has_platform_permission itself is:
-- public.platform_admins has RLS enabled with zero policies and zero client
-- GRANTs, so a SECURITY INVOKER wrapper would raise 42501 for every caller
-- who is not the superuser, rather than returning false.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_platform_permission('is_platform_admin');
$$;

comment on function public.is_platform_admin() is
  'Client-reachable (public schema) wrapper around private.has_platform_permission(), added because the private-schema original is not exposed to PostgREST at all (see the RLS suite''s section F). True iff auth.uid() is on public.platform_admins. Used by lib/auth/mfa-gate.ts to decide whether the Platform Superuser MFA-enrollment requirement (CLAUDE.md § Session security) applies to the caller. Returns false, never raises, for every non-superuser caller.';

revoke all on function public.is_platform_admin() from public, anon, service_role;
grant execute on function public.is_platform_admin() to authenticated;

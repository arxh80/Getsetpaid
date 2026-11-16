-- ===========================================================================
-- THE IDLE LIMIT COVERS A NEVER-REFRESHED SESSION (audit 2026-11-16)
-- ===========================================================================
-- GoTrue skips [auth.sessions] inactivity_timeout on a session's FIRST-EVER
-- refresh (refreshed_at is NULL; tests/integration/session/session-limits.
-- test.ts measures it). So someone who signed in, worked for less than one
-- access-token lifetime and closed the tab left a session that could be
-- resumed until the 12-hour timebox: the browser idle timer only runs while a
-- signed-in page is open, and on mount it treats the visit as fresh activity.
--
-- GoTrue calls this function whenever it issues an access token, a refresh
-- included. An access token lives 15 minutes (jwt_expiry = 900), so a session
-- that has never refreshed and is older than 15 + 30 minutes has made no
-- request for at least the 30-minute idle limit. The hook refuses that token,
-- which fails the refresh. Every other issue passes the event back unchanged.
--
-- The 45 minutes is jwt_expiry + inactivity_timeout from supabase/config.toml;
-- change those and this number moves with them.
--
-- ON HOSTED SUPABASE THE HOOK MUST BE ENABLED IN THE DASHBOARD (Authentication
-- > Hooks > Custom access token): config.toml configures the local stack only.
-- ===========================================================================
create function public.hook_custom_access_token(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (
       select 1
         from auth.sessions s
        where s.id::text = event->'claims'->>'session_id'
          and s.refreshed_at is null
          and s.created_at < pg_catalog.now() - interval '45 minutes') then
    return pg_catalog.jsonb_build_object('error', pg_catalog.jsonb_build_object(
      'http_code', 401,
      'message', 'Session expired after inactivity.'));
  end if;
  return event;
end;
$$;

comment on function public.hook_custom_access_token(jsonb) is
  'GoTrue custom access token hook (20261116004000; audit 2026-11-16). Refuses (401) a token for a session that has never refreshed and was created more than 45 minutes ago (jwt_expiry 15 min + inactivity_timeout 30 min), closing the first-refresh gap in GoTrue''s inactivity check. Returns every other event unchanged: it adds and removes no claim. EXECUTE to supabase_auth_admin only. Must also be enabled in the hosted dashboard.';

revoke all on function public.hook_custom_access_token(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.hook_custom_access_token(jsonb) to supabase_auth_admin;

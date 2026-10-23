-- ===========================================================================
-- THE SERVER-ONLY REQUEST MARK (Phase 10 Task 5; gaps G2 and G14, High)
-- ===========================================================================
-- Two holes with one cause: PostgREST cannot tell the app's own server from a
-- browser holding the same session.
--
--   G2   The 30/min network-discovery limit is metered in the app
--        (lib/list/query.ts), so `GET /rest/v1/network_directory` with the
--        anon key and a session JWT never met it (Q107), and that search
--        costs O(published profiles platform-wide).
--   G14  An impersonating superuser's direct PostgREST reads were authorised
--        and unrecorded; only the app path audits `page_viewed`.
--
-- THE MARK. lib/supabase/server.ts -- and no browser client -- sends
-- `x-getsetpaid-server: <GETSETPAID_SERVER_REQUEST_SECRET>` on every request.
-- PostgREST runs api_hooks.pre_request() before every request (its
-- `db_pre_request`, registered below). It compares the header's SHA-256 with
-- the hex digest held in Vault as `server_request_mark_digest` and sets the
-- transaction-local `getsetpaid.from_server` to 'on' or 'off' -- always one
-- of the two, so nothing a session set earlier survives into a request. Then:
--
--   G2   it refuses (PT403 -> HTTP 403) any unmarked request whose path names
--        either directory view. A DENY writes nothing, so PostgREST's
--        read-only GET transaction does not block it (20260909020000's note).
--   G14  private.impersonated_organisations() returns its target only when
--        private.request_is_from_server() is true, so an impersonator's
--        direct reads see nothing and every read goes through getCurrentOrg's
--        audited path.
--
-- FAILS CLOSED. No Vault entry, no header, or a wrong one: the directory is
-- refused and impersonation reads nothing. Locally the digest is seeded by
-- supabase/seed.sql from the value .env.example documents; every other
-- environment creates its own (SECURITY.md § 15), the way the runner
-- secrets' Vault pairs are made. A digest, not the secret, is stored: reading
-- it does not let anyone mint the header.
--
-- WHY VAULT AND NOT A `private` TABLE: a new private table must join the
-- retention roll (private.retention_subjects(), rebuilt wholesale by every
-- migration that adds one), and the invoicing branch rebuilds that roll too;
-- whichever migration ran last would silently drop the other's entries. Vault
-- is outside the roll, and the read is one index lookup (0.03 ms measured).
--
-- WHY A NEW SCHEMA FOR THE HOOK, AND NOT `private` (measured 2026-10-23):
-- PostgREST calls the hook as the request's role -- anon, authenticated or
-- service_role -- and only `authenticated` has USAGE on `private`
-- (has_schema_privilege: anon f, service_role f). A hook in `private` would
-- fail every anon and service_role request. `public` would publish it as
-- /rpc/pre_request. So `api_hooks` holds this one function, USAGE to the
-- three request roles, and is not in PGRST_DB_SCHEMAS.
--
-- KNOWN LIMIT: the hook sees the request path, not the query string, so an
-- EMBED of a view from a relation with a foreign key into network_profiles
-- (`network_links?select=*,network_directory(*)`,
-- `network_connection_requests?select=*,network_directory!...(*)`) is not
-- refused. That read is bounded by the caller's own organisation's links and
-- requests -- O(tenant), not the O(platform) search G2 is about -- and returns
-- only the published fields of profiles that organisation already linked or
-- requested. SECURITY.md § 5 names it.
-- ===========================================================================

create function private.request_is_from_server()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.current_setting('getsetpaid.from_server', true), '') = 'on';
$$;

revoke all on function private.request_is_from_server() from public, anon, authenticated, service_role;

comment on function private.request_is_from_server() is
  'True when this request carried the server-only mark: api_hooks.pre_request() matched x-getsetpaid-server against the Vault digest server_request_mark_digest and set getsetpaid.from_server = on for the transaction (20261108000000; Phase 10 Task 5). False for a browser''s direct PostgREST request, and outside PostgREST unless the session set the flag itself (the psql runner does, to stand in for the server). Read by private.impersonated_organisations() (G14). Not executable by any client role: callers are SECURITY DEFINER functions.';


create schema api_hooks;
revoke all on schema api_hooks from public;
grant usage on schema api_hooks to anon, authenticated, service_role;

comment on schema api_hooks is
  'PostgREST''s request hooks (20261108000000). Not exposed (not in PGRST_DB_SCHEMAS); USAGE to the three request roles because PostgREST calls its db_pre_request as the request''s role, and only authenticated has USAGE on private.';

create function api_hooks.pre_request()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_presented text := nullif(pg_catalog.current_setting('request.headers', true), '')::json
                        ->> 'x-getsetpaid-server';
  v_marked boolean;
begin
  v_marked := v_presented is not null and exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'server_request_mark_digest'
       and pg_catalog.lower(pg_catalog.btrim(s.decrypted_secret))
             = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_presented, 'UTF8')), 'hex'));

  perform pg_catalog.set_config('getsetpaid.from_server',
                                case when v_marked then 'on' else 'off' end, true);

  if not v_marked
     and pg_catalog.current_setting('request.path', true)
           in ('/network_directory', '/network_connected_profiles') then
    raise sqlstate 'PT403'
      using message = 'The network directory is read through the app.',
            hint = 'server_request_mark_required';
  end if;
end;
$$;

revoke all on function api_hooks.pre_request() from public;
grant execute on function api_hooks.pre_request() to anon, authenticated, service_role;

comment on function api_hooks.pre_request() is
  'PostgREST db_pre_request (20261108000000; Phase 10 Task 5). Sets getsetpaid.from_server on/off for the transaction from x-getsetpaid-server vs the hex SHA-256 in Vault secret server_request_mark_digest, then refuses (PT403, hint server_request_mark_required) an unmarked request for /network_directory or /network_connected_profiles (G2). Writes nothing. Executable by the three request roles because PostgREST calls it as the request''s role; called directly it can only mark the caller''s own transaction, and only with the secret.';

alter role authenticator set pgrst.db_pre_request = 'api_hooks.pre_request';
notify pgrst, 'reload config';


-- G14: the impersonation grant now needs the mark. Rebuilt from the live
-- definition (20260908020000) with one added term.
create or replace function private.impersonated_organisations(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select s.target_organisation_id
  from public.impersonation_sessions s
  join public.role_permissions rp
    on rp.role_key = 'read_only'
  join public.permissions perm
    on perm.key = rp.permission_key
  join public.organisations o
    on o.id = s.target_organisation_id
   and (o.deleted_at is null or perm.survives_suspension)
  where s.superuser_user_id = (select auth.uid())
    and s.status = 'active'
    and s.expires_at > pg_catalog.now()
    and rp.permission_key = p_permission
    and private.has_platform_permission('impersonate')
    -- Phase 10 Task 5 (G14): only the app's server, never a direct read.
    and private.request_is_from_server();
$function$;

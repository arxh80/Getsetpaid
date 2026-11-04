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
-- EMBEDS (G35, closed here too): the hook sees the request path, not the
-- query string, so an EMBED of a view from a relation with a foreign key into
-- network_profiles (`network_links?select=*,network_directory(*)`,
-- `network_connection_requests?select=*,network_directory!...(*)`) is not
-- refused by it. So both views' own WHERE clauses also require
-- private.request_is_from_server() (rebuilt at the end of this file): an
-- unmarked embed resolves to null. The path check stays, because it answers
-- a direct read with a loud 403 rather than an empty 200. The views also
-- fail closed on their own if a hosted project never registers the hook:
-- the flag is then never 'on' outside the runner.
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
-- authenticated only: the two network views call it, and a function in a view
-- is checked against the view's CALLER (measured: permission denied without
-- this). It returns the caller's own transaction flag and is not an RPC
-- (private is not exposed).
grant execute on function private.request_is_from_server() to authenticated;

comment on function private.request_is_from_server() is
  'True when this request carried the server-only mark: api_hooks.pre_request() matched x-getsetpaid-server against the Vault digest server_request_mark_digest and set getsetpaid.from_server = on for the transaction (20261108000000; Phase 10 Task 5). False for a browser''s direct PostgREST request, and outside PostgREST unless the session set the flag itself (the psql runner does, to stand in for the server). Read by private.impersonated_organisations() (G14) and by the WHERE clauses of public.network_directory and public.network_connected_profiles (G35). EXECUTE to authenticated only, because a function in a view is checked against the view''s caller; it reveals only the caller''s own flag, and private is not an exposed schema.';


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


-- G35: both directory views also require the mark in their own WHERE, so an
-- EMBED (which the hook's path check cannot see) resolves to null when the
-- request is unmarked. Rebuilt from the live definitions (20261103000000) with
-- one added term each; columns, options and grants are unchanged. Their
-- pg_depend RELATION sets are unchanged (N2: rls_phase6_network.sql ND1/ND2);
-- their FUNCTION sets each gain private.request_is_from_server, which reads one
-- GUC and no relation (ND3c/ND3d and network_leakage_phase6.sql LF2c are
-- re-pinned for it, deliberately).
create or replace view public.network_directory
  with (security_invoker = false, security_barrier = true) as
select
  p.id, p.entity_kind, p.display_name,                                   -- always visible (Q71)
  case when p.field_visibility->>'headline'      = 'network' then p.headline      end as headline,
  case when p.field_visibility->>'bio'           = 'network' then p.bio           end as bio,
  case when p.field_visibility->>'city'          = 'network' then p.city          end as city,
  case when p.field_visibility->>'region'        = 'network' then p.region        end as region,
  case when p.field_visibility->>'country'       = 'network' then p.country       end as country,
  case when p.field_visibility->>'website_url'   = 'network' then p.website_url   end as website_url,
  case when p.field_visibility->>'contact_email' = 'network' then p.contact_email end as contact_email,
  p.published_at
from public.network_profiles p
where p.status = 'published' and p.deleted_at is null
  and private.network_profile_reaches_caller(p.organisation_id)
  and private.request_is_from_server();

create or replace view public.network_connected_profiles
  with (security_invoker = false, security_barrier = true) as
select
  p.id, p.entity_kind, p.display_name,
  case when p.field_visibility->>'headline'      in ('network','connections') then p.headline      end as headline,
  case when p.field_visibility->>'bio'           in ('network','connections') then p.bio           end as bio,
  case when p.field_visibility->>'city'          in ('network','connections') then p.city          end as city,
  case when p.field_visibility->>'region'        in ('network','connections') then p.region        end as region,
  case when p.field_visibility->>'country'       in ('network','connections') then p.country       end as country,
  case when p.field_visibility->>'website_url'   in ('network','connections') then p.website_url   end as website_url,
  case when p.field_visibility->>'contact_email' in ('network','connections') then p.contact_email end as contact_email,
  p.published_at
from public.network_profiles p
where p.status = 'published' and p.deleted_at is null
  and private.network_profile_reaches_caller(p.organisation_id)
  and private.request_is_from_server()
  and exists (
    select 1 from public.network_connection_requests r
     where r.status = 'accepted'
       and (   (r.to_organisation_id   = p.organisation_id
                and r.from_organisation_id in (select private.permitted_organisations('view_network')))
            or (r.from_organisation_id = p.organisation_id
                and r.to_organisation_id   in (select private.permitted_organisations('view_network')))));

-- The views' comments describe their row gate; say what this adds.
do $$
declare v text;
begin
  foreach v in array array['public.network_directory', 'public.network_connected_profiles'] loop
    execute pg_catalog.format('comment on view %s is %L', v,
      pg_catalog.obj_description(v::regclass, 'pg_class')
      || ' Since 20261108000000 (Phase 10 Task 5, G35) the WHERE clause also requires private.request_is_from_server(): only a request the app''s server marked sees rows, so an embed from network_links or network_connection_requests, which api_hooks.pre_request()''s path check cannot see, resolves to null.');
  end loop;
end $$;

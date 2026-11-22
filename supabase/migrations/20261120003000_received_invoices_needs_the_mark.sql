-- ===========================================================================
-- A DIRECT, UNMARKED GET OF received_invoices IS REFUSED (PT403), LIKE THE TWO
-- NETWORK VIEWS. The view's own WHERE already calls
-- private.request_is_from_server(), so an unmarked read returned an empty 200
-- (docs/as-built.md, Invoices part 3, "Deliberate gaps"). The hook now names
-- the third definer view too, so the browser gets the same answer for all
-- three. Rebuilt from the live definition (20261108000000); the only change is
-- the added path.
-- ===========================================================================

create or replace function api_hooks.pre_request()
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
           in ('/network_directory', '/network_connected_profiles', '/received_invoices') then
    raise sqlstate 'PT403'
      using message = 'This view is read through the app.',
            hint = 'server_request_mark_required';
  end if;
end;
$$;

revoke all on function api_hooks.pre_request() from public;
grant execute on function api_hooks.pre_request() to anon, authenticated, service_role;

comment on function api_hooks.pre_request() is
  'PostgREST db_pre_request (20261108000000; Phase 10 Task 5). Sets getsetpaid.from_server on/off for the transaction from x-getsetpaid-server vs the hex SHA-256 in Vault secret server_request_mark_digest, then refuses (PT403, hint server_request_mark_required) an unmarked request for /network_directory, /network_connected_profiles (G2) or /received_invoices (20261120003000). Writes nothing. Executable by the three request roles because PostgREST calls it as the request''s role; called directly it can only mark the caller''s own transaction, and only with the secret.';

notify pgrst, 'reload config';

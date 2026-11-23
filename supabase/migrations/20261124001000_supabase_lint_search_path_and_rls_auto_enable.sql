-- ===========================================================================
-- Two Supabase linter warnings (hosted Security Advisor, 2026-11-23).
--
-- 0011 function_search_path_mutable: the two "unthreaded" CRM helpers moved
--   into private in 20260912001000 kept no search_path. Both are SECURITY
--   INVOKER and schema-qualify every table, so pinning it to '' changes
--   nothing they do; it only removes the shadowing risk the lint describes.
--
-- 0028/0029 public.rls_auto_enable(): Supabase's own helper behind its
--   `ensure_rls` event trigger, created on the hosted project and absent on
--   the local stack. It sits in `public`, so PostgREST exposes it as an RPC
--   to anon and authenticated. An event trigger fires regardless of EXECUTE
--   grants, so revoking them closes the /rpc door without touching the
--   trigger. Guarded, because the local stack has no such function.
-- ===========================================================================

alter function private.set_contact_primary_company_unthreaded(uuid, uuid, uuid) set search_path = '';
alter function private.set_artist_primary_representation_unthreaded(uuid, uuid, uuid) set search_path = '';

do $$
begin
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.pronargs = 0) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end
$$;

-- Phase 7 Task 6b, fix round 1: repair 20260915000000's two thread functions.
--
-- 20260915000000 wrote `pg_catalog.nullif(...)` and `pg_catalog.coalesce(...)`.
-- NULLIF and COALESCE are SQL *constructs* -- parser syntax, like CASE -- and
-- NOT functions in pg_catalog, so neither name resolves. A plpgsql body is
-- parsed LAZILY, at first execution rather than at CREATE, so the migration
-- applied cleanly and every call afterwards raised
--
--   42883  function pg_catalog.nullif(text, unknown) does not exist
--
-- which PostgREST maps to HTTP 404. That took all four wrapper RPCs
-- (merge_records, set_contact_primary_company,
-- set_artist_primary_representation, set_custom_field_values) off the API
-- surface: the runner's HTTP block went to 33 failures, every one of them
-- "got 404 want 200/403", and the Phase 2 CRM psql suite to 94.
--
-- The habit that caused it is otherwise correct and is why it slipped through:
-- every function in this schema runs `set search_path = ''` and qualifies its
-- calls, so `pg_catalog.` in front of a bare name reads as the careful choice.
-- It is the right instinct applied to two names that are not functions.
-- 20260912001000's own crm_bulk_correlation_id() uses bare `nullif` for
-- exactly this reason. Unqualified is SAFE here: the SQL parser resolves both
-- constructs itself, with no search_path lookup to hijack.
--
-- Migrations are immutable, so 20260915000000 stands as written and this file
-- is the correction. Same signatures and return types, so CREATE OR REPLACE
-- suffices and the grants made there survive untouched.

create or replace function private.begin_crm_bulk_audit()
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare v_open text;
begin
  -- Bare NULLIF: a construct, not pg_catalog.nullif().
  v_open := nullif(pg_catalog.current_setting('app.crm_bulk_correlation_id', true), '');

  if v_open is not null then
    -- A thread is already open. JOIN it: do not overwrite the marker, and
    -- tell the caller it does not own it, so its end() leaves it standing.
    return false;
  end if;

  perform pg_catalog.set_config(
    'app.crm_bulk_correlation_id', pg_catalog.gen_random_uuid()::text, true);
  return true;
end;
$$;

create or replace function private.end_crm_bulk_audit(p_opened boolean default true)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  -- Close ONLY a thread this caller opened. A nested caller passes false and
  -- leaves its parent's thread standing; without this the inner wrapper closed
  -- the outer operation's thread and every later row minted a fresh id (M1).
  -- `is true` rather than COALESCE: same null-safety, no construct to misname.
  if p_opened is true then
    perform pg_catalog.set_config('app.crm_bulk_correlation_id', '', true);
  end if;
end;
$$;

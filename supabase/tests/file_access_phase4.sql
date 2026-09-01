-- ===========================================================================
-- Phase 4 (Operations), Task 5: FILE-ACCESS DB SUITE.
--
-- The download half of the pipeline proves itself at three layers -- this DB
-- suite, the API surface (run-rls-tests.sh), and the server-action integration
-- test (tests/integration/documents/upload-scan-download.test.ts). This file is
-- the DB layer: the invariants that make a quarantined or cross-tenant FILE
-- unreachable no matter what the application does, because the bytes are only
-- ever served by a server signed URL and the metadata only through RLS.
--
-- Three sections, each a negative paired with a positive control that has a
-- DENOMINATOR, so "0 reachable" is never vacuous (Global Constraint 14):
--   A  documents_storage_key_shape: a cross-tenant storage key is a 23514.
--   B  the storage.objects deny-all fence: a client reads 0 of N planted
--      `documents` objects -- AND keeps reading 0 even when a broad permissive
--      SELECT policy is added, because the RESTRICTIVE fence is AND-ed in.
--   C  the scan-status transition guard (20260902031000): a terminal verdict
--      is immutable, so a stray PATCH cannot un-quarantine a file.
--
-- Runs AFTER rls_foundation.sql (needs orgs org-alpha/org-beta) with the same
-- P2VARS the Phase 2/3/4 suites use (the fixture users' claims). Plants only in
-- its own throwaway rows and tears every one down at the end, so the HTTP
-- checks that follow in run-rls-tests.sh see a clean slate.
--
-- Mutations this suite is built to catch (run for real, reverted -- see report):
--   * drop the documents_storage_key_shape CHECK  -> A2 goes green-when-it-
--     should-be-red i.e. the cross-tenant plant succeeds (A2 red).
--   * drop/weaken documents_deny_client_select on storage.objects -> B2 red
--     (a client with a broad permissive grant then reads the documents bytes).
--   * remove the scan-status guard trigger -> C1/C2 red (a verdict rolls back).
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists fa cascade;
create schema fa;

create table fa.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function fa.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into fa.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- Runs p_sql and records ok(rowcount) or denied(sqlstate) -- the shape the
-- other suites use, so a CHECK/trigger rejection reads as denied(<state>).
create function fa.try(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_rows bigint; v_actual text;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_actual := 'ok(' || v_rows || ')';
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform fa.record(p_label, p_expected, v_actual);
end $$;

create function fa.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform fa.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema fa to authenticated, anon, service_role;
grant execute on function fa.record(text,text,text) to authenticated, anon, service_role;
grant execute on function fa.try(text,text,text)     to authenticated, anon, service_role;
grant execute on function fa.val(text,text,text)     to authenticated, anon, service_role;

\o /dev/null

select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset

\o

-- ===========================================================================
-- A. documents_storage_key_shape -- a cross-tenant storage key is a 23514.
--
-- The key must begin with the row's OWN organisation_id (20260902001000). So a
-- bug in buildStorageKey() that emitted another tenant's prefix is a database
-- refusal, not a cross-tenant file. Planted as postgres: RLS is bypassed but a
-- CHECK constraint is NOT, so this tests the constraint alone.
-- ===========================================================================
\o /dev/null
-- A1 POSITIVE CONTROL / DENOMINATOR: a correctly-prefixed key inserts fine, so
-- A2's rejection is the shape check biting and not inserts being broken.
select fa.try('A1 CONTROL a correctly-prefixed storage key is accepted',
  format($$insert into public.documents
             (organisation_id, filename, storage_key, mime_type, size_bytes, scan_status, scanned_at)
           values (%L, 'a1.pdf', %L, 'application/pdf', 10, 'clean', now())$$,
         :'alpha_org', :'alpha_org' || '/a1-key'),
  'ok(1)');
-- A2 THE NEGATIVE: organisation_id = ALPHA but a key under BETA's prefix.
select fa.try('A2 a cross-tenant storage key (BETA prefix on an ALPHA row) is refused',
  format($$insert into public.documents
             (organisation_id, filename, storage_key, mime_type, size_bytes, scan_status, scanned_at)
           values (%L, 'a2.pdf', %L, 'application/pdf', 10, 'clean', now())$$,
         :'alpha_org', :'beta_org' || '/a2-key'),
  'denied(23514)');
\o

-- ===========================================================================
-- B. The storage.objects deny-all fence.
--
-- The bytes live in storage.objects and are reachable to a client ONLY if some
-- permissive policy lets them AND every restrictive policy allows them. There is
-- no permissive policy today, so a client already sees nothing; the point of the
-- RESTRICTIVE documents_deny_* fence (20260902030000) is that this stays true
-- even if a broad permissive policy is added later. B proves both halves.
-- ===========================================================================
\o /dev/null
-- Plant N=2 `documents` objects and one object in a throwaway OTHER bucket, as
-- postgres. The other-bucket object is the live-grant control for B2.
insert into storage.buckets (id, name, public) values ('fa-probe', 'fa-probe', false)
  on conflict (id) do nothing;
insert into storage.objects (bucket_id, name) values
  ('documents', 'fa-plant/obj-1'),
  ('documents', 'fa-plant/obj-2'),
  ('fa-probe',  'fa-plant/other-1');

-- B0 DENOMINATOR: postgres sees the two planted `documents` objects, so B1/B2's
-- 0 is measured against a real count of reachable-in-principle bytes.
select fa.val('B0 DENOMINATOR postgres sees the 2 planted documents objects',
  $$select count(*)::text from storage.objects where bucket_id='documents' and name like 'fa-plant/%'$$,
  '2');
\o

-- B1: a plain authenticated client reads ZERO documents objects (base deny --
-- no permissive policy exists, and the restrictive fence blocks anyway).
-- Plain `set` (not `set local`): psql autocommits each statement, so a
-- transaction-scoped `set local` would revert before the next line runs as
-- postgres with RLS bypassed. `set role authenticated` makes RLS actually apply.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select fa.val('B1 an authenticated client reads 0 documents objects (of 2)',
  $$select count(*)::text from storage.objects where bucket_id='documents'$$, '0');
reset role; reset request.jwt.claims;

\o /dev/null
-- Add a BROAD permissive SELECT policy, simulating a future migration that opens
-- some other bucket up to clients. The restrictive documents_deny_client_select
-- must still keep the documents bytes closed.
create policy fa_probe_permissive_select on storage.objects
  as permissive for select to authenticated using (true);
\o

set role authenticated;
set request.jwt.claims = :'pmanager_c';
-- B2 THE FENCE: even WITH a broad permissive grant, the restrictive fence keeps
-- documents objects at 0. This is the assertion the "open client select"
-- mutation reddens: drop documents_deny_client_select and this returns 2.
select fa.val('B2 with a broad permissive grant added, documents is STILL 0 (restrictive fence holds)',
  $$select count(*)::text from storage.objects where bucket_id='documents'$$, '0');
-- B2b CONTROL: the same client, same permissive policy, DOES see the object in
-- the other bucket -- so B2's 0 is the fence at work, not an inert grant.
select fa.val('B2b CONTROL the permissive grant is live: the OTHER bucket''s object IS visible',
  $$select count(*)::text from storage.objects where bucket_id='fa-probe' and name like 'fa-plant/%'$$,
  '1');
reset role; reset request.jwt.claims;

\o /dev/null
drop policy fa_probe_permissive_select on storage.objects;
\o

-- B3 STRUCTURAL: the four restrictive deny-all policies are present. Catches a
-- migration that simply drops the fence (B1/B2 read as postgres cannot).
select fa.val('B3 the four restrictive documents_deny_* policies exist on storage.objects',
  $$select count(*)::text from pg_policies
     where schemaname='storage' and tablename='objects'
       and policyname like 'documents_deny_client_%' and permissive='RESTRICTIVE'$$, '4');

-- ===========================================================================
-- C. The scan-status transition guard (20260902031000).
--
-- Once scan_status is terminal it is immutable -- a stray PATCH cannot roll a
-- verdict back to pending or flip quarantined->clean. The trigger is
-- role-independent (it fires for every writer), so this exercises it as postgres
-- for determinism; a manager PATCH over PostgREST hits exactly the same wall.
-- ===========================================================================
\o /dev/null
insert into public.documents
  (id, organisation_id, filename, storage_key, mime_type, size_bytes, scan_status, scanned_at)
values
  ('fa000000-0000-0000-0000-0000000000c1', :'alpha_org', 'c-clean.pdf',
   :'alpha_org' || '/c-clean', 'application/pdf', 10, 'clean', now()),
  ('fa000000-0000-0000-0000-0000000000c2', :'alpha_org', 'c-pending.pdf',
   :'alpha_org' || '/c-pending', 'application/pdf', 10, 'pending', null);
\o

-- C1: clean -> pending refused (a verdict cannot be un-set).
select fa.try('C1 a terminal scan_status cannot roll back to pending',
  $$update public.documents set scan_status='pending'
     where id='fa000000-0000-0000-0000-0000000000c1'$$, 'denied(23514)');
-- C2: clean -> quarantined refused (no un-clean / re-quarantine except a rescan
-- path that does not exist at MVP).
select fa.try('C2 a clean scan_status cannot flip to quarantined',
  $$update public.documents set scan_status='quarantined'
     where id='fa000000-0000-0000-0000-0000000000c1'$$, 'denied(23514)');
-- C3 CONTROL: a same-value UPDATE (the soft-delete path moves deleted_at, not
-- scan_status) is allowed -- so C1/C2 are the guard, not a frozen row.
select fa.try('C3 CONTROL soft-delete (scan_status unchanged) is allowed',
  $$update public.documents set deleted_at=now()
     where id='fa000000-0000-0000-0000-0000000000c1'$$, 'ok(1)');
-- C4 CONTROL: pending -> clean (the upload write) is allowed -- the guard only
-- freezes TERMINAL states.
select fa.try('C4 CONTROL the upload write pending->clean is allowed',
  $$update public.documents set scan_status='clean', scanned_at=now()
     where id='fa000000-0000-0000-0000-0000000000c2'$$, 'ok(1)');

-- ===========================================================================
-- Teardown -- leave the schema exactly as found for the HTTP checks that follow.
-- ===========================================================================
\o /dev/null
delete from public.documents
 where storage_key like (:'alpha_org' || '/a1-key')
    or storage_key like (:'alpha_org' || '/c-%')
    or id in ('fa000000-0000-0000-0000-0000000000c1','fa000000-0000-0000-0000-0000000000c2');
-- storage.objects has a protect_objects_delete trigger that refuses a direct
-- DELETE (it guards against orphaning bytes behind live rows -- irrelevant to a
-- test's own throwaway plants). session_replication_role=replica suspends
-- non-replica triggers for the teardown, so the plants clear cleanly.
set session_replication_role = replica;
delete from storage.objects where name like 'fa-plant/%';
delete from storage.buckets where id='fa-probe';
set session_replication_role = default;
\o

-- ===========================================================================
-- Results
-- ===========================================================================
\echo ''
\echo '========== PHASE 4 FILE-ACCESS SUITE =========='
select seq, case when pass then 'PASS' else '**FAIL**' end as result,
       label, expected, actual
from fa.results order by seq;

\echo ''
select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from fa.results;

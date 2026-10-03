-- ============================================================================
-- PHASE 8 TASK 8 -- THE SEAMS THAT SHIP CLOSED, MEASURED CLOSED AND OPENED
-- ============================================================================
-- Brief requirement 6: "Several things in this phase ship dormant or
-- refused-by-default ... Each needs a test that it is genuinely closed AND a
-- test that it opens correctly when flipped -- otherwise the day it is woken
-- is the day it is first tried."
--
-- Where each seam is already measured both ways (so this file does not repeat
-- it -- see task-8-report.md § Seams):
--   * the fulfilment predicate, both halves -- rls_phase8_data_subject_
--     requests.sql § DF flips private.dsr_fulfilment_job_ready() each way in a
--     rolled-back transaction, and § DF9a-e / rls_phase8_erasure.sql carry the
--     positive control that a real job admits a fulfilment;
--   * the retention kill switch and its audit-purge half -- rls_phase8_
--     retention.sql § RR7 (switched off: every run refused `retention_
--     disabled`, nothing swept) beside every live run in the file (switched
--     on), and the audit purge switched off at :809.
--
-- The one that had NO test either way is public.document_versions (Phase 4,
-- "ships dormant: SELECT-only, no write path -- versioning is Release 1.1"),
-- and it is the one this file measures. Closed: no write privilege for any API
-- role or service_role, no write policy, RLS on, and a real Owner's INSERT
-- refused. Opened -- by the smallest change a Release 1.1 migration would make
-- (an INSERT grant and a write policy mirroring documents') -- the fences that
-- are ALREADY there must hold on the day: the composite tenant foreign key
-- refuses a version pointing at another workspace's document, the policy
-- refuses a version filed under another workspace, the SELECT policy keeps a
-- version inside its tenant, and the Phase 8 audit-coverage census notices the
-- new client write at once. Then it is closed again, and the file asserts it
-- is back exactly as it found it -- so the suite is re-runnable (lesson 11).
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists pm cascade;
create schema pm;

create table pm.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function pm.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into pm.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function pm.try(p_label text, p_sql text, p_expected text)
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
  perform pm.record(p_label, p_expected, v_actual);
end $$;

create function pm.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform pm.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema pm to authenticated, anon, service_role;
grant execute on function pm.record(text,text,text) to authenticated, anon, service_role;
grant execute on function pm.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function pm.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null
select id as alpha_org from public.organisations where slug = 'org-alpha' \gset
select id as beta_org  from public.organisations where slug = 'org-beta'  \gset
select id as alpha_doc from public.documents where organisation_id = :'alpha_org' and deleted_at is null order by created_at limit 1 \gset
select id as beta_doc  from public.documents where organisation_id = :'beta_org'  and deleted_at is null order by created_at limit 1 \gset
\o

-- ---------------------------------------------------------------------------
-- § DV0 THE DENOMINATOR. Two real documents in two real tenants, the Owner of
-- the first able to write documents at all, and the table empty -- or every
-- refusal below is a refusal of a fixture that does not exist.
-- ---------------------------------------------------------------------------
select pm.val('DV0a FIXTURE: ALPHA has a live document to version',
  format($$select (%L::uuid is not null)::text$$, nullif(:'alpha_doc', '')), 'true');
select pm.val('DV0b FIXTURE: BETA has a live document to point at',
  format($$select (%L::uuid is not null)::text$$, nullif(:'beta_doc', '')), 'true');
select pm.val('DV0c FIXTURE: document_versions is empty before this file writes anything',
  $$select count(*)::text from public.document_versions$$, '0');
set role authenticated;
set request.jwt.claims = :'powner_c';
select pm.val('DV0d POSITIVE CONTROL: ALPHA''s Owner holds manage_documents in ALPHA (so a refusal below is not a missing key)',
  format($$select (%L::uuid in (select private.permitted_organisations('manage_documents')))::text$$, :'alpha_org'),
  'true');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- § DV1-DV4 CLOSED.
-- ---------------------------------------------------------------------------
select pm.val('DV1 no API role or service_role holds any write privilege on document_versions (table or column level)',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'document_versions'
       and grantee in ('anon','authenticated','service_role','PUBLIC')
       and privilege_type <> 'SELECT'$$, '0');
select pm.val('DV2 document_versions carries no write policy',
  $$select count(*)::text from pg_policies
     where schemaname = 'public' and tablename = 'document_versions' and cmd <> 'SELECT'$$, '0');
select pm.val('DV3 RLS is on',
  $$select relrowsecurity::text from pg_class where oid = 'public.document_versions'::regclass$$, 'true');

set role authenticated;
set request.jwt.claims = :'powner_c';
select pm.try('DV4 ALPHA''s Owner cannot INSERT a version of ALPHA''s own document -- the write path is absent',
  format($$insert into public.document_versions
             (organisation_id, document_id, version_number, storage_key, mime_type, size_bytes, scan_status)
           values (%L, %L, 1, 'org/t8/dv4', 'application/pdf', 1, 'clean')$$, :'alpha_org', :'alpha_doc'),
  'denied(42501)');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- § DV5-DV12 OPENED -- the smallest wake a Release 1.1 migration would ship.
-- ---------------------------------------------------------------------------
grant insert on public.document_versions to authenticated;
create policy pm_t8_document_versions_insert on public.document_versions
  for insert to authenticated
  with check (organisation_id in (select private.permitted_organisations('manage_documents')));

set role authenticated;
set request.jwt.claims = :'powner_c';
select pm.try('DV5 OPENED: ALPHA''s Owner versions ALPHA''s own document',
  format($$insert into public.document_versions
             (organisation_id, document_id, version_number, storage_key, mime_type, size_bytes, scan_status)
           values (%L, %L, 1, 'org/t8/dv5', 'application/pdf', 1, 'clean')$$, :'alpha_org', :'alpha_doc'),
  'ok(1)');
select pm.try('DV6 OPENED: ...but a version under ALPHA''s id pointing at BETA''s document is refused by the COMPOSITE TENANT FOREIGN KEY',
  format($$insert into public.document_versions
             (organisation_id, document_id, version_number, storage_key, mime_type, size_bytes, scan_status)
           values (%L, %L, 1, 'org/t8/dv6', 'application/pdf', 1, 'clean')$$, :'alpha_org', :'beta_doc'),
  'denied(23503)');
select pm.try('DV7 OPENED: ...and a version filed under BETA is refused by the policy',
  format($$insert into public.document_versions
             (organisation_id, document_id, version_number, storage_key, mime_type, size_bytes, scan_status)
           values (%L, %L, 1, 'org/t8/dv7', 'application/pdf', 1, 'clean')$$, :'beta_org', :'beta_doc'),
  'denied(42501)');
select pm.val('DV8 OPENED: the Owner reads back the version through the existing SELECT policy',
  format($$select count(*)::text from public.document_versions where document_id = %L$$, :'alpha_doc'), '1');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select pm.val('DV9 OPENED: BETA''s Owner reads NONE of ALPHA''s versions -- the tenant fence on the read side holds on the day it matters',
  format($$select count(*)::text from public.document_versions where document_id = %L$$, :'alpha_doc'), '0');
reset role; reset request.jwt.claims;

select pm.val('DV10 OPENED: the audit-coverage census NAMES the new client write the moment it exists (Q122''s derivation, woken)',
  $$select coalesce(array_to_string(uncovered_ops, ','), '<none>') from private.audit_coverage()
     where table_name = 'document_versions'$$, 'INSERT');
select pm.val('DV11 OPENED: exactly one row exists, and it is ALPHA''s',
  format($$select count(*)::text || '/' || count(*) filter (where organisation_id = %L)::text
             from public.document_versions$$, :'alpha_org'), '1/1');

-- ---------------------------------------------------------------------------
-- § DV12-DV15 CLOSED AGAIN, and exactly as this file found it.
-- ---------------------------------------------------------------------------
delete from public.document_versions where storage_key like 'org/t8/%';
drop policy pm_t8_document_versions_insert on public.document_versions;
revoke insert on public.document_versions from authenticated;

select pm.val('DV12 CLOSED AGAIN: no write privilege', $$select count(*)::text from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'document_versions'
       and grantee in ('anon','authenticated','service_role','PUBLIC') and privilege_type <> 'SELECT'$$, '0');
select pm.val('DV13 CLOSED AGAIN: no write policy', $$select count(*)::text from pg_policies
     where schemaname = 'public' and tablename = 'document_versions' and cmd <> 'SELECT'$$, '0');
select pm.val('DV14 CLOSED AGAIN: empty', $$select count(*)::text from public.document_versions$$, '0');
select pm.val('DV15 CLOSED AGAIN: the audit census is back to saying nothing about it',
  $$select count(*)::text from private.audit_coverage() where table_name = 'document_versions'$$, '0');

-- ---------------------------------------------------------------------------
-- § DR ASK EACH DATABASE RULE DIRECTLY (brief requirement 5).
--
-- Found by mutation in this task: removing the DSR insert trigger's
-- no-session refusal (`data_subject_requests: a request can only be made from
-- the requester's own session`, 42501) reddened NO behavioural assertion in
-- any layer -- only the catalogue byte-equality binding noticed the changed
-- body. The suite's one sessionless probe (DW1) is `anon`, which the missing
-- INSERT grant refuses before the trigger runs; and a sessionless `postgres`
-- write is still refused without the rule, by the NEXT check (no email for a
-- null user, 22023) -- a second guard wearing the first one's outcome. So the
-- rule is asked here as itself: by the one writer no grant or policy stops,
-- and the answer must be the RULE's sqlstate and sentence, not merely "denied".
-- ---------------------------------------------------------------------------
create function pm.refusal(p_sql text) returns text
language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $$;

\o /dev/null
select count(*) as dr_before from public.data_subject_requests \gset
\o
select pm.val('DR1 a sessionless postgres INSERT naming a real user is refused BY THE SESSION RULE (42501), not by a later check',
  format($q$select pm.refusal(format(%L, %L))$q$,
    $f$insert into public.data_subject_requests (user_id, user_email, right_type, subject_scope, detail)
       values (%L, 'forged@example.invalid', 'access', 'account', 'filed in somebody else''s name')$f$,
    :'pstd1'),
  '42501:data_subject_requests: a request can only be made from the requester''s own session');
select pm.val('DR2 ...and nothing was filed',
  format($$select (count(*) - %s)::text from public.data_subject_requests$$, :'dr_before'), '0');
select pm.val('DR3 the consent ledger''s twin rule, asked the same way (sessionless postgres, a real user named)',
  format($q$select split_part(pm.refusal(format(%L, %L)), ':', 1)$q$,
    $f$insert into public.consents (user_id, purpose, action, policy_version, mechanism)
       values (%L, 'marketing_email', 'granted', 1, 'account_settings')$f$,
    :'pstd1'),
  '42501');

select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
  from pm.results order by seq;

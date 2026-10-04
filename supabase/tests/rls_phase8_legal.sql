-- ===========================================================================
-- Phase 8 Task 1 (versioned legal documents) RLS suite.
--
-- Covers 20260922000000_legal_documents.sql, its seed (20260922001000) and
-- the fix-round-1 migrations: the TRUNCATE guard (20260922003000), the
-- placeholder-placement CHECKs (20260922004000) and version 2 of four pages
-- (20260922005000); and fix round 2's consistency versions (20260922006000:
-- subprocessors v2, privacy v3, data-processing-addendum v3):
--   public.legal_documents                    the store
--   legal_documents_select_current_published  the one anon-satisfiable policy
--   the column grant                          what anon/authenticated may name
--   private.legal_documents_guard()           immutability, for EVERY role
--   public.operator_legal_document_versions   the superuser's read
--   public.create_legal_document_draft / update_legal_document_draft /
--   publish_legal_document / record_legal_document_counsel_review
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh
--   It runs LAST of the psql suites, on the SAME fixtures (P7VARS), and
--   touches nothing but legal_documents and the audit rows its own RPC calls
--   write. § LZ restores the migrated rows (fifteen documents: nine at
--   version 1, four at version 2, two at version 3, over eight superseded
--   versions -- Task 2 published marketing-preferences v2) exactly and
--   deletes every version and audit row it created -- which needs the guard
--   OFF, so it is done under `session_replication_role = replica`, the DBA
--   escape hatch 20260922000000's header names, as `postgres`, by name.
--
-- THE DENOMINATOR RULE (progress.md, standing lesson 1). Every "X cannot see
-- a draft" assertion is preceded by the superuser's own read proving the
-- draft EXISTS, and every "X is refused" RPC assertion by the same call
-- succeeding for the aal2 superuser with the same arguments. A refusal of
-- nothing is not a pass.
--
-- SECTIONS:
--   LF  fixtures: the seed is what it claims (15 published, unreviewed;
--       9 at version 1, 4 at version 2, 2 at version 3)
--   LG  grants, RLS and the trigger, from the catalogue
--   LA  the public read: anon sees exactly the current published versions
--   LW  no client role can write the table directly -- superuser included
--   LD  drafts: created, invisible to everyone but the operator's RPC
--   LV  the grammar's database half (23514s)
--   LP  publishing: supersede, promote, and what everyone reads afterwards
--   LI  immutability of a published / superseded version, for postgres too
--   LR  counsel review: recorded once, removes nothing but the notice flag
--   LO  the operator read: superuser at aal2 only
--   LH  the audit trail: one row per write, identifiers only, none on refusal
--   LZ  housekeeping: the seed is back exactly as it was
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  no grant, a guard refusal, or a policy refusal
--   denied(22023)  an explicit validation
--   denied(23514)  a CHECK constraint
--   ok(n)          accepted; n rows
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists lg cascade;
create schema lg;

create table lg.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function lg.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into lg.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function lg.try(p_label text, p_sql text, p_expected text)
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
  perform lg.record(p_label, p_expected, v_actual);
end $$;

-- WHO refused, not only how: the SQLSTATE, the innermost PL/pgSQL function in
-- the error context (so a 42501 raised by some OTHER guard, or by the
-- statement itself, cannot pass for this one) and the message. Task 2 review
-- M3: a SQLSTATE alone let LI23 pass with the guard under test disabled.
create function lg.try_raiser(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text; v_ctx text;
begin
  begin
    execute p_sql;
    v_actual := 'ok';
  exception when others then
    get stacked diagnostics v_ctx = pg_exception_context;
    v_actual := 'denied(' || sqlstate || ' by '
             || coalesce(substring(v_ctx from 'function ([A-Za-z0-9_.]+)\('), '<no function>')
             || ': ' || sqlerrm || ')';
  end;
  perform lg.record(p_label, p_expected, v_actual);
end $$;

create function lg.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform lg.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema lg to authenticated, anon, service_role;
grant execute on function lg.record(text,text,text) to authenticated, anon, service_role;
grant execute on function lg.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function lg.val(text,text,text)    to authenticated, anon, service_role;

-- The seed, saved whole, so § LZ can prove it put it back byte for byte.
create table lg.seed_before as select * from public.legal_documents;
select count(*) as audit_before from public.audit_events \gset
-- acceptable-use: a page the fix-round-1 corrections did not touch, so its
-- published version is still the seeded version 1.
select md5(body) as au_md5 from public.legal_documents where slug = 'acceptable-use' \gset
\set anon_c '{"role":"anon"}'

-- ===========================================================================
-- § LF  FIXTURES
-- ===========================================================================
select lg.val('LF1 FIXTURE: the migrations hold exactly 37 rows (30, plus the one Phase 8 Task 6 rewrote because the retention job made the Data Retention page incomplete, plus the one its fix round 1 rewrote because THAT version overclaimed -- review finding I3 -- plus the five Task 9a published when the founder named the hosts on 2026-09-30, Q142/Q145, with Q187''s clause)',
  $$select count(*)::text from public.legal_documents$$, '37');
select lg.val('LF2 FIXTURE: 15 published -- 8 still at version 1, 1 at version 2, 2 at version 3, 1 at version 4, 2 at version 5, 1 at version 7 (Task 9a: privacy 4, DPA 5, security 3, subprocessors 3, data-retention 7)',
  $$select string_agg(version || '=' || n, ',' order by version) from (
      select version, count(*) as n from public.legal_documents where status = 'published' group by version) v$$,
  '1=8,2=1,3=2,4=1,5=2,7=1');
-- WHICH THREE, AND WHAT EACH NOW SAYS. Shipping a feature makes prose about
-- it out of date, and the published version is immutable -- so the DPA's "a
-- self-service export is being built", the rights page's single route to a
-- copy, and the retention schedule's silence about archives each became a new
-- version rather than an edit.
select lg.val('LF2i FIXTURE: the three export corrections are published, unreviewed, and say what the export really does',
  $$select string_agg(slug || ':' || version, ',' order by slug) from public.legal_documents
     where status = 'published' and counsel_reviewed_at is null
       and ((slug = 'data-processing-addendum' and body like '%ACCESS RIGHTS OF THE PERSON WHO ASKED FOR IT%')
         or (slug = 'data-subject-rights' and body like '%you do not need to make a formal request at all%')
         or (slug = 'data-retention' and body like '%**Export archives**%'))$$,
  -- Task 5 moved two of the three on again: data-retention 3 -> 4 and
  -- data-subject-rights 4 -> 5, because erasure made each of those pages
  -- incomplete in the same way the export made them false. The BODY tests
  -- above are unchanged and still have to hold, which is the point of
  -- matching on text rather than on a version number alone.
  -- Task 6's fix round 1 moved data-retention on once more, 5 -> 6 (I3).
  -- Task 9a (founder 2026-09-30, the hosts named) moved DPA 4 -> 5 and
  -- data-retention 6 -> 7; the body tests above still hold on both.
  'data-processing-addendum:5,data-retention:7,data-subject-rights:5');
-- ---------------------------------------------------------------------------
-- PHASE 8 TASK 5. The same shape, for the two pages erasure rewrote.
-- ---------------------------------------------------------------------------
select lg.val('LF2l FIXTURE: the two erasure corrections are published, unreviewed, and say what an erasure keeps',
  $$select string_agg(slug || ':' || version, ',' order by slug) from public.legal_documents
     where status = 'published' and counsel_reviewed_at is null
       and ((slug = 'data-subject-rights'
             and body like '%(/account/erase)%'
             and body like '%erased user%'
             and body like '%only owner of a workspace%')
         or (slug = 'data-retention'
             and body like '%A deleted account:%'
             and body like '%never delete part of an account%'))$$,
  'data-retention:7,data-subject-rights:5');
select lg.val('LF2m ...and the rights page says what SURVIVES an erasure, not just what goes',
  $$select count(*)::text from public.legal_documents
     where status = 'published' and slug = 'data-subject-rights'
       and body like '%Financial records** are kept for seven years%'
       and body like '%the evidence that we answered you inside the legal deadline%'$$, '1');
select lg.val('LF2n DENOMINATOR for LF2l/LF2m: the superseded rights version does NOT',
  $$select count(*)::text from public.legal_documents
     where status = 'superseded' and slug = 'data-subject-rights' and version = 4
       and body like '%(/account/erase)%'$$, '0');
select lg.val('LF2j ...and no CURRENT page still says the export is being built',
  $$select count(*)::text from public.legal_documents
     where status = 'published' and body like '%A self-service export is being built%'$$, '0');
select lg.val('LF2k DENOMINATOR for LF2j: the superseded DPA versions DO say it',
  $$select count(*)::text from public.legal_documents
     where status = 'superseded' and body like '%A self-service export is being built%'$$, '3');
select lg.val('LF2b FIXTURE: the superseded rows are exactly the versions fix rounds 1 and 2 (and Task 2, and Task 3 and its fix round) replaced',
  $$select string_agg(slug || ':' || version, ',' order by slug, version) from public.legal_documents where status = 'superseded'$$,
  'data-processing-addendum:1,data-processing-addendum:2,data-processing-addendum:3,data-processing-addendum:4,data-retention:1,data-retention:2,data-retention:3,data-retention:4,data-retention:5,data-retention:6,data-subject-rights:1,data-subject-rights:2,data-subject-rights:3,data-subject-rights:4,marketing-preferences:1,privacy:1,privacy:2,privacy:3,security:1,security:2,subprocessors:1,subprocessors:2');
-- ---------------------------------------------------------------------------
-- PHASE 8 TASK 9a (founder 2026-09-30). Q145 named the database region and
-- Q142 the application host, so no current page may still mark the region
-- as a deployment setting or say the host is unlisted -- and the versions
-- they superseded DID, so the zero below is a zero over a real population.
-- ---------------------------------------------------------------------------
select lg.val('LF2o FIXTURE: the four hosting pages name Ireland (eu-west-1) and IONOS SE, and no current page marks the region or calls the host unlisted',
  $$select (select string_agg(slug || ':' || version, ',' order by slug) from public.legal_documents
             where status = 'published' and counsel_reviewed_at is null and body like '%IONOS SE%'
               and (slug = 'subprocessors' or body like '%hosted by Supabase in Ireland (eu-west-1)%'))
        || '/' ||
        (select count(*)::text from public.legal_documents
          where status = 'published'
            and (body like '%region **(deployment setting)**%'
              or body like '%The region is chosen in our hosting account%'
              or body like '%not yet listed%'))$$,
  'data-processing-addendum:5,privacy:4,security:3,subprocessors:3/0');
select lg.val('LF2p DENOMINATOR for LF2o: exactly the four versions Task 9a superseded DO carry one',
  $$select string_agg(slug || ':' || version, ',' order by slug, version) from public.legal_documents
     where status = 'superseded'
       and version = (select max(s.version) from public.legal_documents s
                       where s.slug = legal_documents.slug and s.status = 'superseded')
       and (body like '%region **(deployment setting)**%'
         or body like '%The region is chosen in our hosting account%'
         or body like '%not yet listed%')$$,
  'data-processing-addendum:4,privacy:3,security:2,subprocessors:2');
select lg.val('LF2q Q187: the current retention page says a document''s period is judged when it is deleted; the version it superseded did not',
  $$select string_agg(version || ':' || status, ',' order by version) from public.legal_documents
     where slug = 'data-retention' and version in (6, 7)
       and body like '%judged when the document is deleted%'$$,
  '7:published');
select lg.val('LF2c FIXTURE: no current page repeats a version 1 overclaim (I2, M1, M2)',
  $$select count(*)::text from public.legal_documents
     where status = 'published'
       and (body like '%We do not transfer personal data outside%'
         or body like '%The only subprocessor outside the UK%'
         or body like '%outside the default view%'
         or body like '%which encrypts stored data%'
         or body like '%You are signed out after 30 minutes without activity.%'
         or body like '%We monitor the alerts above%')$$, '0');
select lg.val('LF2d DENOMINATOR for LF2c: the superseded versions DO carry them',
  $$select count(*)::text from public.legal_documents
     where status = 'superseded'
       and (body like '%We do not transfer personal data outside%'
         or body like '%The only subprocessor outside the UK%'
         or body like '%outside the default view%'
         or body like '%which encrypts stored data%')$$, '4');
select lg.val('LF2g FIXTURE: no current page claims the subprocessor list is complete or states the region flat (fix round 2)',
  $$select count(*)::text from public.legal_documents
     where status = 'published'
       and (body like '%before it receives any personal data%'
         or body ~ 'hosted in (the|a) UK/EU region\.')$$, '0');
select lg.val('LF2h DENOMINATOR for LF2g: exactly these five superseded versions DO carry one',
  $$select string_agg(slug || ':' || version, ',' order by slug, version) from public.legal_documents
     where status = 'superseded'
       and (body like '%before it receives any personal data%'
         or body ~ 'hosted in (the|a) UK/EU region\.')$$,
  'data-processing-addendum:1,data-processing-addendum:2,privacy:1,privacy:2,subprocessors:1');
select lg.val('LF2e FIXTURE: the security page attributes the encryption claim and marks deployment settings',
  $$select (body like '%Supabase states that it encrypts%' and body like '%have not verified%'
            and (length(body) - length(replace(body, '(deployment setting)', ''))) / length('(deployment setting)') >= 6)::text
      from public.legal_documents where slug = 'security' and status = 'published'$$, 'true');
select lg.val('LF3 FIXTURE: none carries a counsel review (the seed claims no review)',
  $$select count(*)::text from public.legal_documents
     where counsel_reviewed_at is not null or counsel_reviewer is not null
        or counsel_review_recorded_by is not null$$, '0');
select lg.val('LF4 FIXTURE: 15 distinct slugs',
  $$select count(distinct slug)::text from public.legal_documents$$, '15');
select lg.val('LF5 FIXTURE: `super` is on the platform_admins allowlist',
  format($$select count(*)::text from public.platform_admins where user_id=%L$$, :'super'), '1');
select lg.val('LF6 FIXTURE: the seed commits no email address',
  $$select count(*)::text from public.legal_documents where body ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]'$$, '0');

-- ===========================================================================
-- § LG  THE CATALOGUE
-- ===========================================================================
select lg.val('LG1 RLS is enabled on legal_documents',
  $$select relrowsecurity::text from pg_class where oid = 'public.legal_documents'::regclass$$, 'true');
select lg.val('LG2 exactly one policy, SELECT, for anon and authenticated',
  $$select string_agg(polname::text || ':' || polcmd::text || ':' ||
            (select string_agg(r::regrole::text, ',' order by r::regrole::text) from unnest(polroles) r), ';')
      from pg_policy where polrelid = 'public.legal_documents'::regclass$$,
  'legal_documents_select_current_published:r:anon,authenticated');
select lg.val('LG3 anon may SELECT exactly the eight public columns',
  $$select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
     where table_schema='public' and table_name='legal_documents' and grantee='anon' and privilege_type='SELECT'$$,
  'body,counsel_reviewed_at,effective_date,id,published_at,slug,title,version');
select lg.val('LG4 ...and authenticated the same eight -- the reviewer name is outside both',
  $$select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
     where table_schema='public' and table_name='legal_documents' and grantee='authenticated' and privilege_type='SELECT'$$,
  'body,counsel_reviewed_at,effective_date,id,published_at,slug,title,version');
select lg.val('LG5 no client role holds any write privilege, at table or column level',
  $$select count(*)::text from (
      select grantee from information_schema.role_table_grants
       where table_schema='public' and table_name='legal_documents'
         and grantee in ('anon','authenticated','service_role') and privilege_type <> 'SELECT'
      union all
      select grantee from information_schema.column_privileges
       where table_schema='public' and table_name='legal_documents'
         and grantee in ('anon','authenticated','service_role') and privilege_type <> 'SELECT') g$$,
  '0');
select lg.val('LG6 service_role holds nothing at all',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema='public' and table_name='legal_documents' and grantee='service_role'$$, '0');
select lg.val('LG7 the guard trigger exists, is enabled, and covers insert/update/delete',
  $$select string_agg(tgenabled::text || ':' || (tgtype & 28)::text, ',') from pg_trigger
     where tgrelid = 'public.legal_documents'::regclass and tgname = 'legal_documents_guard'$$,
  'O:28');
select lg.val('LG7b exactly three user triggers, and the row guard sorts BEFORE set_updated_at (20260922002000)',
  $$select string_agg(tgname, ',' order by tgname) from pg_trigger
     where tgrelid = 'public.legal_documents'::regclass and not tgisinternal$$,
  'legal_documents_guard,legal_documents_truncate_guard,set_updated_at');
select lg.val('LG7c the TRUNCATE guard is enabled, BEFORE, statement-level, on TRUNCATE only (20260922003000)',
  $$select tgenabled::text || ':' || (tgtype & 60)::text || ':' || (tgtype & 2)::text || ':' || (tgtype & 1)::text
      from pg_trigger
     where tgrelid = 'public.legal_documents'::regclass and tgname = 'legal_documents_truncate_guard'$$,
  'O:32:2:0');
select lg.val('LG8 the five RPCs are granted to authenticated and NOT to anon',
  $$select string_agg(p.proname || '=' ||
            has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '/' ||
            has_function_privilege('anon', p.oid, 'EXECUTE')::text, ',' order by p.proname)
      from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('operator_legal_document_versions','create_legal_document_draft',
                         'update_legal_document_draft','publish_legal_document',
                         'record_legal_document_counsel_review')$$,
  'create_legal_document_draft=true/false,operator_legal_document_versions=true/false,publish_legal_document=true/false,record_legal_document_counsel_review=true/false,update_legal_document_draft=true/false');
select lg.val('LG9 the guard functions are callable by no client role',
  $$select (has_function_privilege('authenticated', 'private.legal_documents_guard()', 'EXECUTE')
         or has_function_privilege('anon', 'private.legal_documents_guard()', 'EXECUTE')
         or has_function_privilege('authenticated', 'private.legal_documents_truncate_guard()', 'EXECUTE')
         or has_function_privilege('anon', 'private.legal_documents_truncate_guard()', 'EXECUTE'))::text$$,
  'false');

-- ===========================================================================
-- § LA  THE PUBLIC READ
-- ===========================================================================
set role anon;
set request.jwt.claims = :'anon_c';
select lg.val('LA1 anon reads 15 rows -- the current published version of each document',
  $$select count(*)::text from public.legal_documents$$, '15');
select lg.val('LA2 ...one per slug',
  $$select count(distinct slug)::text from public.legal_documents$$, '15');
select lg.val('LA3 anon reads a body (the positive control for the column grant)',
  $$select (length(body) > 100)::text from public.legal_documents where slug = 'privacy'$$, 'true');
select lg.val('LA4 anon reads counsel_reviewed_at (null: the page shows the notice)',
  $$select coalesce(counsel_reviewed_at::text, 'unreviewed') from public.legal_documents where slug = 'terms'$$,
  'unreviewed');
select lg.try('LA5 anon cannot name counsel_reviewer (outside the grant)',
  $$select counsel_reviewer from public.legal_documents$$, 'denied(42501)');
select lg.try('LA6 anon cannot name status',
  $$select status from public.legal_documents$$, 'denied(42501)');
select lg.try('LA7 anon cannot name published_by',
  $$select published_by from public.legal_documents$$, 'denied(42501)');
select lg.try('LA8 anon cannot select * (the grant is column-level)',
  $$select * from public.legal_documents$$, 'denied(42501)');
select lg.try('LA9 anon cannot call the operator read',
  $$select * from public.operator_legal_document_versions(null)$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § LW  NO DIRECT WRITES, FROM ANY CLIENT ROLE
-- ===========================================================================
-- The superuser at aal2 is the sharpest case: the principal every RPC trusts
-- is still refused at the GRANT, so a raw PostgREST PATCH from the operator's
-- own browser cannot bypass the audited path.
set role authenticated;
set request.jwt.claims = :'super_c';
select lg.try('LW1 the aal2 superuser cannot UPDATE a published row directly',
  $$update public.legal_documents set title = 'x' where slug = 'terms'$$, 'denied(42501)');
select lg.try('LW2 ...cannot DELETE one',
  $$delete from public.legal_documents where slug = 'terms'$$, 'denied(42501)');
select lg.try('LW3 ...cannot INSERT a draft directly',
  $$insert into public.legal_documents (slug, version, title, body, effective_date)
    values ('terms', 99, 't', 'b', current_date)$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select lg.try('LW4 an aal2 Org Owner cannot UPDATE a published row',
  $$update public.legal_documents set title = 'x'$$, 'denied(42501)');
select lg.try('LW5 ...cannot DELETE one',
  $$delete from public.legal_documents$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role anon;
set request.jwt.claims = :'anon_c';
select lg.try('LW6 anon cannot UPDATE',
  $$update public.legal_documents set title = 'x'$$, 'denied(42501)');
select lg.try('LW7 anon cannot INSERT',
  $$insert into public.legal_documents (slug, version, title, body, effective_date)
    values ('terms', 98, 't', 'b', current_date)$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role service_role;
select lg.try('LW8 service_role cannot UPDATE either (no grant; BYPASSRLS bypasses policies, not grants)',
  $$update public.legal_documents set title = 'x'$$, 'denied(42501)');
reset role;
select lg.val('LW9 after all of that, the table is exactly the seed',
  $$select (select count(*) from (select * from public.legal_documents
                                   except select * from lg.seed_before) d)::text$$, '0');

-- ===========================================================================
-- § LD  DRAFTS
-- ===========================================================================
-- Refusals FIRST, with the arguments the superuser then succeeds with.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select lg.try('LD1 a Manager cannot create a draft',
  $$select public.create_legal_document_draft('terms')$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select lg.try('LD2 an aal2 Org Owner cannot create a draft',
  $$select public.create_legal_document_draft('terms')$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c1';
select lg.try('LD3 the superuser at aal1 cannot create a draft',
  $$select public.create_legal_document_draft('terms')$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role anon;
set request.jwt.claims = :'anon_c';
select lg.try('LD4 anon cannot create a draft',
  $$select public.create_legal_document_draft('terms')$$, 'denied(42501)');
reset role; reset request.jwt.claims;
select lg.val('LD5 ...and none of those four refusals created a row',
  $$select count(*)::text from public.legal_documents where status = 'draft'$$, '0');

set role authenticated;
set request.jwt.claims = :'super_c';
select lg.try('LD6 POSITIVE CONTROL: the aal2 superuser creates a draft of terms',
  $$select public.create_legal_document_draft('terms')$$, 'ok(1)');
select lg.try('LD7 a second draft of the same document is refused',
  $$select public.create_legal_document_draft('terms')$$, 'denied(22023)');
select lg.try('LD8 an unknown slug is refused',
  $$select public.create_legal_document_draft('not-a-page')$$, 'denied(22023)');
select lg.try('LD9 a draft of cookies too (used by § LV)',
  $$select public.create_legal_document_draft('cookies')$$, 'ok(1)');
reset role; reset request.jwt.claims;

\o /dev/null
select id as terms_draft from public.legal_documents where slug = 'terms' and status = 'draft' \gset
select id as cookies_draft from public.legal_documents where slug = 'cookies' and status = 'draft' \gset
select id as terms_v1 from public.legal_documents where slug = 'terms' and version = 1 \gset
\o

select lg.val('LD10 DENOMINATOR: the terms draft exists, as version 2, copied from version 1',
  format($$select version || ':' || (body = (select body from public.legal_documents where id = %L))::text
             from public.legal_documents where id = %L$$, :'terms_v1', :'terms_draft'),
  '2:true');
select lg.val('LD11 ...with no review and no publish stamp',
  format($$select (counsel_reviewed_at is null and published_at is null and published_by is null)::text
             from public.legal_documents where id = %L$$, :'terms_draft'), 'true');

set role anon;
set request.jwt.claims = :'anon_c';
select lg.val('LD12 anon still reads 15 rows, and no draft among them',
  $$select count(*)::text from public.legal_documents$$, '15');
select lg.val('LD13 anon reads version 1 of terms, not the draft',
  $$select string_agg(version::text, ',') from public.legal_documents where slug = 'terms'$$, '1');
select lg.val('LD14 anon cannot read the draft by id',
  format($$select count(*)::text from public.legal_documents where id = %L$$, :'terms_draft'), '0');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select lg.val('LD15 an aal2 Org Owner cannot read the draft by id',
  format($$select count(*)::text from public.legal_documents where id = %L$$, :'terms_draft'), '0');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pro_c';
select lg.val('LD16 a Read Only member cannot read the draft by id',
  format($$select count(*)::text from public.legal_documents where id = %L$$, :'terms_draft'), '0');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';
select lg.val('LD17 even the aal2 superuser cannot read the draft through the TABLE (only the RPC)',
  format($$select count(*)::text from public.legal_documents where id = %L$$, :'terms_draft'), '0');
reset role; reset request.jwt.claims;

-- Editing the draft: refusals, then the control.
set role authenticated;
set request.jwt.claims = :'powner_c';
select lg.try('LD18 an aal2 Org Owner cannot edit the draft',
  format($$select public.update_legal_document_draft(%L, 'Terms of Service', 'Hijacked', current_date)$$,
         :'terms_draft'), 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';
select lg.try('LD19 POSITIVE CONTROL: the superuser edits the draft',
  format($$select public.update_legal_document_draft(%L, 'Terms of Service',
             E'## Changed\n\nSENTINEL-BODY-7f3a version two text.', date '2026-10-01')$$,
         :'terms_draft'), 'ok(1)');
select lg.try('LD20 editing a PUBLISHED id through the RPC is refused as not-a-draft',
  format($$select public.update_legal_document_draft(%L, 'x', 'y', current_date)$$, :'terms_v1'),
  'denied(22023)');
select lg.try('LD21 a null body is refused',
  format($$select public.update_legal_document_draft(%L, 'x', null, current_date)$$, :'terms_draft'),
  'denied(22023)');
reset role; reset request.jwt.claims;
select lg.val('LD22 the edit landed on the draft, and version 1 is untouched',
  format($$select (select body like '%%SENTINEL-BODY-7f3a%%' from public.legal_documents where id = %L)::text
             || ':' || (select count(*) from (select * from public.legal_documents where id = %L
                                              except select * from lg.seed_before) d)::text$$,
         :'terms_draft', :'terms_v1'),
  'true:0');

-- ===========================================================================
-- § LV  THE GRAMMAR'S DATABASE HALF
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select lg.try('LV1 a javascript: link is refused by CHECK',
  format($$select public.update_legal_document_draft(%L, 'T', '[x](javascript:alert(1))', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV2 a JavaScript: link in another case is refused',
  format($$select public.update_legal_document_draft(%L, 'T', '[x](JavaScript:alert(1))', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV3 a data: link is refused',
  format($$select public.update_legal_document_draft(%L, 'T', '[x](data:text/html,x)', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV4 a scheme-relative //host link is refused',
  format($$select public.update_legal_document_draft(%L, 'T', '[x](//evil.example)', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV5 a link with a leading space is refused',
  format($$select public.update_legal_document_draft(%L, 'T', '[x]( javascript:x)', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV6 a <script> tag is refused',
  format($$select public.update_legal_document_draft(%L, 'T', '<script>alert(1)</script>', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV7 an unknown {{placeholder}} is refused',
  format($$select public.update_legal_document_draft(%L, 'T', 'a {{service_role_key}} b', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV8 the Cookie Policy cannot lose its storage table',
  format($$select public.update_legal_document_draft(%L, 'Cookie Policy', 'No table.', current_date)$$,
         :'cookies_draft'), 'denied(23514)');
select lg.try('LV9 an over-long title is refused',
  format($$select public.update_legal_document_draft(%L, repeat('t', 201), 'b', current_date)$$,
         :'terms_draft'), 'denied(23514)');
-- Fix round 1, M4: the scheme is lower case only -- the CHECK always said
-- so, and the parser now agrees.
select lg.try('LV9b an HTTPS:// link (upper case) is refused, as the editor now refuses it',
  format($$select public.update_legal_document_draft(%L, 'T', '[x](HTTPS://ico.org.uk/)', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV9c a MAILTO: link (upper case) is refused',
  format($$select public.update_legal_document_draft(%L, 'T', '[x](MAILTO:x@example.test)', current_date)$$,
         :'terms_draft'), 'denied(23514)');
-- Fix round 1, M3: a placeholder only where it renders
-- (legal_documents_body_placeholders_placed, 20260922004000).
select lg.try('LV9d {{support_email}} inside bold is refused',
  format($$select public.update_legal_document_draft(%L, 'T', 'Email **{{support_email}}** today.', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV9e {{support_email}} as link text is refused',
  format($$select public.update_legal_document_draft(%L, 'T', '[{{support_email}}](/legal/contact)', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV9f {{support_email}} inside a link target is refused (the links CHECK alone allowed it)',
  format($$select public.update_legal_document_draft(%L, 'T', '[write](/legal/x{{support_email}})', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV9g bold either side of a placeholder on one line is refused (conservative, like the editor)',
  format($$select public.update_legal_document_draft(%L, 'T', '**Email** {{support_email}} or **call**', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV9h the Cookie Policy with its table mid-sentence is refused',
  format($$select public.update_legal_document_draft(%L, 'Cookie Policy', 'Our storage: {{storage_inventory}}', current_date)$$,
         :'cookies_draft'), 'denied(23514)');
select lg.try('LV9i ...as a heading',
  format($$select public.update_legal_document_draft(%L, 'Cookie Policy', E'Intro

## {{storage_inventory}}', current_date)$$,
         :'cookies_draft'), 'denied(23514)');
select lg.try('LV9j ...as a list item',
  format($$select public.update_legal_document_draft(%L, 'Cookie Policy', E'Intro

- {{storage_inventory}}', current_date)$$,
         :'cookies_draft'), 'denied(23514)');
select lg.try('LV9k a block placeholder inline on a page that does not need one is refused too',
  format($$select public.update_legal_document_draft(%L, 'T', 'Our providers: {{subprocessors}}', current_date)$$,
         :'terms_draft'), 'denied(23514)');
select lg.try('LV9l CONTROL: the Cookie Policy with its table alone on an indented, CR-terminated line is accepted',
  format($$select public.update_legal_document_draft(%L, 'Cookie Policy', E'Intro
  {{storage_inventory}}	
More.', current_date)$$,
         :'cookies_draft'), 'ok(1)');
select lg.try('LV9m CONTROL: an inline {{support_email}} beside bold on another line is accepted',
  format($$select public.update_legal_document_draft(%L, 'T', E'**Bold** first.
Write to {{support_email}}.', current_date)$$,
         :'terms_draft'), 'ok(1)');
select lg.try('LV10 CONTROL: https, mailto and same-site links, and a bare <, are accepted',
  format($$select public.update_legal_document_draft(%L, 'Terms of Service',
             E'## Changed\n\nSENTINEL-BODY-7f3a see [a](https://ico.org.uk/) [b](mailto:x@example.test) [c](/legal/privacy), 3 < 4.',
             date '2026-10-01')$$, :'terms_draft'), 'ok(1)');
select lg.try('LV11 CONTROL: the Cookie Policy keeping its table is accepted',
  format($$select public.update_legal_document_draft(%L, 'Cookie Policy', E'Intro.\n\n{{storage_inventory}}', current_date)$$,
         :'cookies_draft'), 'ok(1)');
reset role; reset request.jwt.claims;
select lg.val('LV12 the refused edits changed nothing: the draft holds the LV10 text',
  format($$select (body like '%%(mailto:x@example.test)%%')::text from public.legal_documents where id = %L$$,
         :'terms_draft'), 'true');

-- ===========================================================================
-- § LR (part 1)  A REVIEW OF A DRAFT, CLEARED BY AN EDIT
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select lg.try('LR1 a Manager cannot record a counsel review',
  format($$select public.record_legal_document_counsel_review(%L, 'Some Firm LLP')$$, :'terms_draft'),
  'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c1';
select lg.try('LR2 the aal1 superuser cannot record a counsel review',
  format($$select public.record_legal_document_counsel_review(%L, 'Some Firm LLP')$$, :'terms_draft'),
  'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';
select lg.try('LR3 a blank reviewer is refused',
  format($$select public.record_legal_document_counsel_review(%L, '   ')$$, :'terms_draft'),
  'denied(22023)');
select lg.try('LR4 POSITIVE CONTROL: the superuser records a review of the draft',
  format($$select public.record_legal_document_counsel_review(%L, 'SENTINEL-REVIEWER-91c2 LLP')$$, :'terms_draft'),
  'ok(1)');
select lg.try('LR5 a second review of the same version is refused',
  format($$select public.record_legal_document_counsel_review(%L, 'Other LLP')$$, :'terms_draft'),
  'denied(22023)');
select lg.try('LR6 an unchanged save keeps the review',
  format($$select public.update_legal_document_draft(%L, 'Terms of Service',
             E'## Changed\n\nSENTINEL-BODY-7f3a see [a](https://ico.org.uk/) [b](mailto:x@example.test) [c](/legal/privacy), 3 < 4.',
             date '2026-10-01')$$, :'terms_draft'), 'ok(1)');
reset role; reset request.jwt.claims;
select lg.val('LR7 ...measured: the review is still there',
  format($$select (counsel_reviewed_at is not null)::text from public.legal_documents where id = %L$$,
         :'terms_draft'), 'true');
set role authenticated;
set request.jwt.claims = :'super_c';
select lg.try('LR8 a CHANGED save clears it (a review is of a text)',
  format($$select public.update_legal_document_draft(%L, 'Terms of Service',
             E'## Changed again\n\nSENTINEL-BODY-7f3a revised.', date '2026-10-01')$$, :'terms_draft'), 'ok(1)');
reset role; reset request.jwt.claims;
select lg.val('LR9 ...measured: review, reviewer and recorder all cleared',
  format($$select (counsel_reviewed_at is null and counsel_reviewer is null
                   and counsel_review_recorded_by is null)::text
             from public.legal_documents where id = %L$$, :'terms_draft'), 'true');
set role authenticated;
set request.jwt.claims = :'super_c';
select lg.try('LR10 the draft is reviewed again, for publishing reviewed (§ LP)',
  format($$select public.record_legal_document_counsel_review(%L, 'SENTINEL-REVIEWER-91c2 LLP')$$, :'terms_draft'),
  'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § LP  PUBLISHING
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'powner_c';
select lg.try('LP1 an aal2 Org Owner cannot publish',
  format($$select public.publish_legal_document(%L)$$, :'terms_draft'), 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c1';
select lg.try('LP2 the aal1 superuser cannot publish',
  format($$select public.publish_legal_document(%L)$$, :'terms_draft'), 'denied(42501)');
reset role; reset request.jwt.claims;
set role anon;
set request.jwt.claims = :'anon_c';
select lg.try('LP3 anon cannot publish',
  format($$select public.publish_legal_document(%L)$$, :'terms_draft'), 'denied(42501)');
reset role; reset request.jwt.claims;
select lg.val('LP4 ...and terms is still at version 1 publicly',
  $$select string_agg(version::text || ':' || status, ',') from public.legal_documents
     where slug = 'terms' and status <> 'draft'$$, '1:published');

set role authenticated;
set request.jwt.claims = :'super_c';
select lg.try('LP5 POSITIVE CONTROL: the superuser publishes the terms draft',
  format($$select public.publish_legal_document(%L)$$, :'terms_draft'), 'ok(1)');
select lg.try('LP6 publishing it again is refused (it is no longer a draft)',
  format($$select public.publish_legal_document(%L)$$, :'terms_draft'), 'denied(22023)');
select lg.try('LP7 publishing the SUPERSEDED version is refused',
  format($$select public.publish_legal_document(%L)$$, :'terms_v1'), 'denied(22023)');
reset role; reset request.jwt.claims;

select lg.val('LP8 terms: version 1 superseded (stamped), version 2 published by `super`',
  format($$select string_agg(version::text || ':' || status || ':' ||
                   (case when status = 'superseded' then (superseded_at is not null)::text
                         else (published_by = %L)::text end), ',' order by version)
             from public.legal_documents where slug = 'terms'$$, :'super'),
  '1:superseded:true,2:published:true');
select lg.val('LP9 still exactly one published row per slug, for all 15',
  $$select count(*)::text from (select slug from public.legal_documents where status = 'published'
                                 group by slug having count(*) = 1) s$$, '15');

set role anon;
set request.jwt.claims = :'anon_c';
select lg.val('LP10 anon now reads version 2 of terms -- the new text, reviewed',
  $$select version || ':' || (body like '%SENTINEL-BODY-7f3a%')::text || ':' || (counsel_reviewed_at is not null)::text
      from public.legal_documents where slug = 'terms'$$, '2:true:true');
select lg.val('LP11 anon still reads 15 rows -- the superseded version is gone from view',
  $$select count(*)::text from public.legal_documents$$, '15');
select lg.val('LP12 anon cannot read superseded version 1 by id',
  format($$select count(*)::text from public.legal_documents where id = %L$$, :'terms_v1'), '0');
select lg.val('LP13 anon reads the other 14 unchanged, all unreviewed',
  $$select count(*)::text from public.legal_documents where slug <> 'terms' and counsel_reviewed_at is null$$, '14');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select lg.val('LP14 a foreign Org Owner reads the same: version 2, and not version 1',
  $$select string_agg(version::text, ',') from public.legal_documents where slug = 'terms'$$, '2');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § LI  IMMUTABILITY -- AS POSTGRES, WHICH HOLDS EVERY PRIVILEGE
-- ===========================================================================
-- The grant refused every client above. These run as the table OWNER, so only
-- the trigger stands in the way -- which is the property: no role edits a
-- published text.
select lg.try('LI1 postgres cannot change the body of the published version',
  format($$update public.legal_documents set body = body || ' tampered' where id = %L$$, :'terms_draft'),
  'denied(42501)');
select lg.try('LI2 ...nor its title',
  format($$update public.legal_documents set title = 'Tampered' where id = %L$$, :'terms_draft'),
  'denied(42501)');
select lg.try('LI3 ...nor its effective date',
  format($$update public.legal_documents set effective_date = date '2020-01-01' where id = %L$$, :'terms_draft'),
  'denied(42501)');
select lg.try('LI4 ...nor its published_at',
  format($$update public.legal_documents set published_at = now() - interval '1 year' where id = %L$$, :'terms_draft'),
  'denied(42501)');
select lg.try('LI5 ...nor send it back to draft',
  format($$update public.legal_documents set status = 'draft', published_at = null where id = %L$$, :'terms_draft'),
  'denied(42501)');
select lg.try('LI6 ...nor change its recorded review',
  format($$update public.legal_documents set counsel_reviewer = 'Someone else' where id = %L$$, :'terms_draft'),
  'denied(42501)');
select lg.try('LI7 ...nor withdraw that review',
  format($$update public.legal_documents set counsel_reviewed_at = null, counsel_reviewer = null where id = %L$$,
         :'terms_draft'), 'denied(42501)');
select lg.try('LI8 ...nor reassign who published it',
  format($$update public.legal_documents set published_by = %L where id = %L$$, :'pmanager', :'terms_draft'),
  'denied(42501)');
select lg.try('LI9 ...nor delete it',
  format($$delete from public.legal_documents where id = %L$$, :'terms_draft'), 'denied(42501)');
select lg.try('LI10 postgres cannot change the SUPERSEDED body',
  format($$update public.legal_documents set body = 'tampered' where id = %L$$, :'terms_v1'), 'denied(42501)');
select lg.try('LI11 ...nor revive it',
  format($$update public.legal_documents set status = 'published', superseded_at = null where id = %L$$, :'terms_v1'),
  'denied(42501)');
select lg.try('LI12 ...nor delete it',
  format($$delete from public.legal_documents where id = %L$$, :'terms_v1'), 'denied(42501)');
select lg.try('LI13 ...nor mark it reviewed after the fact',
  format($$update public.legal_documents set counsel_reviewed_at = now(), counsel_reviewer = 'X' where id = %L$$,
         :'terms_v1'), 'denied(42501)');
select lg.try('LI14 postgres cannot INSERT a version already published',
  $$insert into public.legal_documents (slug, version, title, body, effective_date, status, published_at)
    values ('terms', 50, 'T', 'B', current_date, 'published', now())$$, 'denied(42501)');
select lg.try('LI15 postgres cannot INSERT a draft that claims a review',
  $$insert into public.legal_documents (slug, version, title, body, effective_date, counsel_reviewed_at, counsel_reviewer)
    values ('terms', 51, 'T', 'B', current_date, now(), 'Nobody')$$, 'denied(42501)');
select lg.try('LI16 postgres cannot change a published row''s slug or version',
  format($$update public.legal_documents set version = 99 where id = %L$$, :'terms_draft'), 'denied(42501)');
select lg.try('LI17 a second PUBLISHED row for one slug is refused by the unique index',
  format($$update public.legal_documents set status = 'published', published_at = now()
             where id = %L$$, :'cookies_draft'), 'denied(23505)');
-- The one change the guard ALLOWS on a frozen row: erasing attribution, which
-- is what ON DELETE SET NULL does when an account is erased. Proved on the
-- row, not argued, so the erasure task (Q130) does not find the guard
-- blocking it.
select lg.try('LI18 ALLOWED: erasing who published it (ON DELETE SET NULL)',
  format($$update public.legal_documents set published_by = null, counsel_review_recorded_by = null
             where id = %L$$, :'terms_draft'), 'ok(1)');
-- A different outer quote tag: `$d$$$` would close a `$$` string early.
select lg.try('LI19 ALLOWED: superseding it (the publish RPC''s own step), done and undone in a subtransaction',
  format($q$do $d$ begin
             update public.legal_documents set status = 'superseded', superseded_at = now() where id = %L;
             raise exception 'rollback' using errcode = 'P0001';
           end $d$$q$, :'terms_draft'),
  'denied(P0001)');
select lg.val('LI20 after every attempt, version 2''s text, title, date and review are intact',
  format($$select (body like '%%SENTINEL-BODY-7f3a revised.%%' and title = 'Terms of Service'
                   and effective_date = date '2026-10-01' and status = 'published'
                   and counsel_reviewer = 'SENTINEL-REVIEWER-91c2 LLP')::text
             from public.legal_documents where id = %L$$, :'terms_draft'), 'true');
select lg.val('LI21 ...and version 1 is byte-for-byte the seed apart from its supersede stamp',
  format($$select (d.title, d.body, d.effective_date, d.published_at, d.counsel_reviewed_at)
                  is not distinct from (s.title, s.body, s.effective_date, s.published_at, s.counsel_reviewed_at)
             from public.legal_documents d join lg.seed_before s using (id) where d.id = %L$$, :'terms_v1'),
  'true');

-- Fix round 1, M7: a row trigger never sees a TRUNCATE; the statement guard
-- does (20260922003000).
select count(*) as rows_before_truncate from public.legal_documents \gset
-- PHASE 8 TASK 2 CHANGED WHAT A PLAIN TRUNCATE MEETS FIRST. public.consents
-- now holds a foreign key to (slug, version), and Postgres refuses to TRUNCATE
-- a referenced table without CASCADE (0A000) before any trigger runs -- which
-- would make "refused" true here whether or not the guard exists. So LI22 now
-- takes the foreign key out of the way INSIDE the probe (a subtransaction that
-- always ends in an error, so the DROP never survives) and asks the guard
-- itself; LI22a records the FK's own refusal as the second layer it is.
\set legal_truncate_refusal 'denied(42501 by private.legal_documents_truncate_guard: legal_documents: the legal store cannot be truncated -- published versions are immutable, and a draft is deleted row by row)'
select lg.try_raiser('LI22 postgres cannot TRUNCATE the legal store -- refused by THE LEGAL GUARD (consents FK out of the way)',
  $q$do $d$ begin
      alter table public.consents drop constraint consents_policy_version_fkey;
      truncate public.legal_documents;
      raise exception 'TRUNCATE SUCCEEDED' using errcode = 'P0099';
    end $d$ $q$, :'legal_truncate_refusal');
select lg.try('LI22a ...and a plain TRUNCATE is also refused by the consents foreign key (Task 2)',
  $$truncate public.legal_documents$$, 'denied(0A000)');
-- LI23: with the FK in place, CASCADE would also truncate public.consents and
-- its own guard (consents_truncate_guard) answers -- measured by the Task 2
-- review with the legal guard DISABLED, LI23 still returned 42501. So LI23
-- takes the FK out of the way too; CASCADE then reaches only the legal store,
-- and the raiser is asserted by name.
select lg.try_raiser('LI23 ...nor with RESTART IDENTITY CASCADE -- refused by THE LEGAL GUARD (consents FK out of the way)',
  $q$do $d$ begin
      alter table public.consents drop constraint consents_policy_version_fkey;
      truncate public.legal_documents restart identity cascade;
      raise exception 'TRUNCATE SUCCEEDED' using errcode = 'P0099';
    end $d$ $q$, :'legal_truncate_refusal');
select lg.val('LI22b ...the consents foreign key is still in place after LI22 and LI23',
  $$select count(*)::text from pg_constraint where conname = 'consents_policy_version_fkey'$$, '1');
-- With the FK in place, CASCADE reaches both tables and two guards stand in
-- its way; which answers first is an ordering detail, so only the refusal is
-- asserted here -- LI23 above is the one that names the legal guard.
select lg.try('LI23a ...and with the FK in place, CASCADE is refused too (by one of the two guards)',
  $$truncate public.legal_documents restart identity cascade$$, 'denied(42501)');
select lg.val('LI24 ...and every row is still there',
  format($$select (count(*) = %s and %s > 15)::text from public.legal_documents$$,
         :rows_before_truncate, :rows_before_truncate), 'true');

-- ===========================================================================
-- § LR (part 2)  A REVIEW OF THE CURRENT PUBLISHED VERSION
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select lg.try('LR11 a review of a SUPERSEDED version is refused',
  format($$select public.record_legal_document_counsel_review(%L, 'X LLP')$$, :'terms_v1'), 'denied(22023)');
select lg.try('LR12 POSITIVE CONTROL: the superuser records a review of the published acceptable use policy',
  $$select public.record_legal_document_counsel_review(
      (select id from public.operator_legal_document_versions('acceptable-use') where status = 'published'),
      'SENTINEL-REVIEWER-91c2 LLP')$$, 'ok(1)');
reset role; reset request.jwt.claims;
set role anon;
set request.jwt.claims = :'anon_c';
select lg.val('LR13 anon reads the acceptable use policy as reviewed -- and still version 1, same text',
  format($$select version || ':' || (counsel_reviewed_at is not null)::text || ':' ||
                  (md5(body) = %L)::text
             from public.legal_documents where slug = 'acceptable-use'$$, :'au_md5'), '1:true:true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § LO  THE OPERATOR READ
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select lg.val('LO1 the aal2 superuser reads every version: 37 migrated (32 before Task 9a) + the terms and cookies drafts',
  $$select count(*)::text from public.operator_legal_document_versions(null)$$, '39');
select lg.val('LO2 ...including the one open draft, which no table read can reach',
  $$select string_agg(slug || ':' || status, ',' order by slug)
      from public.operator_legal_document_versions(null) where status = 'draft'$$, 'cookies:draft');
select lg.val('LO3 ...and the reviewer of terms v2',
  $$select counsel_reviewer from public.operator_legal_document_versions('terms') where version = 2$$,
  'SENTINEL-REVIEWER-91c2 LLP');
select lg.val('LO4 one slug narrows it',
  $$select count(*)::text from public.operator_legal_document_versions('terms')$$, '2');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c1';
select lg.try('LO5 the aal1 superuser is refused',
  $$select * from public.operator_legal_document_versions(null)$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select lg.try('LO6 an aal2 Org Owner is refused',
  $$select * from public.operator_legal_document_versions(null)$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pro_c';
select lg.try('LO7 a Read Only member is refused',
  $$select * from public.operator_legal_document_versions('terms')$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select lg.try('LO8 a foreign Owner cannot read a reviewer name through the table (outside the grant)',
  $$select counsel_reviewer from public.legal_documents$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § LH  THE AUDIT TRAIL
-- ===========================================================================
select lg.val('LH1 the writes produced exactly these audit rows, all by `super`, all org-less',
  format($$select string_agg(action || '=' || n, ',' order by action) from (
             select action, count(*) as n from public.audit_events
              where target_type = 'legal_document' and actor_user_id = %L and organisation_id is null
              group by action) a$$, :'super'),
  -- draft_updated=7: five from the original sections plus LV9l and LV9m, the
  -- two accepted placement controls fix round 1 added.
  'legal_document.counsel_review_recorded=3,legal_document.draft_created=2,legal_document.draft_updated=7,legal_document.published=1');
select lg.val('LH2 every legal audit row is by `super` -- no refused call left a row',
  format($$select count(*)::text from public.audit_events
            where target_type = 'legal_document' and actor_user_id <> %L$$, :'super'), '0');
select lg.val('LH3 the total audit rows added by this suite equal those thirteen',
  format($$select ((select count(*) from public.audit_events) - %s)::text$$, :audit_before), '13');
select lg.val('LH4 NO audit row carries the document text',
  $$select count(*)::text from public.audit_events
     where target_type = 'legal_document'
       and (coalesce(after::text,'') || coalesce(before::text,'')) like '%SENTINEL-BODY%'$$, '0');
select lg.val('LH5 NO audit row carries the reviewer name',
  $$select count(*)::text from public.audit_events
     where target_type = 'legal_document'
       and (coalesce(after::text,'') || coalesce(before::text,'')) like '%SENTINEL-REVIEWER%'$$, '0');
select lg.val('LH6 NO audit row carries a title',
  $$select count(*)::text from public.audit_events
     where target_type = 'legal_document'
       and (coalesce(after::text,'') || coalesce(before::text,'')) like '%Terms of Service%'$$, '0');
select lg.val('LH7 DENOMINATOR for LH4-6: the sentinels ARE in the table the audit rows describe',
  $$select count(*)::text from public.legal_documents
     where body like '%SENTINEL-BODY%' or counsel_reviewer like '%SENTINEL-REVIEWER%'$$, '2');
select lg.val('LH8 the publish row names slug, version, the superseded version and the review flag -- nothing else',
  $$select string_agg(k, ',' order by k) || '|' || (after->>'slug') || ':' || (after->>'version') || ':' ||
           (after->>'superseded_version') || ':' || (after->>'counsel_reviewed')
      from public.audit_events, jsonb_object_keys(after) k
     where action = 'legal_document.published'
     group by after$$,
  'counsel_reviewed,slug,superseded_version,version|terms:2:1:true');
select lg.val('LH9 every legal audit row targets a real legal_documents row',
  $$select count(*)::text from public.audit_events a
     where a.target_type = 'legal_document'
       and not exists (select 1 from public.legal_documents d where d.id = a.target_id)$$, '0');

-- ===========================================================================
-- § LZ  HOUSEKEEPING -- the seed back exactly as it was
-- ===========================================================================
\o /dev/null
set session_replication_role = replica;
delete from public.audit_events where target_type = 'legal_document';
delete from public.legal_documents where id not in (select id from lg.seed_before);
update public.legal_documents d
   set status = s.status, superseded_at = s.superseded_at, published_at = s.published_at,
       published_by = s.published_by, counsel_reviewed_at = s.counsel_reviewed_at,
       counsel_reviewer = s.counsel_reviewer, counsel_review_recorded_by = s.counsel_review_recorded_by,
       updated_at = s.updated_at
  from lg.seed_before s
 where s.id = d.id;
set session_replication_role = default;
\o
select lg.val('LZ1 the table is byte-for-byte the seed again',
  $$select ((select count(*) from (select * from public.legal_documents except select * from lg.seed_before) a)
          + (select count(*) from (select * from lg.seed_before except select * from public.legal_documents) b))::text$$,
  '0');
select lg.val('LZ2 no legal audit row remains',
  $$select count(*)::text from public.audit_events where target_type = 'legal_document'$$, '0');
select lg.val('LZ3 the audit table is back to its size before this suite',
  format($$select ((select count(*) from public.audit_events) - %s)::text$$, :audit_before), '0');
select lg.val('LZ4 the guard is ENABLED again (replica mode was session-local and is reset)',
  $$select current_setting('session_replication_role')$$, 'origin');

-- ===========================================================================
-- REPORT
-- ===========================================================================
\echo
\echo '=== Phase 8 legal documents suite ==='
select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
from lg.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed
from lg.results;

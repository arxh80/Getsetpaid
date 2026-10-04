-- ===========================================================================
-- Phase 8 Task 4 (data exports) RLS suite.
--
-- Covers 20260927000000 .. 20260927006000:
--   public.export_jobs                     the register
--   export_jobs_select_own / _insert_own   the two policies
--   private.export_jobs_before_insert()    attribution, the permission, the
--                                          two meters, the outcome nulling
--   private.export_jobs_before_update()    server-only progress, the
--                                          transition table, the stamps
--   private.export_catalogue()             what an export contains
--   public.export_read_page()              THE READ ENGINE -- the requester's
--                                          own RLS, and four elevated reads
--   public.claim_export_job() / _plan /
--     _limits_for_runner                   the runner's three entry points
--   public.audit_export_download()         the IDOR gate and the expiry gate
--   the `exports` bucket and its fence
--   THE DATA SUBJECT REGISTER'S EXPORT SEAM, now awake, and the
--   service_role grant that finally gives § DF a POSITIVE CONTROL.
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh, after the data subject
-- request suite, on the same P7VARS fixtures. § XZ removes every job,
-- counter, note, audit row and request it made.
--
-- THE DENOMINATOR RULE (progress.md, standing lesson 1). Every "X is not in
-- the export" is preceded by proof that something of the same shape IS --
-- most sharply in § XP, where the Owner's OWN private note is asserted
-- present before a colleague's is asserted absent, because an engine that
-- returned nothing at all would otherwise pass the security assertion
-- perfectly.
--
-- SECTIONS:
--   XF  fixtures
--   XG  the catalogue: RLS, policies, grants, triggers, bucket, functions
--   XC  the export catalogue and its soundness
--   XW  writing: attribution, the permission, the meters, one live job
--   XR  reading the register: own rows only
--   XJ  the job's progress: server-only, the transition table, the stamps
--   XP  THE READ ENGINE: the requester's RLS, private notes, tenant isolation
--   XD  the download audit RPC: not yours, no archive, expired
--   XS  the fulfilment seam, awake, with a POSITIVE CONTROL for service_role
--   XZ  housekeeping
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists xp cascade;
create schema xp;

create table xp.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function xp.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into xp.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function xp.try(p_label text, p_sql text, p_expected text)
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
  perform xp.record(p_label, p_expected, v_actual);
end $$;

-- THE HINT TOO. Every refusal in this task carries its own hint precisely so
-- that a refusal BY A GUARD and a refusal BY A MISSING PRIVILEGE -- both
-- 42501 -- can be told apart. Phase 7 shipped a false green of exactly that
-- shape, and Task 3's § DF9h was one.
create function xp.try_hint(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text; v_hint text;
begin
  begin
    execute p_sql;
    v_actual := 'ok';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_actual := 'denied(' || sqlstate || ':' || coalesce(v_hint, '') || ')';
  end;
  perform xp.record(p_label, p_expected, v_actual);
end $$;

create function xp.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform xp.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema xp to authenticated, anon, service_role;
grant execute on function xp.record(text,text,text)   to authenticated, anon, service_role;
grant execute on function xp.try(text,text,text)      to authenticated, anon, service_role;
grant execute on function xp.try_hint(text,text,text) to authenticated, anon, service_role;
grant execute on function xp.val(text,text,text)      to authenticated, anon, service_role;

\o /dev/null
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset
select count(*)::text as audit_before from public.audit_events \gset
select gen_random_uuid()::text as ghost \gset
\o
\set anon_c '{"role":"anon"}'
\set svc_c '{"role":"service_role"}'

-- ===========================================================================
-- § XF  FIXTURES
--
-- Two private notes in ALPHA, by two different people, planted as postgres:
-- the Owner's own and a Standard User's. § XP is the whole reason they exist.
-- ===========================================================================
insert into public.notes (id, organisation_id, owner_user_id, body, visibility) values
  ('aaaa0000-0000-4000-8000-000000000001', :'alpha_org', :'powner',
   'XPRIVATE-OWNER the owner''s own private note', 'private'),
  ('aaaa0000-0000-4000-8000-000000000002', :'alpha_org', :'pstd1',
   'XPRIVATE-COLLEAGUE a standard user''s private note', 'private'),
  ('aaaa0000-0000-4000-8000-000000000003', :'alpha_org', :'pstd1',
   'XCOMPANY a company-visible note', 'company'),
  -- A SOFT-DELETED note, so "deleted rows are included and flagged" has a
  -- subject. RLS does not filter deleted_at on any table in this schema --
  -- the app does -- which is why an export that runs under the requester's
  -- own RLS gets them for free.
  ('aaaa0000-0000-4000-8000-000000000004', :'alpha_org', :'powner',
   'XDELETED a note the owner deleted', 'company');
update public.notes set deleted_at = now()
 where id = 'aaaa0000-0000-4000-8000-000000000004';

-- One in BETA, so "another tenant's rows are absent" has a subject too.
insert into public.notes (id, organisation_id, owner_user_id, body, visibility) values
  ('bbbb0000-0000-4000-8000-000000000001', :'beta_org', :'pbowner',
   'XBETA a note in the other tenant', 'company');

-- Counted by the planted bodies, not by the table: the Phase 4 operations
-- suite leaves notes of its own in both tenants, and a count of the whole
-- table would make these fixtures depend on what ran before them.
select xp.val('XF1 FIXTURE: four planted notes in ALPHA, one of them soft-deleted',
  format($$select count(*) || '/' || count(*) filter (where deleted_at is not null)
             from public.notes where organisation_id = %L and body like 'X%%'$$, :'alpha_org'), '4/1');
select xp.val('XF2 FIXTURE: one planted note in BETA',
  format($$select count(*)::text from public.notes
            where organisation_id = %L and body like 'X%%'$$, :'beta_org'), '1');
select xp.val('XF3 FIXTURE: powner is an active OWNER of ALPHA',
  format($$select role from public.organisation_memberships
            where user_id = %L and organisation_id = %L and status = 'active'$$,
         :'powner', :'alpha_org'), 'owner');
select xp.val('XF4 FIXTURE: pmanager is an active MANAGER of ALPHA',
  format($$select role from public.organisation_memberships
            where user_id = %L and organisation_id = %L and status = 'active'$$,
         :'pmanager', :'alpha_org'), 'manager');
select xp.val('XF5 FIXTURE: the register starts empty',
  $$select count(*)::text from public.export_jobs$$, '0');

-- ===========================================================================
-- § XG  THE CATALOGUE
-- ===========================================================================
select xp.val('XG1 RLS is enabled on export_jobs',
  $$select relrowsecurity::text from pg_class where oid = 'public.export_jobs'::regclass$$, 'true');
select xp.val('XG2 exactly two policies -- one SELECT, one INSERT, both authenticated',
  $$select string_agg(polname::text || ':' || polcmd::text || ':' ||
            (select string_agg(r::regrole::text, ',') from unnest(polroles) r), ';' order by polname)
      from pg_policy where polrelid = 'public.export_jobs'::regclass$$,
  'export_jobs_insert_own:a:authenticated;export_jobs_select_own:r:authenticated');
-- TABLE-level and COLUMN-level are asked separately, because
-- information_schema.role_table_grants reports only the former -- so a grant
-- that is column-scoped (which the INSERT deliberately is) is INVISIBLE here.
-- Reading one and calling it the whole answer is the census hole Phase 8
-- Task 1's fix round found in the permission matrix.
select xp.val('XG3 authenticated''s TABLE-level grant is SELECT and nothing else',
  $$select string_agg(distinct privilege_type, ',' order by privilege_type)
      from information_schema.role_table_grants
     where table_schema='public' and table_name='export_jobs' and grantee='authenticated'$$,
  'SELECT');
select xp.val('XG4 the client INSERT grant is exactly two columns',
  $$select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
     where table_schema='public' and table_name='export_jobs'
       and grantee='authenticated' and privilege_type='INSERT'$$, 'kind,organisation_id');
select xp.val('XG5 NO client role holds UPDATE or DELETE, at table or column level',
  $$select count(*)::text from (
      select grantee from information_schema.role_table_grants
       where table_schema='public' and table_name='export_jobs'
         and grantee in ('anon','authenticated') and privilege_type in ('UPDATE','DELETE')
      union all
      select grantee from information_schema.column_privileges
       where table_schema='public' and table_name='export_jobs'
         and grantee in ('anon','authenticated') and privilege_type in ('UPDATE','DELETE')) g$$, '0');
select xp.val('XG6 anon holds nothing at all',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema='public' and table_name='export_jobs' and grantee='anon'$$, '0');
select xp.val('XG7 service_role''s UPDATE is the ten outcome columns, and no others',
  $$select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
     where table_schema='public' and table_name='export_jobs'
       and grantee='service_role' and privilege_type='UPDATE'$$,
  'byte_size,completed_at,expires_at,failure_reason,manifest,row_count,started_at,status,storage_key,table_count');
select xp.val('XG8 service_role holds no INSERT or DELETE on the register',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema='public' and table_name='export_jobs'
       and grantee='service_role' and privilege_type in ('INSERT','DELETE')$$, '0');
select xp.val('XG9 the three user triggers are present and enabled',
  $$select string_agg(tgname || ':' || tgenabled::text, ',' order by tgname) from pg_trigger
     where tgrelid = 'public.export_jobs'::regclass and not tgisinternal$$,
  'export_jobs_after_insert_audit:O,export_jobs_before_insert:O,export_jobs_before_update:O');
select xp.val('XG10 one live ACCOUNT job per requester, one live WORKSPACE job per workspace',
  $$select string_agg(indexname, ',' order by indexname) from pg_indexes
     where schemaname='public' and tablename='export_jobs' and indexdef like '%queued%'
       and indexdef like 'CREATE UNIQUE%'$$,
  'export_jobs_one_live_account_job,export_jobs_one_live_workspace_job');

select xp.val('XG11 the exports bucket exists and is PRIVATE',
  $$select public::text from storage.buckets where id='exports'$$, 'false');
select xp.val('XG12 its file size limit is above the job''s own archive ceiling',
  $$select (b.file_size_limit > l.max_archive_bytes)::text
      from storage.buckets b, private.export_limits() l where b.id='exports'$$, 'true');
select xp.val('XG13 four RESTRICTIVE deny-all client fences name the bucket',
  $$select count(*)::text from pg_policy p join pg_class c on c.oid=p.polrelid
      join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='storage' and c.relname='objects'
       and not p.polpermissive and p.polname like 'exports_deny_client_%'$$, '4');

select xp.val('XG14 the runner''s three entry points are executable by service_role ALONE',
  $$select string_agg(f || '=' || coalesce(r, '<none>'), ' ' order by f) from (
      select f, (select string_agg(x, ',' order by x) from unnest(array['anon','authenticated','service_role']) x
                  where has_function_privilege(x, f, 'EXECUTE')) r
        from unnest(array['public.claim_export_job()',
                          'public.export_plan(uuid)',
                          'public.export_limits_for_runner()',
                          'public.export_read_page(uuid,text,text,integer)']) f) y$$,
  'public.claim_export_job()=service_role public.export_limits_for_runner()=service_role public.export_plan(uuid)=service_role public.export_read_page(uuid,text,text,integer)=service_role');
select xp.val('XG15 the download audit RPC is executable by authenticated ALONE',
  $$select string_agg(r, ',' order by r) from (
      select r from unnest(array['anon','authenticated','service_role']) r
       where has_function_privilege(r, 'public.audit_export_download(uuid)', 'EXECUTE')) x$$,
  'authenticated');
select xp.val('XG16 no client role can reach the private catalogue or the limits',
  $$select count(*)::text from unnest(array['anon','authenticated','service_role']) r
     where has_function_privilege(r, 'private.export_catalogue()', 'EXECUTE')
        or has_function_privilege(r, 'private.export_limits()', 'EXECUTE')$$, '0');

select xp.val('XG17 the account_export budget is 5 per hour per USER',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='account_export'$$, '5/3600/user');
select xp.val('XG18 the exports budget is 5 per hour per ORGANISATION',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='exports'$$, '5/3600/organisation');
select xp.val('XG19 the exports policy no longer claims there is no endpoint',
  $$select (description not like '%no export endpoint exists%')::text
      from public.rate_limit_policies where category='exports'$$, 'true');

select xp.val('XG20 export_organisation_data is held by owner and admin ALONE',
  $$select string_agg(role_key, ',' order by role_key) from public.role_permissions
     where permission_key='export_organisation_data'$$, 'admin,owner');
select xp.val('XG21 ...and it SURVIVES SUSPENSION, deliberately',
  $$select survives_suspension::text from public.permissions where key='export_organisation_data'$$, 'true');
select xp.val('XG22 exactly three permission keys survive suspension',
  $$select string_agg(key, ',' order by key) from public.permissions where survives_suspension$$,
  'end_support_access,export_organisation_data,view_crm');

select xp.val('XG23 THE PRODUCT STILL HAS ONE CRON JOB, running one command',
  $$select count(*) || ':' || max(command) from cron.job$$,
  '1:select private.run_incident_alert_tick()');
select xp.val('XG24 the tick wakes the export runner BEFORE it delivers the digest',
  $$select (position('deliver_export_jobs' in prosrc) > 0
            and position('deliver_export_jobs' in prosrc)
                < position('deliver_incident_alerts' in prosrc))::text
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='run_incident_alert_tick'$$, 'true');
select xp.val('XG25 no client role can execute the export half of the tick',
  $$select count(*)::text from unnest(array['anon','authenticated','service_role']) r
     where has_function_privilege(r, 'private.deliver_export_jobs()', 'EXECUTE')$$, '0');

-- ===========================================================================
-- § XC  THE EXPORT CATALOGUE
-- ===========================================================================
select xp.val('XC1 the catalogue is sound against the live schema',
  $$select private.export_catalogue_is_sound()$$, 'sound');
select xp.val('XC2 EVERY table with a row -> organisation path is in the workspace catalogue',
  $$select coalesce(string_agg(tbl, ','), 'none') from (
      select distinct c.relname tbl from pg_constraint k
        join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
        join pg_class tc on tc.oid=k.confrelid join pg_namespace tn on tn.oid=tc.relnamespace
       where k.contype='f' and n.nspname='public' and tn.nspname='public' and tc.relname='organisations'
      union select 'organisations'
      except select table_name from private.export_catalogue() where export_kind='workspace') m$$,
  'none');
select xp.val('XC3 EVERY table with a row -> user path is in the account catalogue',
  $$select coalesce(string_agg(tbl, ','), 'none') from (
      select distinct c.relname tbl from pg_constraint k
        join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
        join pg_class tc on tc.oid=k.confrelid join pg_namespace tn on tn.oid=tc.relnamespace
       where k.contype='f' and n.nspname='public' and tn.nspname='auth' and tc.relname='users'
      except select table_name from private.export_catalogue() where export_kind='account') m$$,
  'none');
select xp.val('XC4 DENOMINATOR: the derivation finds the four tables whose organisation column is NOT called organisation_id',
  $$select count(*)::text from (
      select distinct c.relname tbl from pg_constraint k
        join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
        join pg_class tc on tc.oid=k.confrelid join pg_namespace tn on tn.oid=tc.relnamespace
       where k.contype='f' and n.nspname='public' and tn.nspname='public' and tc.relname='organisations'
         and c.relname in ('data_subject_requests','impersonation_sessions','network_connection_requests')) m$$,
  '3');
select xp.val('XC5 the WHOLE workspace export runs under the requester''s own RLS',
  $$select count(*)::text from private.export_catalogue()
     where export_kind='workspace' and authorisation is distinct from 'requester_rls'
       and disposition='exported'$$, '0');
select xp.val('XC6 exactly four account tables are read with elevated rights',
  $$select string_agg(table_name, ',' order by table_name) from private.export_catalogue()
     where authorisation='elevated'$$,
  'audit_events,feedback,impersonation_sessions,platform_admins');
select xp.val('XC7 the audit projection withholds the before/after payload',
  $$select (not ('before' = any(projection)) and not ('after' = any(projection))
            and 'action' = any(projection))::text
      from private.export_catalogue() where export_kind='account' and table_name='audit_events'$$, 'true');
select xp.val('XC8 the feedback projection withholds the screenshot key',
  $$select (not ('screenshot_key' = any(projection)))::text
      from private.export_catalogue() where export_kind='account' and table_name='feedback'$$, 'true');
-- XC10-XC13  THE RULES THE FIX ROUND MADE MACHINERY (review findings M2, M9).
--
-- XC7/XC8 pin the two projections whose WITHHOLDINGS are named. Neither of
-- them, nor private.export_catalogue_is_sound() as it shipped, said anything
-- about an elevated row that carries NO projection -- and `select *` is what a
-- null projection means. impersonation_sessions shipped that way, so an
-- account archive carried the operator's break-glass `reason` and a GetSetPaid
-- staff user id. 20260928001000 projects it and makes "elevated implies a
-- projection" a rule of the soundness check rather than prose in three files.
select xp.val('XC10 EVERY elevated read is projected -- an unprojected one is select *',
  $$select count(*)::text from private.export_catalogue()
     where authorisation='elevated'
       and (projection is null or array_length(projection,1) is null)$$, '0');
-- XC11 FLIPPED by 20261009000000 (founder 2026-09-30, Q167 CHANGED): the
-- account export now INCLUDES the operator's break-glass reason and identity.
-- Written as the EXACT column list rather than "contains reason": a
-- projection that also picked up some third operator column would pass a
-- containment check, and "nothing else new" is half the ruling's contract.
select xp.val('XC11 the impersonation projection is EXACTLY the requester''s decision plus the operator''s reason and identity (Q167 CHANGED)',
  $$select array_to_string(projection, ',')
      from private.export_catalogue()
     where export_kind='account' and table_name='impersonation_sessions'$$,
  'id,target_organisation_id,superuser_user_id,reason,status,requested_at,admin_accepted_by,accepted_at,declined_by,declined_at,started_at,expires_at,ended_at');
-- XC14: ...and the ROWS it applies to did not widen with the columns. The
-- sessions the requester DECIDED, and no others -- a session in their own
-- workspace decided by a colleague carries a reason too, and is not theirs.
select xp.val('XC14 the impersonation rows are still scoped to the sessions the requester accepted or declined',
  $$select array_to_string(scope_columns, ',') || '|' || authorisation
      from private.export_catalogue()
     where export_kind='account' and table_name='impersonation_sessions'$$,
  'admin_accepted_by,declined_by|elevated');
select xp.val('XC12 DENOMINATOR: those two columns really are on the table, so XC11 names real columns',
  $$select count(*)::text from pg_attribute a
      join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='impersonation_sessions'
       and a.attname in ('reason','superuser_user_id')
       and a.attnum>0 and not a.attisdropped$$, '2');
-- M9: the plan carries the catalogue's key column, so the runner's cursor is
-- not a second home for the same fact.
select xp.val('XC13 public.export_plan names key_column in its own result type',
  $$select (pg_get_function_result(p.oid) like '%key_column text%')::text
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='export_plan'$$, 'true');

select xp.val('XC9 every excused table says why',
  $$select count(*)::text from private.export_catalogue()
     where disposition='excused' and (reason is null or length(btrim(reason)) < 60)$$, '0');

-- ===========================================================================
-- § XW  WRITING -- ATTRIBUTION, THE PERMISSION, THE METERS
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'powner_c';

select xp.try_hint('XW1 an Owner can start a WORKSPACE export of their own workspace',
  format($$insert into public.export_jobs (kind, organisation_id) values ('workspace', %L)$$, :'alpha_org'),
  'ok');
select xp.val('XW2 ...and the row is attributed to THEM, not to anything they sent',
  format($$select requested_by::text from public.export_jobs where organisation_id = %L$$, :'alpha_org'),
  :'powner');
select xp.val('XW3 ...at the assurance level their session actually had',
  format($$select requested_aal from public.export_jobs where organisation_id = %L$$, :'alpha_org'),
  'aal2');
select xp.val('XW4 ...queued, with every outcome column null',
  format($$select status || '/' || coalesce(storage_key,'-') || '/' || coalesce(completed_at::text,'-')
             || '/' || coalesce(failure_reason,'-')
             from public.export_jobs where organisation_id = %L$$, :'alpha_org'),
  'queued/-/-/-');

-- FORGERY. Every one of these is outside the INSERT grant, so it is 42501
-- before any trigger runs -- attribution non-forgeable BY CONSTRUCTION.
select xp.try('XW5 a requester cannot name themselves',
  format($$insert into public.export_jobs (kind, requested_by) values ('account', %L)$$, :'pstd1'),
  'denied(42501)');
select xp.try('XW6 a requester cannot claim an assurance level',
  $$insert into public.export_jobs (kind, requested_aal) values ('account', 'aal2')$$,
  'denied(42501)');
select xp.try('XW7 a requester cannot arrive already succeeded',
  $$insert into public.export_jobs (kind, status) values ('account', 'succeeded')$$,
  'denied(42501)');
select xp.try('XW8 a requester cannot name their own archive',
  $$insert into public.export_jobs (kind, storage_key) values ('account', 'exports/whatever.zip')$$,
  'denied(42501)');

select xp.try_hint('XW9 ONE LIVE WORKSPACE JOB: a second, from the same Owner, is refused',
  format($$insert into public.export_jobs (kind, organisation_id) values ('workspace', %L)$$, :'alpha_org'),
  'denied(23505:)');

set request.jwt.claims = :'padmin_c';
select xp.try_hint('XW10 ...and from a DIFFERENT Admin of the same workspace too -- the index is per workspace',
  format($$insert into public.export_jobs (kind, organisation_id) values ('workspace', %L)$$, :'alpha_org'),
  'denied(23505:)');

set request.jwt.claims = :'pmanager_c';
-- THE TRIGGER ANSWERS FIRST, and the hint says so. A BEFORE INSERT trigger
-- runs before the row policy's WITH CHECK, so the refusal a Manager actually
-- meets is private.export_jobs_before_insert()'s -- which is also the one
-- that would still be there if the policy were ever relaxed. Both exist on
-- purpose; this measures which is load-bearing.
select xp.try_hint('XW11 a MANAGER cannot start a workspace export -- the TRIGGER refuses, by name',
  format($$insert into public.export_jobs (kind, organisation_id) values ('workspace', %L)$$, :'alpha_org'),
  'denied(42501:export_not_permitted)');

set request.jwt.claims = :'pbowner_c';
select xp.try_hint('XW12 the OTHER TENANT''s Owner cannot export ALPHA',
  format($$insert into public.export_jobs (kind, organisation_id) values ('workspace', %L)$$, :'alpha_org'),
  'denied(42501:export_not_permitted)');
select xp.try_hint('XW13 ...but can export their own workspace (positive control)',
  format($$insert into public.export_jobs (kind, organisation_id) values ('workspace', %L)$$, :'beta_org'),
  'ok');

set request.jwt.claims = :'pstd1_c';
select xp.try_hint('XW14 a Standard User with no workspace key can still export their own ACCOUNT',
  $$insert into public.export_jobs (kind) values ('account')$$, 'ok');
select xp.try_hint('XW15 ...and a second live account job is refused',
  $$insert into public.export_jobs (kind) values ('account')$$, 'denied(23505:)');
select xp.try_hint('XW16 an account export that names a workspace has the workspace nulled, not honoured',
  format($$insert into public.export_jobs (kind, organisation_id) values ('account', %L)$$, :'alpha_org'),
  'denied(23505:)');
select xp.val('XW17 ...and pstd1 still has exactly ONE job, with no workspace on it',
  format($$select count(*) || '/' || coalesce(max(organisation_id::text),'-')
             from public.export_jobs where requested_by = %L$$, :'pstd1'), '1/-');

select xp.try_hint('XW18 an unknown kind is refused by name',
  $$insert into public.export_jobs (kind) values ('everything')$$,
  'denied(22023:unknown_export_kind)');

reset role;
reset request.jwt.claims;
select xp.try_hint('XW19 a SESSIONLESS insert is refused -- a job nobody owns is everybody''s 404',
  $$insert into public.export_jobs (kind) values ('account')$$,
  'denied(42501:export_needs_a_session)');

-- ===========================================================================
-- § XR  READING THE REGISTER
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'powner_c';
select xp.val('XR1 the Owner reads their own workspace job (positive control)',
  format($$select count(*)::text from public.export_jobs where organisation_id = %L$$, :'alpha_org'), '1');

set request.jwt.claims = :'padmin_c';
select xp.val('XR2 a second ADMIN of the same workspace reads ZERO of it -- an archive is one person''s snapshot',
  format($$select count(*)::text from public.export_jobs where organisation_id = %L$$, :'alpha_org'), '0');

set request.jwt.claims = :'pstd1_c';
select xp.val('XR3 a Standard User reads their own account job and nothing else',
  $$select count(*)::text from public.export_jobs$$, '1');

set request.jwt.claims = :'super_c';
select xp.val('XR4 even the aal2 platform superuser reads nobody''s export jobs -- there is no oversight policy',
  $$select count(*)::text from public.export_jobs$$, '0');

set role anon;
set request.jwt.claims = :'anon_c';
-- Not "reads zero rows": anon holds no SELECT PRIVILEGE on the table at all,
-- so the refusal is earlier and harder than a policy's.
select xp.val('XR5 anon cannot read the register at all -- no grant, not an empty result',
  $$select count(*)::text from public.export_jobs$$, 'denied(42501)');

reset role;
reset request.jwt.claims;
select xp.val('XR6 DENOMINATOR: there really are three jobs to have been refused',
  $$select count(*)::text from public.export_jobs$$, '3');

-- ===========================================================================
-- § XJ  THE JOB'S PROGRESS
-- ===========================================================================
\o /dev/null
select id::text as alpha_job from public.export_jobs where organisation_id = :'alpha_org' \gset
select id::text as std_job   from public.export_jobs where requested_by = :'pstd1' \gset
select id::text as beta_job  from public.export_jobs where organisation_id = :'beta_org' \gset
\o

set role authenticated;
set request.jwt.claims = :'powner_c';
-- BY CONSTRUCTION, not by the guard: `authenticated` holds no UPDATE
-- privilege on any column of this table, so the statement never reaches
-- private.export_jobs_before_update(). The guard is for the other caller --
-- service_role, which DOES hold one, and which XJ1b below exercises directly.
select xp.try('XJ1 the requester holds no UPDATE privilege at all -- a job''s progress is not theirs',
  format($$update public.export_jobs set status='running' where id=%L$$, :'alpha_job'),
  'denied(42501)');

-- THE GUARD ITSELF, asked by the one caller that HOLDS THE GRANT.
--
-- XJ1 is a refusal by a MISSING PRIVILEGE, which is a real control and is not
-- this one: removing private.export_jobs_before_update()'s server-only leg
-- entirely leaves XJ1 green, measured (mutation `update_session`: 0 of 121
-- red before this assertion existed -- a guard nothing exercised). The leg
-- exists for the caller that does hold a column-level UPDATE: the runner,
-- as service_role. If that session ever carried a person's claims -- a
-- compromised runner, or a future code path that forwarded them -- it would
-- be writing a job's outcome on behalf of somebody, and this is what refuses
-- it, by its own hint.
reset role;
set role service_role;
set request.jwt.claims = :'powner_c';
select xp.try_hint('XJ1b THE GUARD: service_role -- which HOLDS the grant -- is refused while a person''s claims are on the session',
  format($$update public.export_jobs set status='running' where id=%L$$, :'alpha_job'),
  'denied(42501:export_outcome_is_server_only)');
reset request.jwt.claims;
select xp.try_hint('XJ1c DENOMINATOR: the same statement from the same role, claims cleared, IS admitted',
  format($$update public.export_jobs set status='running' where id=%L$$, :'alpha_job'), 'ok');
select xp.try_hint('XJ1d ...and running -> running is then refused as a non-transition, so XJ1c really wrote',
  format($$update public.export_jobs set status='running' where id=%L$$, :'alpha_job'),
  'denied(22023:illegal_export_transition)');
-- XJ1e/XJ1f  THE INVERSION ITSELF (20260928000000; review finding M1).
--
-- Until that migration this guard held a CLOSED LIST of client roles
-- (`v_session_role in ('authenticated','anon')`), so a role the schema has
-- never heard of was admitted BY OMISSION -- the exact shape the brief for
-- this task sent it to remove from the data subject register's seam, shipped
-- one migration earlier in the same series. XJ1b cannot see the difference:
-- it carries a person's claims, and BOTH shapes refuse that.
--
-- So ask it with a role that is neither: a real role, created here, holding
-- the SAME column-level UPDATE grant service_role holds (or the answer would
-- be a missing privilege again -- XJ1 is that assertion and it is not this
-- one), with NO claims on the session. Under the closed list this statement
-- was ADMITTED. It is now refused, by this guard's own hint.
reset role;
reset request.jwt.claims;
\o /dev/null
do $xjf$ begin
  if not exists (select 1 from pg_roles where rolname = 'xp_future_client') then
    create role xp_future_client;
  end if;
end $xjf$;
-- `postgres` is NOT a superuser on Supabase, so it cannot `set role` into a
-- role it is not a member of -- measured, the first run of this block failed
-- with 42501 "permission denied to set role". It created the role, so it
-- holds ADMIN OPTION and can grant it to itself.
grant xp_future_client to postgres;
grant usage on schema public to xp_future_client;
-- ...and on the probe harness's own schema, or xp.try_hint() itself is 42501
-- before the statement it is meant to run ever gets there (measured).
grant usage on schema xp to xp_future_client;
grant select on public.export_jobs to xp_future_client;
grant update (status, started_at, completed_at, expires_at, storage_key,
              byte_size, row_count, table_count, manifest, failure_reason)
  on public.export_jobs to xp_future_client;
-- AND A POLICY, or this probe would measure the wrong thing twice over. RLS is
-- on and `postgres` bypasses it as the table's owner; this role does not, and
-- every shipped policy is `to authenticated`. Without a policy the UPDATE
-- matches NO ROWS, the BEFORE UPDATE trigger never fires, and the statement
-- answers `ok` -- a green assertion measuring nothing. Measured: the first run
-- of this block answered denied(42501:) with no hint, which was the missing
-- SELECT privilege the WHERE clause needs, not the guard.
--
-- So the probe hands itself EVERYTHING except the guard's own verdict, which
-- is the only way its refusal can mean what it says.
--
-- FOR ALL, not FOR UPDATE: an `update ... where id = ...` references a column,
-- so Postgres applies the SELECT policies too, and with an UPDATE-only policy
-- the statement matched NO ROWS and answered `ok`. Measured -- this assertion
-- went green-by-vacuity on its second run, which is the same false-green shape
-- the whole of section XJ exists to close. XJ1e2 below is the denominator that
-- would now catch it.
create policy xp_future_client_probe on public.export_jobs
  for all to xp_future_client using (true) with check (true);
\o

set role xp_future_client;
select xp.val('XJ1e2 DENOMINATOR: that role really can SEE the job, so an `ok` from XJ1e would mean the write LANDED',
  format($$select count(*)::text from public.export_jobs where id=%L$$, :'alpha_job'), '1');
select xp.try_hint('XJ1e A ROLE NEITHER LIST NAMES, holding the runner''s own grant and carrying no claims, is REFUSED',
  format($$update public.export_jobs set status='succeeded' where id=%L$$, :'alpha_job'),
  'denied(42501:export_outcome_is_server_only)');
reset role;
select xp.val('XJ1f DENOMINATOR: that role really does hold the grant, so XJ1e is not a missing privilege',
  $$select (count(*) = 10)::text from information_schema.column_privileges
     where grantee='xp_future_client' and table_schema='public'
       and table_name='export_jobs' and privilege_type='UPDATE'$$, 'true');
\o /dev/null
drop policy xp_future_client_probe on public.export_jobs;
revoke all on public.export_jobs from xp_future_client;
revoke usage on schema public from xp_future_client;
revoke usage on schema xp from xp_future_client;
revoke xp_future_client from postgres;
drop role if exists xp_future_client;
\o
select xp.val('XJ1g ...and the probe role and its policy are gone',
  $$select (select count(*) from pg_roles where rolname='xp_future_client')::text
           || '|' ||
           (select count(*) from pg_policies
             where schemaname='public' and tablename='export_jobs'
               and policyname='xp_future_client_probe')::text$$, '0|0');

reset role;
reset request.jwt.claims;
select xp.try_hint('XJ2 as POSTGRES, a job already running cannot be claimed again',
  format($$update public.export_jobs set status='running' where id=%L$$, :'alpha_job'),
  'denied(22023:illegal_export_transition)');
select xp.val('XJ3 ...and started_at is the DATABASE''s clock, not a caller''s',
  format($$select (started_at is not null and started_at <= now()
                   and started_at > now() - interval '1 minute')::text
             from public.export_jobs where id=%L$$, :'alpha_job'), 'true');
select xp.try_hint('XJ4 queued -> succeeded skips a state and is refused',
  format($$update public.export_jobs set status='succeeded' where id=%L$$, :'std_job'),
  'denied(22023:illegal_export_transition)');
select xp.try_hint('XJ5 the request itself is immutable, even as postgres',
  format($$update public.export_jobs set requested_by=%L where id=%L$$, :'pstd1', :'alpha_job'),
  'denied(42501:export_request_is_immutable)');
select xp.try_hint('XJ6 ...the assurance level included -- the replay cannot be promoted after the fact',
  format($$update public.export_jobs set requested_aal='aal2' where id=%L$$, :'std_job'),
  'denied(42501:export_request_is_immutable)');

select xp.try('XJ7 a FAILURE must say why -- the shape CHECK refuses one that does not',
  format($$update public.export_jobs set status='failed' where id=%L$$, :'beta_job'),
  'denied(23514)');
select xp.try_hint('XJ8 ...with a reason it is admitted (a job can fail before it ever runs)',
  format($$update public.export_jobs set status='failed', failure_reason='a planted failure' where id=%L$$,
         :'beta_job'), 'ok');
select xp.try_hint('XJ9 A FINISHED JOB IS IMMUTABLE -- a failure cannot become a success',
  format($$update public.export_jobs set status='succeeded' where id=%L$$, :'beta_job'),
  'denied(22023:export_job_is_finished)');
select xp.val('XJ10 ...and completed_at is stamped while expires_at is not',
  format($$select (completed_at is not null and expires_at is null)::text
             from public.export_jobs where id=%L$$, :'beta_job'), 'true');

-- XJ11/XJ12  THE PLAN'S KEY COLUMN, read the way the runner reads it
-- (20260928003000, review finding M9). lib/export/runner.ts's cursor used to
-- be `row.id ?? row.user_id` -- the two key columns the catalogue happens to
-- use today, hard-coded beside the declaration. A third one added later would
-- page once and then raise. The plan carries it now.
reset role;
reset request.jwt.claims;
select xp.val('XJ11 every EXPORTED row of the plan carries its key column',
  format($$select count(*)::text from public.export_plan(%L)
            where disposition='exported' and key_column is null$$, :'alpha_job'), '0');
select xp.val('XJ12 ...and it is the catalogue''s, not a guess -- platform_admins keys on user_id',
  $$select key_column from private.export_catalogue()
     where export_kind='account' and table_name='platform_admins'$$, 'user_id');

-- ===========================================================================
-- § XP  THE READ ENGINE
--
-- THE POSITIVE CONTROL COMES FIRST, always: an engine that returned nothing
-- would satisfy every "X is absent" assertion below perfectly.
-- ===========================================================================
-- TWO SEPARATE REFUSALS, and telling them apart is the point. `authenticated`
-- holds no EXECUTE at all (XG14), so a browser is stopped by a MISSING
-- PRIVILEGE. The guard is for the other caller: a runner -- or anything
-- holding the service key -- that put a person's claims on its session and
-- then asked to read. Both are 42501; only one carries the hint.
set role authenticated;
set request.jwt.claims = :'powner_c';
select xp.try_hint('XP1a a browser session cannot call the read engine at all -- no EXECUTE, no hint',
  format($$select public.export_read_page(%L, 'notes', '', 100)$$, :'alpha_job'),
  'denied(42501:)');
reset role;
set role service_role;
select xp.try_hint('XP1b THE GUARD: service_role WITH a person''s claims on the session is refused, by hint',
  format($$select public.export_read_page(%L, 'notes', '', 100)$$, :'alpha_job'),
  'denied(42501:export_reads_are_server_only)');
reset role;
reset request.jwt.claims;

select xp.val('XP2 POSITIVE CONTROL: the Owner''s workspace export reads their OWN private note',
  format($$select (public.export_read_page(%L, 'notes', '', 100)::text like '%%XPRIVATE-OWNER%%')::text$$,
         :'alpha_job'), 'true');
select xp.val('XP3 ...and the company-visible note of a colleague',
  format($$select (public.export_read_page(%L, 'notes', '', 100)::text like '%%XCOMPANY%%')::text$$,
         :'alpha_job'), 'true');
select xp.val('XP4 ...and the SOFT-DELETED one, carrying its deleted_at',
  format($$select (public.export_read_page(%L, 'notes', '', 100)::text like '%%XDELETED%%')::text$$,
         :'alpha_job'), 'true');
select xp.val('XP5 THE RULE Q54 CLOSED: a colleague''s PRIVATE note is NOT in the Owner''s export',
  format($$select (public.export_read_page(%L, 'notes', '', 100)::text like '%%XPRIVATE-COLLEAGUE%%')::text$$,
         :'alpha_job'), 'false');
select xp.val('XP6 the other tenant''s note is not in it either',
  format($$select (public.export_read_page(%L, 'notes', '', 100)::text like '%%XBETA%%')::text$$,
         :'alpha_job'), 'false');
-- THREE OF THE FOUR PLANTED ONES, counted by their bodies rather than by the
-- page's length: the Phase 4 operations suite leaves notes of its own in
-- ALPHA and the Owner can read those too, so a raw length would be an
-- assertion about what ran before this file.
select xp.val('XP7 three of the four planted notes, not two and not four',
  format($$select count(*)::text
             from jsonb_array_elements(public.export_read_page(%L, 'notes', '', 100)) e
            where e->>'body' like 'X%%'$$, :'alpha_job'), '3');

select xp.try_hint('XP8 a table the catalogue does not export for this kind is refused BY NAME',
  format($$select public.export_read_page(%L, 'audit_events', '', 10)$$, :'alpha_job'),
  'denied(22023:not_an_exported_table)');
select xp.try_hint('XP9 a table that is EXCUSED is refused the same way',
  format($$select public.export_read_page(%L, 'feedback', '', 10)$$, :'alpha_job'),
  'denied(22023:not_an_exported_table)');
select xp.try_hint('XP10 a job that has not been claimed cannot be read from',
  format($$select public.export_read_page(%L, 'notes', '', 10)$$, :'std_job'),
  'denied(22023:export_job_not_running)');
select xp.try_hint('XP11 a job that does not exist is refused by name',
  format($$select public.export_read_page(%L, 'notes', '', 10)$$, :'ghost'),
  'denied(22023:unknown_export_job)');
select xp.val('XP12 the page size is capped at the declared one however much is asked for',
  format($$select (public.export_read_page(%L, 'notes', '', 100000) is not null)::text$$,
         :'alpha_job'), 'true');

-- THE CLAIMS ARE PUT BACK. A read that left the requester's identity on the
-- transaction would make everything after it run as them.
select xp.val('XP13 the requester''s claims do not outlive the read',
  format($$with r as (select public.export_read_page(%L, 'notes', '', 10))
           select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '<none>')
             from r$$, :'alpha_job'), '<none>');

-- XP13a-XP13c  ALL THREE CLAIM GUCS, not just the one that was measured
-- (20260928002000, review finding M7).
--
-- The read installs the requester's claims and puts them back. It ALSO blanked
-- `request.jwt.claim.sub` and `request.jwt.claim.role`, the two GoTrue-legacy
-- per-claim settings -- and never restored them, while XP13 above measured
-- only `request.jwt.claims`. So the two that were not restored were exactly
-- the two nothing asked about: the invisible denominator, one more time.
--
-- THE COMMENT THAT USED TO BE HERE SAID THE OPPOSITE OF THE TRUTH, AND IT IS
-- CORRECTED RATHER THAN QUIETLY DELETED (Task 4 scoped re-review, RR1).
--
-- Half of it is right, and measured on this stack: `auth.uid()` is
--   coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
--            current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
-- -- the PER-CLAIM GUC IS READ FIRST.
--
-- The inference drawn from that was wrong. `public.export_read_page()`
-- computes `v_uid := (select auth.uid())` as its FIRST statement and REFUSES
-- when it is non-null (20260928002000:63, 42501
-- export_reads_are_server_only). So by the time control reaches
-- `set_config('request.jwt.claim.sub','',true)` at :120, that GUC is provably
-- '' or unset: any castable value was refused twenty lines earlier, and any
-- uncastable one raised 22P02 before the body ran. `nullif('','')` and
-- `nullif(NULL,'')` are both NULL, so THE BLANKING CANNOT CHANGE ANY OUTCOME.
-- It is belt and braces, not load-bearing, and XP13b below MEASURES THAT
-- UNREACHABILITY -- it was labelled as proving the opposite.
--
-- The same is true of `role` for a different reason: `auth.role()` does read
-- `request.jwt.claim.role` first (measured), but NOTHING IN THIS SCHEMA CALLS
-- `auth.role()` -- 0 functions in public/private, 0 policies referencing it --
-- so that blanking is inert too.
--
-- None of this changes the code, and the restore that shipped is right anyway:
-- a function that changes a session setting and does not put it back is a
-- defect whether or not anything currently reads it, and the cost is one
-- set_config. What was wrong was the reasoning written beside it. The
-- migration is immutable, so its header and its `comment on function` still
-- carry the old claim; this block, the XP13b label below and the RR1 entry in
-- task-4-rereview.md are the correction of record.
set request.jwt.claim.role = 'XP13-SENTINEL-ROLE';
select xp.val('XP13a request.jwt.claim.role is PUT BACK, not left blanked',
  format($$with r as (select public.export_read_page(%L, 'notes', '', 10))
           select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '<blanked>')
             from r$$, :'alpha_job'), 'XP13-SENTINEL-ROLE');
reset request.jwt.claim.role;

set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000013ab';
select xp.try_hint('XP13b the gate ABOVE the blanking refuses any sub a person could set, which is why blanking it is belt-and-braces rather than load-bearing (RR1)',
  format($$select public.export_read_page(%L, 'notes', '', 10)$$, :'alpha_job'),
  'denied(42501:export_reads_are_server_only)');
reset request.jwt.claim.sub;

-- Two set_config calls per per-claim GUC is the whole claim: one to blank it
-- before the read, one to put it back after. The shipped function had ONE for
-- each of these two and TWO for request.jwt.claims (a restore on the success
-- path and one in the exception handler); it now has three for each.
select xp.val('XP13c the function BLANKS AND RESTORES both per-claim settings, sub included',
  $$select (select count(*) from regexp_matches(prosrc,
              'set_config\(''request\.jwt\.claim\.sub''', 'g'))::text
         || '|' ||
           (select count(*) from regexp_matches(prosrc,
              'set_config\(''request\.jwt\.claim\.role''', 'g'))::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='export_read_page'$$, '3|3');

-- ===========================================================================
-- § XD  THE DOWNLOAD AUDIT RPC -- THE IDOR GATE AND THE EXPIRY GATE
-- ===========================================================================
-- Make ALPHA's job a real succeeded one, so there is something to download.
update public.export_jobs
   set status='succeeded', storage_key='exports/' || :'alpha_job' || '.zip',
       byte_size=1024, row_count=3, table_count=1,
       manifest='{"schemaVersion":1}'::jsonb
 where id = :'alpha_job';

select xp.val('XD0 DENOMINATOR: the job really is downloadable now',
  format($$select (status='succeeded' and expires_at > now())::text
             from public.export_jobs where id=%L$$, :'alpha_job'), 'true');

set role authenticated;
set request.jwt.claims = :'powner_c';
select xp.try_hint('XD1 the requester''s own download is audited',
  format($$select public.audit_export_download(%L)$$, :'alpha_job'), 'ok');

set request.jwt.claims = :'padmin_c';
select xp.try_hint('XD2 IDOR: another Admin of the same workspace cannot audit-and-download it',
  format($$select public.audit_export_download(%L)$$, :'alpha_job'),
  'denied(42501:not_your_export)');

set request.jwt.claims = :'pstd1_c';
select xp.try_hint('XD3 IDOR: an unrelated user cannot either',
  format($$select public.audit_export_download(%L)$$, :'alpha_job'),
  'denied(42501:not_your_export)');
select xp.try_hint('XD4 ...and their own job has no archive yet, which is its own refusal',
  format($$select public.audit_export_download(%L)$$, :'std_job'),
  'denied(22023:export_has_no_archive)');

set request.jwt.claims = :'super_c';
select xp.try_hint('XD5 the aal2 platform superuser cannot download somebody''s export either',
  format($$select public.audit_export_download(%L)$$, :'alpha_job'),
  'denied(42501:not_your_export)');

reset role;
reset request.jwt.claims;
-- BACKDATING THE EXPIRY NEEDS THE UPDATE TRIGGER OUT OF THE WAY, and that is
-- itself the evidence for XJ9: a finished job is immutable for EVERY writer,
-- postgres included, so a fixture cannot age one. Disabling a trigger as the
-- table's owner is the deliberate DBA escape hatch; it is re-enabled
-- immediately and XD5a asserts it is back on before the expiry is measured.
alter table public.export_jobs disable trigger export_jobs_before_update;
update public.export_jobs set expires_at = now() - interval '1 day' where id = :'alpha_job';
alter table public.export_jobs enable trigger export_jobs_before_update;
select xp.val('XD5a the update trigger is ENABLED again',
  $$select tgenabled::text from pg_trigger
     where tgrelid='public.export_jobs'::regclass and tgname='export_jobs_before_update'$$, 'O');
set role authenticated;
set request.jwt.claims = :'powner_c';
select xp.try_hint('XD6 EXPIRY: past the read-time window, even the requester is refused',
  format($$select public.audit_export_download(%L)$$, :'alpha_job'),
  'denied(22023:export_archive_expired)');
reset role;
reset request.jwt.claims;

select xp.val('XD7 exactly one download was audited, and it names the job and the workspace',
  format($$select count(*) || '/' || max(target_id::text) || '/' || max(organisation_id::text)
             from public.audit_events where action='export_job.downloaded'$$),
  format('1/%s/%s', :'alpha_job', :'alpha_org'));
select xp.val('XD8 starting an export is audited too, once per job, with the KIND and no content',
  $$select count(*) || '/' || string_agg(distinct (after->>'kind'), ',' order by (after->>'kind'))
      || '/' || count(*) filter (where before is not null)
      from public.audit_events where action='export_job.requested'$$,
  '3/account,workspace/0');
select xp.val('XD9 nothing audits a job SUCCEEDING or FAILING -- there is no actor to attribute it to',
  $$select count(*)::text from public.audit_events
     where action in ('export_job.succeeded','export_job.failed','export_job.completed')$$, '0');

-- ===========================================================================
-- § XS  THE FULFILMENT SEAM, AWAKE
--
-- The whole point of this section: § DF of the data subject request suite
-- could not tell a working guard from a missing privilege, because
-- service_role held NO grant at all on public.data_subject_requests and the
-- suite had to open one inside its own transaction. It holds one now, so the
-- probe below is a POSITIVE CONTROL through the real catalogue.
-- ===========================================================================
-- The erasure half woke in Phase 8 Task 5 (20260930004000), which is why the
-- expectation below moved from `true/false` to `true/true` and XS15/XS16
-- changed with it. rls_phase8_erasure.sql § ES is where the second half is
-- proved, POSITIVE CONTROL included.
select xp.val('XS1 BOTH halves of the constraint are AWAKE (Task 4, Task 5)',
  $$select private.dsr_fulfilment_job_ready('export')::text || '/' ||
           private.dsr_fulfilment_job_ready('erasure')::text$$, 'true/true');
select xp.val('XS2 service_role''s UPDATE on the register is EXACTLY the two seam columns the job writes',
  $$select coalesce(string_agg(column_name, ',' order by column_name), '<none>')
      from information_schema.column_privileges
     where table_schema='public' and table_name='data_subject_requests'
       and grantee='service_role' and privilege_type='UPDATE'$$,
  'fulfilment_kind,fulfilment_reference');
select xp.val('XS3 ...and fulfilment_recorded_at is NOT among them -- the clock stays the database''s',
  $$select (not exists (select 1 from information_schema.column_privileges
     where table_schema='public' and table_name='data_subject_requests'
       and grantee='service_role' and privilege_type='UPDATE'
       and column_name='fulfilment_recorded_at'))::text$$, 'true');
select xp.val('XS4 service_role holds no INSERT or DELETE on the register',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema='public' and table_name='data_subject_requests'
       and grantee='service_role' and privilege_type in ('INSERT','DELETE')$$, '0');
select xp.val('XS5 the guard names the SERVER roles rather than the client ones -- a role added later arrives REFUSED',
  $$select (prosrc like '%''postgres''%' and prosrc like '%''service_role''%'
            and prosrc like '%not v_server_session%')::text
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='data_subject_requests_before_update'$$, 'true');

-- A real access request from pstd1, then the seam written the way the runner
-- writes it: as service_role, through the real grant, with no privilege
-- opened by this suite.
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select xp.try_hint('XS6 pstd1 files an ACCESS request about their account',
  $$select public.submit_data_subject_request('access','account','please send me my data')$$, 'ok');
reset role;
reset request.jwt.claims;

\o /dev/null
select id::text as dsr_id from public.data_subject_requests where user_id = :'pstd1' \gset
\o

select xp.val('XS7 DENOMINATOR: the request is open with no fulfilment recorded',
  format($$select status || '/' || coalesce(fulfilment_kind,'-') from public.data_subject_requests where id=%L$$,
         :'dsr_id'), 'open/-');

set role authenticated;
set request.jwt.claims = :'super_c';
select xp.try_hint('XS8 THE CONSTRAINT BITES: the operator cannot mark it answered before the export ran',
  format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'dsr_id'),
  'denied(22023:fulfilment_not_recorded)');
-- AND THERE IS NO WAY ROUND IT FROM A SESSION, because there is no write path
-- from one: `authenticated` holds no UPDATE privilege on the register at any
-- column, so the operator cannot write the seam by hand even to their own
-- advantage. (The GUARD itself -- for a caller that does hold a grant -- is
-- measured in rls_phase8_data_subject_requests.sql section DF9a-e, which
-- opens one inside a rolled-back transaction to ask it directly.)
select xp.try('XS9 ...and the operator holds no UPDATE privilege to write the seam with',
  format($$update public.data_subject_requests set fulfilment_kind='export', fulfilment_reference=%L where id=%L$$,
         :'std_job', :'dsr_id'),
  'denied(42501)');

-- POSITIVE CONTROL. service_role, through the real catalogue, with nothing
-- opened by this suite.
reset request.jwt.claims;
set role service_role;
select xp.try_hint('XS10 POSITIVE CONTROL: service_role reaches the seam through its real grant',
  format($$update public.data_subject_requests set fulfilment_kind='export', fulfilment_reference=%L where id=%L$$,
         :'std_job', :'dsr_id'), 'ok');
select xp.try('XS11 ...and cannot write anything else on the same row -- the grant is two columns wide',
  format($$update public.data_subject_requests set status='fulfilled' where id=%L$$, :'dsr_id'),
  'denied(42501)');
reset role;

select xp.val('XS12 the seam''s timestamp was stamped by the DATABASE, not sent',
  format($$select (fulfilment_recorded_at is not null and fulfilment_recorded_at <= now()
                   and fulfilment_recorded_at > now() - interval '1 minute')::text
             from public.data_subject_requests where id=%L$$, :'dsr_id'), 'true');

set role authenticated;
set request.jwt.claims = :'super_c';
select xp.try_hint('XS13 NOW the operator can mark it answered',
  format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'dsr_id'), 'ok');
reset role;
reset request.jwt.claims;
select xp.val('XS14 ...and the closing audit row carries the job the archive came from',
  format($$select (after->>'fulfilment_reference') from public.audit_events
            where action='data_subject_request.fulfilled' and target_id=%L$$, :'dsr_id'),
  :'std_job');

-- THE ERASURE HALF IS AWAKE TOO SINCE TASK 5, so the request pstd2 files
-- below can no longer be closed by hand -- which is the same sentence XS8
-- makes about an export, now true of the other job as well.
set role authenticated;
set request.jwt.claims = :'pstd2_c';
select xp.try_hint('XS15 pstd2 files an ERASURE request',
  $$select public.submit_data_subject_request('erasure','account','delete me')$$, 'ok');
set request.jwt.claims = :'super_c';
select xp.try_hint('XS16 ...and it can NO LONGER be closed by hand: the erasure must actually have run',
  format($$select * from public.transition_data_subject_request(
             (select id from public.data_subject_requests
               where user_id=%L and right_type='erasure'), 'fulfilled')$$, :'pstd2'),
  'denied(22023:fulfilment_not_recorded)');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § XZ  HOUSEKEEPING
-- ===========================================================================
-- `session_replication_role = replica` for the register, the data subject
-- suite's own rule and for the same reason: NOTHING may delete a register
-- row (20260925001000), so a suite that made one cannot clean up without
-- stepping round the guard it just proved. It is set for these statements
-- only and XZ6 asserts it is back. THE EXPORT REGISTER NEEDS NO SUCH THING:
-- public.export_jobs carries no delete guard, because a job is not evidence
-- that a statutory deadline was met -- it is a file with a clock on it.
\o /dev/null
set session_replication_role = replica;
delete from public.audit_events
 where action in ('export_job.requested','export_job.downloaded')
    or (action like 'data_subject_request.%'
        and target_id in (select id from public.data_subject_requests));
delete from public.data_subject_request_notes;
delete from public.data_subject_requests;
set session_replication_role = default;
delete from public.export_jobs;
delete from public.rate_limit_counters where category in ('exports','account_export','data_subject_request');
delete from public.notes where id::text like 'aaaa0000-%' or id::text like 'bbbb0000-%';
\o

select xp.val('XZ1 no export jobs left behind',
  $$select count(*)::text from public.export_jobs$$, '0');
select xp.val('XZ2 no data subject requests left behind',
  $$select count(*)::text from public.data_subject_requests$$, '0');
select xp.val('XZ3 no planted notes left behind',
  $$select count(*)::text from public.notes where body like 'X%'$$, '0');
select xp.val('XZ4 the audit log is back where this suite found it',
  $$select count(*)::text from public.audit_events$$, :'audit_before');
select xp.val('XZ5 no export counters left behind',
  $$select count(*)::text from public.rate_limit_counters
     where category in ('exports','account_export')$$, '0');
select xp.val('XZ6 the guards are ENABLED again (replica mode was reset)',
  $$select current_setting('session_replication_role')$$, 'origin');

-- ===========================================================================
-- REPORT
-- ===========================================================================
\echo ''
\echo '=== Phase 8 Task 4 (data exports) suite ==='
select seq, case when pass then 'PASS' else 'FAIL' end as result, label,
       case when pass then '' else 'expected ' || coalesce(expected,'<null>')
                                  || ', got ' || coalesce(actual,'<null>') end as detail
  from xp.results order by seq;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
  from xp.results;

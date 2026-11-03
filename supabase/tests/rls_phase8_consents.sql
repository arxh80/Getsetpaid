-- ===========================================================================
-- Phase 8 Task 2 (the consent ledger) RLS suite.
--
-- Covers 20260923000000_consents.sql and 20260923001000 (marketing v2):
--   public.consents                     the append-only ledger
--   consents_select_own / _platform     the two read policies
--   private.consents_before_insert()    attribution, catalogue, version,
--                                       alternation, the grant meter
--   private.consents_guard() / truncate append-only for EVERY role
--   private.audit_consent_event()       one identifier-only audit row per event
--   public.record_consent()             the one session write path
--   public.consent_is_granted()         the sender's check (service_role only)
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh (LAST of the psql suites, on
-- the P7VARS fixtures). § CZ removes every consent, counter, alert, audit row
-- and legal version this suite made, and proves the legal store is back to
-- the migrated rows byte for byte.
--
-- THE DENOMINATOR RULE (progress.md, standing lesson 1). Every "X cannot read
-- Y's consent" is preceded by proof that Y's consent EXISTS (the superuser's
-- oversight read and postgres both see it), and every refusal of a write is
-- paired with the same write succeeding for the right caller.
--
-- SECTIONS:
--   CF  fixtures
--   CG  the catalogue: RLS, policies, grants, triggers, function grants
--   CW  writing: the one path, attribution, the catalogue, the version rule
--   CR  reading: own rows only; superuser oversight at aal2; anon nothing
--   CH  history: grant -> withdraw -> grant, nothing rewritten, for postgres too
--   CV  versions: a new published version leaves the old grant pointing at
--       the old text; a stale or draft version is refused
--   CC  consent_is_granted(): the sender's check
--   CM  the grant meter: 10/hour, PT429, the crossing alert, withdrawals free
--   CA  the audit trail: one row per event, identifiers only, none on refusal
--   CD  deletion: the account's own deletion cascades past the guard; a
--       trigger's DELETE of a live account's rows does not
--   CZ  housekeeping
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists cs cascade;
create schema cs;

create table cs.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function cs.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into cs.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function cs.try(p_label text, p_sql text, p_expected text)
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
  perform cs.record(p_label, p_expected, v_actual);
end $$;

-- The hint too, for the refusals whose SQLSTATE is shared (22023).
create function cs.try_hint(p_label text, p_sql text, p_expected text)
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
  perform cs.record(p_label, p_expected, v_actual);
end $$;

-- The SQLSTATE and the MESSAGE, for a refusal whose SQLSTATE another guard
-- (or the statement itself) could also raise.
create function cs.try_msg(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql;
    v_actual := 'ok';
  exception when others then
    v_actual := 'denied(' || sqlstate || ':' || sqlerrm || ')';
  end;
  perform cs.record(p_label, p_expected, v_actual);
end $$;

-- The SHAPE of a PT429's hint: 'seconds' when it is a whole number of
-- seconds within one window, otherwise the raw value.
create function cs.retry_hint_shape(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_hint text;
begin
  begin
    execute p_sql;
    return 'ok';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    return sqlstate || ':' || case when v_hint ~ '^[0-9]+$' and v_hint::int between 0 and 3600
                                   then 'seconds' else coalesce(v_hint, '<null>') end;
  end;
end $$;

create function cs.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform cs.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema cs to authenticated, anon, service_role;
grant execute on function cs.record(text,text,text)   to authenticated, anon, service_role;
grant execute on function cs.try(text,text,text)      to authenticated, anon, service_role;
grant execute on function cs.try_hint(text,text,text) to authenticated, anon, service_role;
grant execute on function cs.try_msg(text,text,text)  to authenticated, anon, service_role;
grant execute on function cs.val(text,text,text)      to authenticated, anon, service_role;
grant execute on function cs.retry_hint_shape(text)   to authenticated, anon, service_role;

\o /dev/null
create table cs.legal_before as select * from public.legal_documents;
select count(*)::text as audit_before from public.audit_events \gset
select count(*)::text as alerts_before from public.incident_alerts \gset
select version::text as mp_ver from public.legal_documents
 where slug = 'marketing-preferences' and status = 'published' \gset
select id::text as mp_id from public.legal_documents
 where slug = 'marketing-preferences' and status = 'published' \gset
select (version - 1)::text as mp_old from public.legal_documents
 where slug = 'marketing-preferences' and status = 'published' \gset
select gen_random_uuid()::text as ghost \gset
\o
\set anon_c '{"role":"anon"}'
\set svc_c '{"role":"service_role"}'

-- ===========================================================================
-- § CF  FIXTURES
-- ===========================================================================
select cs.val('CF1 FIXTURE: `super` is on the platform_admins allowlist',
  format($$select count(*)::text from public.platform_admins where user_id=%L$$, :'super'), '1');
select cs.val('CF2 FIXTURE: the ledger starts empty',
  $$select count(*)::text from public.consents$$, '0');
select cs.val('CF3 FIXTURE: marketing-preferences is published at version 2 (20260923001000)',
  $$select version::text from public.legal_documents where slug='marketing-preferences' and status='published'$$, '2');
select cs.val('CF4 FIXTURE: ...and version 1 is superseded, not gone',
  $$select status from public.legal_documents where slug='marketing-preferences' and version=1$$, 'superseded');
select cs.val('CF5 FIXTURE: the version 2 page names the control and says no marketing is sent',
  $$select (body like '%(/account/privacy)%' and body like '%No marketing email is sent today%'
            and counsel_reviewed_at is null)::text
      from public.legal_documents where slug='marketing-preferences' and status='published'$$, 'true');
select cs.val('CF6 FIXTURE: pstd1, pstd2 and pbooker hold no consent counter yet',
  format($$select count(*)::text from public.rate_limit_counters
            where category='consent_grant' and subject_id in (%L,%L,%L)$$, :'pstd1', :'pstd2', :'pbooker'), '0');

-- ===========================================================================
-- § CG  THE CATALOGUE
-- ===========================================================================
select cs.val('CG1 RLS is enabled on consents',
  $$select relrowsecurity::text from pg_class where oid = 'public.consents'::regclass$$, 'true');
select cs.val('CG2 exactly two policies, both SELECT, both for authenticated',
  $$select string_agg(polname::text || ':' || polcmd::text || ':' ||
            (select string_agg(r::regrole::text, ',') from unnest(polroles) r), ';' order by polname)
      from pg_policy where polrelid = 'public.consents'::regclass$$,
  'consents_select_own:r:authenticated;consents_select_platform:r:authenticated');
select cs.val('CG3 authenticated holds SELECT and nothing else',
  $$select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants
     where table_schema='public' and table_name='consents' and grantee='authenticated'$$, 'SELECT');
select cs.val('CG4 no client role holds a write privilege, at table or column level',
  $$select count(*)::text from (
      select grantee from information_schema.role_table_grants
       where table_schema='public' and table_name='consents'
         and grantee in ('anon','authenticated','service_role') and privilege_type <> 'SELECT'
      union all
      select grantee from information_schema.column_privileges
       where table_schema='public' and table_name='consents'
         and grantee in ('anon','authenticated','service_role') and privilege_type <> 'SELECT') g$$, '0');
select cs.val('CG5 anon and service_role hold nothing on the table',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema='public' and table_name='consents' and grantee in ('anon','service_role')$$, '0');
select cs.val('CG6 the four user triggers are present and enabled',
  $$select string_agg(tgname || ':' || tgenabled::text, ',' order by tgname) from pg_trigger
     where tgrelid = 'public.consents'::regclass and not tgisinternal$$,
  'consents_audit_event:O,consents_before_insert:O,consents_guard:O,consents_truncate_guard:O');
select cs.val('CG7 record_consent is executable by authenticated only',
  $$select string_agg(r, ',' order by r) from (
      select r from unnest(array['anon','authenticated','service_role']) r
       where has_function_privilege(r, 'public.record_consent(text,text,integer,text)', 'EXECUTE')) x$$,
  'authenticated');
select cs.val('CG8 consent_is_granted is executable by service_role only',
  $$select string_agg(r, ',' order by r) from (
      select r from unnest(array['anon','authenticated','service_role']) r
       where has_function_privilege(r, 'public.consent_is_granted(uuid,text)', 'EXECUTE')) x$$,
  'service_role');
select cs.val('CG9 record_consent takes no user argument -- attribution cannot be passed in',
  $$select (pg_get_function_identity_arguments('public.record_consent(text,text,integer,text)'::regprocedure)
            !~ 'user')::text$$, 'true');
select cs.val('CG10 the consent_grant budget is 10 per hour per user',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='consent_grant'$$, '10/3600/user');
select cs.val('CG11 the catalogue has one purpose, and no necessary or analytics one',
  $$select string_agg(purpose || ':' || category || ':' || policy_slug, ',') from private.consent_purposes()$$,
  'marketing_email:marketing:marketing-preferences');
select cs.val('CG12 no column can hold an IP address or a user agent',
  $$select count(*)::text from information_schema.columns
     where table_schema='public' and table_name='consents'
       and (column_name ~* 'ip|agent|browser|device|location')$$, '0');

-- ===========================================================================
-- § CW  WRITING
-- ===========================================================================
set role anon;
set request.jwt.claims = :'anon_c';
select cs.try('CW1 anon cannot call record_consent',
  format($$select * from public.record_consent('marketing_email','granted',%s,'marketing-email-1')$$, :mp_ver),
  'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select cs.try('CW2 POSITIVE: pstd1 grants marketing consent against the current version',
  format($$select * from public.record_consent('marketing_email','granted',%s,'marketing-email-1')$$, :mp_ver),
  'ok(1)');
select cs.try('CW3 pstd1 cannot INSERT into the table directly (no grant)',
  $$insert into public.consents (purpose, action, policy_slug, policy_version, mechanism)
    values ('marketing_email','withdrawn','marketing-preferences',2,'account_settings')$$,
  'denied(42501)');
select cs.try('CW4 ...nor name another user while doing it',
  format($$insert into public.consents (user_id, purpose, action, policy_slug, policy_version, mechanism)
           values (%L,'marketing_email','granted','marketing-preferences',2,'account_settings')$$, :'pstd2'),
  'denied(42501)');
select cs.try_hint('CW5 a grant while already granted is refused',
  format($$select * from public.record_consent('marketing_email','granted',%s,null)$$, :mp_ver),
  'denied(22023:already_granted)');
select cs.try_hint('CW6 an unknown purpose is refused',
  $$select * from public.record_consent('newsletter','granted',2,null)$$,
  'denied(22023:unknown_purpose)');
select cs.try_hint('CW7 a strictly-necessary "purpose" cannot be recorded (never asked)',
  $$select * from public.record_consent('strictly_necessary','granted',2,null)$$,
  'denied(22023:unknown_purpose)');
select cs.try_hint('CW8 an analytics purpose cannot be recorded (no vendor, Q129)',
  $$select * from public.record_consent('analytics','granted',2,null)$$,
  'denied(22023:unknown_purpose)');
select cs.try_hint('CW9 an unknown action is refused',
  $$select * from public.record_consent('marketing_email','maybe',2,null)$$,
  'denied(22023:unknown_action)');
select cs.try('CW10 free text cannot be put in the technical context',
  $$select * from public.record_consent('marketing_email','withdrawn',null,'I am 192.168.0.1 on Firefox')$$,
  'denied(23514)');
reset role; reset request.jwt.claims;

select cs.val('CW11 the CW2 row is pstd1''s, marketing, against the current version, with the statement token',
  format($$select user_id || '|' || category || '|' || action || '|' || policy_slug || ':' || policy_version
              || '|' || mechanism || '|' || technical_context::text || '|' || (granted_at is not null)::text
              || '|' || (withdrawn_at is null)::text
            from public.consents where user_id = %L$$, :'pstd1'),
  :'pstd1' || '|marketing|granted|marketing-preferences:' || :'mp_ver'
    || '|account_settings|{"statement": "marketing-email-1"}|true|true');
select cs.val('CW12 pstd2 has no row (the forged CW4 did not land)',
  format($$select count(*)::text from public.consents where user_id=%L$$, :'pstd2'), '0');

-- A SESSIONLESS WRITER -- postgres with no claims -- cannot record anyone's
-- consent, even with every column filled in.
select cs.try('CW13 postgres with no session cannot record a consent',
  format($$insert into public.consents (user_id, category, purpose, action, policy_slug, policy_version,
                                        mechanism, granted_at)
           values (%L,'marketing','marketing_email','granted','marketing-preferences',%s,'account_settings',now())$$,
         :'pstd2', :mp_ver),
  'denied(42501)');

-- A WRITER WITH A SESSION BUT A FORGED ROW: postgres, carrying pstd1's
-- claims, fills in every column the trigger owns with a lie. Every lie is
-- overwritten: the row is pstd1's own withdrawal of their own grant.
set request.jwt.claims = :'pstd1_c';
select cs.try('CW14 a forged row (someone else''s id, necessary, a 2000 timestamp, a made-up version, a withdraws id) is REWRITTEN, not stored',
  format($$insert into public.consents (user_id, category, purpose, action, policy_slug, policy_version,
                                        mechanism, withdrawn_at, withdraws_id)
           values (%L,'necessary','marketing_email','withdrawn','cookies',1,'account_settings',
                   '2000-01-01','00000000-0000-0000-0000-000000000000')$$, :'pstd2'),
  'ok(1)');
reset request.jwt.claims;
select cs.val('CW15 ...it is pstd1''s, marketing, the marketing page at the in-force version, now, ending pstd1''s own grant',
  format($$select (w.user_id = %L)::text || '|' || w.category || '|' || w.policy_slug || ':' || w.policy_version
              || '|' || (w.withdrawn_at > now() - interval '1 hour')::text
              || '|' || (w.withdraws_id = g.id)::text
            from public.consents w join public.consents g on g.user_id = w.user_id and g.action = 'granted'
           where w.action = 'withdrawn' and w.user_id = %L$$, :'pstd1', :'pstd1'),
  'true|marketing|marketing-preferences:' || :'mp_ver' || '|true|true');
select cs.val('CW16 ...and pstd2 still has nothing',
  format($$select count(*)::text from public.consents where user_id=%L$$, :'pstd2'), '0');

set request.jwt.claims = :'pstd1_c';
select cs.try('CW17 an unknown mechanism is refused by CHECK (beside valid wording)',
  $$insert into public.consents (purpose, action, policy_version, mechanism, technical_context)
    values ('marketing_email','granted',2,'imported_from_crm','{"statement":"marketing-email-1"}')$$,
  'denied(23514)');
select cs.try('CW18 a technical context carrying an ip key is refused by CHECK (beside valid wording)',
  format($$insert into public.consents (purpose, action, policy_version, mechanism, technical_context)
           values ('marketing_email','granted',%s,'account_settings',
                   '{"statement":"marketing-email-1","ip":"192.0.2.1"}')$$, :mp_ver),
  'denied(23514)');
reset request.jwt.claims;

-- THE WORDING IS PINNED IN THE DATABASE (review finding M1, 20260923003000).
-- A fresh account, so a grant is otherwise valid here and each refusal below
-- is about the wording and nothing else.
select cs.val('CW19 the database lists exactly one wording id, for marketing email',
  $$select string_agg(purpose || ':' || statement_id, ',') from private.consent_statements()$$,
  'marketing_email:marketing-email-1');
select gen_random_uuid()::text as worder \gset
insert into auth.users (id, instance_id, aud, role, email)
values (:'worder', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'consent-worder-' || :'worder' || '@test.local');
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'worder') as worder_c \gset
set role authenticated;
set request.jwt.claims = :'worder_c';
select cs.try_hint('CW20 a grant with NO wording is refused',
  format($$select * from public.record_consent('marketing_email','granted',%s,null)$$, :mp_ver),
  'denied(22023:missing_statement)');
select cs.try_hint('CW21 a grant naming made-up wording is refused (it was stored before the fix)',
  format($$select * from public.record_consent('marketing_email','granted',%s,'totally-made-up-wording')$$, :mp_ver),
  'denied(22023:unknown_statement)');
select cs.try_hint('CW22 a grant naming well-formed wording that was never listed is refused',
  format($$select * from public.record_consent('marketing_email','granted',%s,'marketing-email-0')$$, :mp_ver),
  'denied(22023:unknown_statement)');
select cs.try('CW23 wording that is not even a token is still the CHECK''s to refuse',
  format($$select * from public.record_consent('marketing_email','granted',%s,'Marketing Email 1')$$, :mp_ver),
  'denied(23514)');
reset role;
-- postgres, carrying the account's claims: the trigger, not the RPC, refuses.
select cs.try_hint('CW24 a direct insert with no context is refused the same way',
  format($$insert into public.consents (purpose, action, policy_version, mechanism)
           values ('marketing_email','granted',%s,'account_settings')$$, :mp_ver),
  'denied(22023:missing_statement)');
select cs.try_hint('CW24a ...and a context whose statement is not a string counts as no wording',
  format($$insert into public.consents (purpose, action, policy_version, mechanism, technical_context)
           values ('marketing_email','granted',%s,'account_settings','{"statement":1}')$$, :mp_ver),
  'denied(22023:missing_statement)');
reset request.jwt.claims;
select cs.val('CW25 ...none of the refused grants landed, and none spent the budget',
  format($$select (select count(*) from public.consents where user_id = %L)::text || '/' ||
                  coalesce((select request_count from public.rate_limit_counters
                             where category='consent_grant' and subject_id = %L), 0)::text$$,
         :'worder', :'worder'),
  '0/0');
set role authenticated;
set request.jwt.claims = :'worder_c';
select cs.try('CW26 POSITIVE: the same grant with the listed wording is accepted',
  format($$select * from public.record_consent('marketing_email','granted',%s,'marketing-email-1')$$, :mp_ver),
  'ok(1)');
select cs.try_hint('CW27 a withdrawal naming made-up wording is refused',
  $$select * from public.record_consent('marketing_email','withdrawn',null,'totally-made-up-wording')$$,
  'denied(22023:unknown_statement)');
select cs.try('CW28 POSITIVE: a withdrawal with no wording is accepted (never harder than granting)',
  $$select * from public.record_consent('marketing_email','withdrawn',null,null)$$, 'ok(1)');
reset role; reset request.jwt.claims;
select cs.val('CW29 every grant in the ledger names listed wording',
  $$select count(*)::text || '/' ||
           count(*) filter (where not exists (
             select 1 from private.consent_statements() s
              where s.purpose = c.purpose and s.statement_id = c.technical_context->>'statement'))::text
      from public.consents c where c.action = 'granted'$$,
  '2/0');
\o /dev/null
delete from public.audit_events where actor_user_id = :'worder';
delete from auth.users where id = :'worder';
\o
select cs.val('CW30 the wording account and its events are gone again',
  format($$select count(*)::text from public.consents where user_id = %L$$, :'worder'), '0');

-- ===========================================================================
-- § CR  READING
-- ===========================================================================
select cs.val('CR0 DENOMINATOR: pstd1 has exactly two events (CW2, CW14)',
  format($$select count(*)::text from public.consents where user_id=%L$$, :'pstd1'), '2');

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select cs.val('CR1 pstd1 reads their own two events',
  $$select count(*)::text from public.consents$$, '2');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd2_c';
select cs.val('CR2 pstd2 (same workspace) reads none of pstd1''s',
  format($$select count(*)::text from public.consents where user_id=%L$$, :'pstd1'), '0');
select cs.val('CR3 ...and nothing at all',
  $$select count(*)::text from public.consents$$, '0');
select cs.try('CR4 pstd2 cannot UPDATE pstd1''s rows (no grant)',
  $$update public.consents set action = 'granted'$$, 'denied(42501)');
select cs.try('CR5 pstd2 cannot DELETE them (no grant)',
  $$delete from public.consents$$, 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'powner_c';
select cs.val('CR6 the workspace Owner at aal2 reads none of their member''s consents',
  $$select count(*)::text from public.consents$$, '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select cs.try('CR7 pstd1 cannot UPDATE even their own row',
  $$update public.consents set policy_version = 1$$, 'denied(42501)');
select cs.try('CR8 ...nor DELETE it',
  $$delete from public.consents$$, 'denied(42501)');
reset role; reset request.jwt.claims;

set role anon;
set request.jwt.claims = :'anon_c';
select cs.val('CR9 anon cannot read the table at all',
  $$select count(*)::text from public.consents$$, 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';
select cs.val('CR10 the aal2 superuser reads pstd1''s events (oversight)',
  format($$select count(*)::text from public.consents where user_id=%L$$, :'pstd1'), '2');
select cs.try('CR11 ...and cannot change them',
  $$update public.consents set mechanism = 'account_settings'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c1';
select cs.val('CR12 the superuser at aal1 reads nothing (the oversight policy is aal2-gated)',
  $$select count(*)::text from public.consents$$, '0');
reset role; reset request.jwt.claims;

set role service_role;
set request.jwt.claims = :'svc_c';
select cs.val('CR13 service_role cannot read the table (it has the check function, not the rows)',
  $$select count(*)::text from public.consents$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § CH  HISTORY IS NEVER REWRITTEN
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pstd2_c';
select cs.try_hint('CH1 pstd2 cannot withdraw what was never granted',
  $$select * from public.record_consent('marketing_email','withdrawn',null,null)$$,
  'denied(22023:not_granted)');
select cs.try('CH2 pstd2 grants', format($$select * from public.record_consent('marketing_email','granted',%s,'marketing-email-1')$$, :mp_ver), 'ok(1)');
reset role; reset request.jwt.claims;
create table cs.first_grant as select * from public.consents where user_id = :'pstd2';

set role authenticated;
set request.jwt.claims = :'pstd2_c';
select cs.try('CH3 pstd2 withdraws in one call, with no version', $$select * from public.record_consent('marketing_email','withdrawn',null,'marketing-email-1')$$, 'ok(1)');
select cs.try('CH4 pstd2 grants again', format($$select * from public.record_consent('marketing_email','granted',%s,'marketing-email-1')$$, :mp_ver), 'ok(1)');
select cs.val('CH5 pstd2 reads the whole story in order',
  $$select string_agg(action, ',' order by seq) from public.consents$$, 'granted,withdrawn,granted');
reset role; reset request.jwt.claims;

select cs.val('CH6 the first grant is byte for byte what it was before the withdrawal',
  format($$select count(*)::text from (
      select * from cs.first_grant
      except select * from public.consents where user_id = %L and action = 'granted') d$$, :'pstd2'), '0');
select cs.val('CH7 the withdrawal names the first grant and has only a withdrawn_at',
  format($$select ((w.withdraws_id = f.id) and w.granted_at is null and w.withdrawn_at is not null)::text
            from public.consents w, cs.first_grant f where w.user_id = %L and w.action = 'withdrawn'$$, :'pstd2'),
  'true');
select cs.val('CH8 each grant has only a granted_at and names nothing',
  format($$select count(*)::text from public.consents
            where user_id = %L and action = 'granted'
              and granted_at is not null and withdrawn_at is null and withdraws_id is null$$, :'pstd2'), '2');

select count(*)::text as ledger_n from public.consents \gset
select cs.try('CH9 postgres cannot UPDATE a consent (the guard, not a grant)',
  format($$update public.consents set policy_version = 1 where user_id = %L$$, :'pstd2'), 'denied(42501)');
select cs.try('CH10 postgres cannot DELETE a consent directly',
  format($$delete from public.consents where user_id = %L$$, :'pstd2'), 'denied(42501)');
select cs.try('CH11 postgres cannot DELETE one from inside a function either (trigger depth 1 is a statement)',
  format($q$do $d$ begin delete from public.consents where user_id = %L; end $d$$q$, :'pstd2'), 'denied(42501)');
select cs.try('CH12 postgres cannot TRUNCATE the ledger',
  $$truncate public.consents$$, 'denied(42501)');
select cs.val('CH13 ...and the ledger is unchanged', $$select count(*)::text from public.consents$$, :'ledger_n');

-- ONE WITHDRAWAL PER GRANT, STRUCTURALLY (review finding M2,
-- 20260923004000). The trigger's alternation rule holds only at READ
-- COMMITTED; the unique index holds at every isolation level. Asked here
-- with the triggers switched off (replica mode), so it is the INDEX that
-- answers and not the alternation rule; the parallel REPEATABLE READ race
-- itself is driven by run-rls-tests.sh.
select cs.val('CH14 withdraws_id is unique (the index exists and is UNIQUE)',
  $$select indisunique::text from pg_index where indexrelid = 'public.consents_withdraws_id_key'::regclass$$,
  'true');
select cs.val('CH15 DENOMINATOR: pstd2 has a withdrawal naming a grant',
  format($$select count(*)::text from public.consents where user_id = %L and withdraws_id is not null$$, :'pstd2'),
  '1');
set session_replication_role = replica;
select cs.try('CH16 a second withdrawal row naming the same grant is refused by the index',
  format($q$insert into public.consents (user_id, category, purpose, action, policy_slug, policy_version,
                                         mechanism, withdrawn_at, withdraws_id)
            select user_id, category, purpose, action, policy_slug, policy_version,
                   mechanism, now(), withdraws_id
              from public.consents where user_id = %L and withdraws_id is not null$q$, :'pstd2'),
  'denied(23505)');
set session_replication_role = default;
select cs.val('CH17 ...and the ledger is unchanged', $$select count(*)::text from public.consents$$, :'ledger_n');

-- ===========================================================================
-- § CV  VERSIONS
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select cs.try_hint('CV1 a grant against the superseded version 1 is refused',
  format($$select * from public.record_consent('marketing_email','granted',%s,null)$$, :mp_old),
  'denied(22023:stale_policy_version)');
select cs.try_hint('CV2 a grant against a version that does not exist is refused',
  $$select * from public.record_consent('marketing_email','granted',99,null)$$,
  'denied(22023:stale_policy_version)');
select cs.try_hint('CV3 a grant with no version is refused',
  $$select * from public.record_consent('marketing_email','granted',null,null)$$,
  'denied(22023:stale_policy_version)');
reset role; reset request.jwt.claims;

-- A DRAFT of version 3 exists; nobody can agree to it.
set role authenticated;
set request.jwt.claims = :'super_c';
select public.create_legal_document_draft('marketing-preferences') as mp_draft \gset
\o /dev/null
select public.update_legal_document_draft(:'mp_draft', 'Marketing and Communications Preferences',
  E'## Draft\n\nA material change nobody has been shown yet.', current_date);
\o
reset role; reset request.jwt.claims;
select cs.val('CV4 DENOMINATOR: version 3 exists as a draft',
  $$select status from public.legal_documents where slug='marketing-preferences' and version=3$$, 'draft');
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select cs.try_hint('CV5 a grant against the draft is refused',
  $$select * from public.record_consent('marketing_email','granted',3,null)$$,
  'denied(22023:stale_policy_version)');
select cs.val('CV6 pbooker has recorded nothing',
  $$select count(*)::text from public.consents$$, '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmarketing_c';
select cs.try('CV6b POSITIVE: pmarketing grants under version 2, while a version 3 draft sits unpublished',
  format($$select * from public.record_consent('marketing_email','granted',%s,'marketing-email-1')$$, :mp_ver), 'ok(1)');
reset role; reset request.jwt.claims;

-- PUBLISH version 3. pstd2's current grant stays pointing at version 2.
set role authenticated;
set request.jwt.claims = :'super_c';
\o /dev/null
select public.publish_legal_document(:'mp_draft');
\o
reset role; reset request.jwt.claims;
select cs.val('CV7 DENOMINATOR: version 3 is published and version 2 superseded',
  $$select string_agg(version || '=' || status, ',' order by version) from public.legal_documents
     where slug='marketing-preferences'$$, '1=superseded,2=superseded,3=published');
select cs.val('CV8 pstd2''s grants still reference version 2 -- the text they were shown',
  format($$select string_agg(distinct policy_version::text, ',') from public.consents
            where user_id=%L and action='granted'$$, :'pstd2'), '2');
select cs.val('CV9 ...and that version is still readable as the operator, unchanged',
  format($$select (d.id = %L and d.status = 'superseded')::text from public.consents c
            join public.legal_documents d on d.slug = c.policy_slug and d.version = c.policy_version
           where c.user_id = %L and c.action = 'granted' order by c.seq desc limit 1$$, :'mp_id', :'pstd2'),
  'true');
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select cs.try_hint('CV10 a grant against version 2 is now stale',
  $$select * from public.record_consent('marketing_email','granted',2,null)$$,
  'denied(22023:stale_policy_version)');
select cs.try('CV11 POSITIVE: a grant against version 3 is accepted',
  $$select * from public.record_consent('marketing_email','granted',3,'marketing-email-1')$$, 'ok(1)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pstd2_c';
select cs.try('CV12 a withdrawal never fails for a version: pstd2 withdraws the version-2 grant',
  $$select * from public.record_consent('marketing_email','withdrawn',2,null)$$, 'ok(1)');
reset role; reset request.jwt.claims;
select cs.val('CV13 ...and the withdrawal records version 3, the notice in force, not the 2 it was sent',
  format($$select policy_version::text from public.consents
            where user_id=%L order by seq desc limit 1$$, :'pstd2'), '3');
select cs.try('CV14 a published version a consent points at cannot be deleted (the legal guard refuses before the FK is asked)',
  format($$delete from public.legal_documents where id = %L$$, :'mp_id'), 'denied(42501)');

-- ===========================================================================
-- § CC  THE SENDER'S CHECK
-- ===========================================================================
set role service_role;
set request.jwt.claims = :'svc_c';
select cs.val('CC1 pbooker (granted under v3) -> true',
  format($$select public.consent_is_granted(%L, 'marketing_email')::text$$, :'pbooker'), 'true');
select cs.val('CC2 pstd2 (withdrawn) -> false',
  format($$select public.consent_is_granted(%L, 'marketing_email')::text$$, :'pstd2'), 'false');
select cs.val('CC3 pstd1 (granted then withdrawn by CW14) -> false',
  format($$select public.consent_is_granted(%L, 'marketing_email')::text$$, :'pstd1'), 'false');
select cs.val('CC4 a user with no record -> false',
  format($$select public.consent_is_granted(%L, 'marketing_email')::text$$, :'pmanager'), 'false');
select cs.val('CC5 a user that does not exist -> false',
  format($$select public.consent_is_granted(%L, 'marketing_email')::text$$, :'ghost'), 'false');
select cs.val('CC6 an unknown purpose raises rather than quietly saying no',
  format($$select public.consent_is_granted(%L, 'newsletter')::text$$, :'pbooker'), 'denied(22023)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbooker_c';
select cs.val('CC7 a user cannot call the check, not even about themselves',
  format($$select public.consent_is_granted(%L, 'marketing_email')::text$$, :'pbooker'), 'denied(42501)');
reset role; reset request.jwt.claims;
set role anon;
set request.jwt.claims = :'anon_c';
select cs.val('CC8 anon cannot call the check',
  format($$select public.consent_is_granted(%L, 'marketing_email')::text$$, :'pbooker'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- A GRANT SURVIVES A NEW VERSION (the queued default, DECISIONS-QUEUE Task 2):
-- pmarketing agreed under version 2 and has not been asked again since version
-- 3 was published. Re-consent on a material change is a deliberate act, not
-- something the check infers -- so this is TRUE, and the day the founder
-- rules otherwise this is the assertion that has to change.
set role service_role;
set request.jwt.claims = :'svc_c';
select cs.val('CC9 pmarketing (granted under v2, v3 now current) -> still true',
  format($$select public.consent_is_granted(%L, 'marketing_email')::text$$, :'pmarketing'), 'true');
reset role; reset request.jwt.claims;
select cs.val('CC10 DENOMINATOR for CC9: that grant really is against a superseded version',
  format($$select c.policy_version || ':' || d.status from public.consents c
            join public.legal_documents d on d.slug = c.policy_slug and d.version = c.policy_version
           where c.user_id = %L$$, :'pmarketing'), '2:superseded');

-- ===========================================================================
-- § CM  THE GRANT METER
-- ===========================================================================
-- pbooker has spent 1 grant (CV11). Fill the window to 9, as the meter's own
-- counter row, so the 10th grant is the crossing.
select count(*)::text as consent_alerts_before from public.incident_alerts
 where details->>'category' = 'consent_grant' \gset
update public.rate_limit_counters set request_count = 9
 where category = 'consent_grant' and subject_id = :'pbooker'
   and window_start = private.rate_limit_window_start(now(), 3600);
select cs.val('CM0 DENOMINATOR: pbooker''s counter for this window reads 9',
  format($$select request_count::text from public.rate_limit_counters
            where category='consent_grant' and subject_id=%L
              and window_start = private.rate_limit_window_start(now(), 3600)$$, :'pbooker'), '9');

set role authenticated;
set request.jwt.claims = :'pbooker_c';
select cs.try('CM1 pbooker withdraws (withdrawals are not metered)',
  $$select * from public.record_consent('marketing_email','withdrawn',null,null)$$, 'ok(1)');
select cs.try('CM2 the 10th grant in the hour is accepted',
  $$select * from public.record_consent('marketing_email','granted',3,'marketing-email-1')$$, 'ok(1)');
select cs.try('CM3 withdrawing after the budget is spent still works -- as easy as granting',
  $$select * from public.record_consent('marketing_email','withdrawn',null,null)$$, 'ok(1)');
select cs.try('CM4 the 11th grant is refused with PT429',
  $$select * from public.record_consent('marketing_email','granted',3,'marketing-email-1')$$, 'denied(PT429)');
select cs.val('CM5 ...with the seconds remaining in the hint (asked a second time: a refusal spends nothing)',
  $q$select cs.retry_hint_shape('select * from public.record_consent(''marketing_email'',''granted'',3,''marketing-email-1'')')$q$,
  'PT429:seconds');
reset role; reset request.jwt.claims;

select cs.val('CM6 the counter stopped at 10: the refusals and both withdrawals spent nothing',
  format($$select request_count::text from public.rate_limit_counters
            where category='consent_grant' and subject_id=%L
              and window_start = private.rate_limit_window_start(now(), 3600)$$, :'pbooker'), '10');
select cs.val('CM7 exactly one crossing alert, unattributed to any workspace, naming pbooker',
  format($$select count(*)::text || '|' || bool_and(organisation_id is null)::text || '|'
              || bool_and(details->>'subject_id' = %L)::text
            from public.incident_alerts where details->>'category' = 'consent_grant'$$, :'pbooker'),
  '1|true|true');
select cs.val('CM8 ...and it was new in this suite',
  format($$select (count(*) - %s)::text from public.incident_alerts where details->>'category' = 'consent_grant'$$,
         :consent_alerts_before), '1');
select cs.val('CM9 pbooker''s choice is WITHDRAWN -- the refused grant recorded nothing',
  format($$select action from public.consents where user_id=%L order by seq desc limit 1$$, :'pbooker'), 'withdrawn');
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select cs.try_hint('CM10 a redundant withdrawal is refused on its merits, not metered',
  $$select * from public.record_consent('marketing_email','withdrawn',null,null)$$,
  'denied(22023:not_granted)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § CA  THE AUDIT TRAIL
-- ===========================================================================
select cs.val('CA0 DENOMINATOR: the ledger holds events from four people',
  $$select string_agg(n::text, ',' order by n) from (select count(*) as n from public.consents group by user_id) x$$,
  '1,2,4,4');
select cs.val('CA1 every consent event has exactly one audit row',
  $$select count(*)::text from public.consents c
     where (select count(*) from public.audit_events a
             where a.target_type = 'consent' and a.target_id = c.id) <> 1$$, '0');
select cs.val('CA2 ...and there are no others: every refused attempt above wrote none',
  $$select ((select count(*) from public.audit_events where target_type = 'consent')
          - (select count(*) from public.consents))::text$$, '0');
select cs.val('CA3 the action matches the event',
  $$select count(*)::text from public.consents c join public.audit_events a
        on a.target_type = 'consent' and a.target_id = c.id
     where a.action <> 'consent.' || c.action$$, '0');
select cs.val('CA4 the actor is the person whose consent it is, and no workspace is named',
  $$select count(*)::text from public.consents c join public.audit_events a
        on a.target_type = 'consent' and a.target_id = c.id
     where a.actor_user_id <> c.user_id or a.organisation_id is not null or a.before is not null$$, '0');
select cs.val('CA5 the payload carries only identifiers and enums (no statement, no context, no free text)',
  $$select count(*)::text from public.audit_events a, jsonb_object_keys(a.after) k
     where a.target_type = 'consent'
       and k not in ('category','purpose','policy_slug','policy_version','mechanism','withdraws')$$, '0');
select cs.val('CA6 ...and a withdrawal names the grant it ended',
  $$select count(*)::text from public.consents c join public.audit_events a
        on a.target_type = 'consent' and a.target_id = c.id
     where c.action = 'withdrawn' and (a.after->>'withdraws')::uuid is distinct from c.withdraws_id$$, '0');

-- ===========================================================================
-- § CD  DELETION -- the account's own deletion is the one way rows go
-- ===========================================================================
select gen_random_uuid()::text as leaver \gset
insert into auth.users (id, instance_id, aud, role, email)
values (:'leaver', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'consent-leaver-' || :'leaver' || '@test.local');
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'leaver') as leaver_c \gset
set role authenticated;
set request.jwt.claims = :'leaver_c';
select cs.try('CD1 POSITIVE: a new account grants',
  $$select * from public.record_consent('marketing_email','granted',3,'marketing-email-1')$$, 'ok(1)');
select cs.try('CD2 ...and withdraws',
  $$select * from public.record_consent('marketing_email','withdrawn',null,null)$$, 'ok(1)');
reset role; reset request.jwt.claims;
select cs.val('CD3 DENOMINATOR: the account has two events',
  format($$select count(*)::text from public.consents where user_id=%L$$, :'leaver'), '2');
-- WHY THE AUDIT ROWS ARE DELETED FIRST (review finding M8): every consent
-- event writes an audit_events row whose actor_user_id references auth.users
-- with NO ON DELETE action, so deleting the account of anyone who has ever
-- consented is REFUSED (23503) before the consents cascade is even reached.
-- A real account deletion is therefore impossible today for exactly the
-- people this ledger is about; how erasure removes or anonymises those audit
-- rows is Task 5's decision (Q130), and what happens to the ledger is Q148.
-- This suite clears the leaver's audit rows by hand ONLY to reach the
-- guard's cascade branch -- it is not a model of erasure.
select cs.try('CD3a WITHOUT that step, the account cannot be deleted at all (the audit FK)',
  format($$delete from auth.users where id = %L$$, :'leaver'), 'denied(23503)');
delete from public.audit_events where actor_user_id = :'leaver';
select cs.try('CD4 deleting the auth account succeeds -- the guard lets the cascade through',
  format($$delete from auth.users where id = %L$$, :'leaver'), 'ok(1)');
select cs.val('CD5 ...and the account''s consent events went with it',
  format($$select count(*)::text from public.consents where user_id=%L$$, :'leaver'), '0');
select cs.val('CD6 nobody else''s did',
  $$select count(distinct user_id)::text from public.consents$$, '4');

-- A TRIGGER IS NOT AN ACCOUNT DELETION (review finding I2, 20260923002000).
-- Before the fix, any DELETE at trigger depth >= 2 passed the guard: a table
-- whose trigger ran `delete from public.consents` emptied the ledger with
-- every account still present. Now the guard also requires the row's account
-- to be gone. The eraser below deletes EVERY consent row; the live accounts'
-- rows must stop it.
create table cs.eraser (x int);
create function cs.erase() returns trigger language plpgsql set search_path = '' as $f$
begin
  delete from public.consents;
  return new;
end $f$;
create trigger cs_erase after insert on cs.eraser for each row execute function cs.erase();
select count(*)::text as ledger_before_eraser from public.consents \gset
select cs.val('CD7 DENOMINATOR: live accounts hold consent rows the eraser would reach',
  $$select (count(*) > 0 and bool_and(exists (select 1 from auth.users u where u.id = c.user_id)))::text
      from public.consents c$$, 'true');
select cs.try_msg('CD8 a trigger-issued DELETE of a live account''s rows is refused -- by the consents guard',
  $$insert into cs.eraser values (1)$$,
  'denied(42501:consents: the consent ledger is append-only -- rows go only with the account they belong to)');
select cs.val('CD9 ...and the ledger is unchanged',
  $$select count(*)::text from public.consents$$, :'ledger_before_eraser');

-- The other side of the same term: a trigger that deletes the AUTH ACCOUNT
-- is an account deletion, and its cascade still passes -- grant, withdrawal
-- and the self-referencing cascade between them, at trigger depth 3 and 4.
select gen_random_uuid()::text as leaver2 \gset
insert into auth.users (id, instance_id, aud, role, email)
values (:'leaver2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'consent-leaver2-' || :'leaver2' || '@test.local');
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'leaver2') as leaver2_c \gset
set role authenticated;
set request.jwt.claims = :'leaver2_c';
select cs.try('CD10 POSITIVE: a second new account grants',
  $$select * from public.record_consent('marketing_email','granted',3,'marketing-email-1')$$, 'ok(1)');
select cs.try('CD10a ...and withdraws',
  $$select * from public.record_consent('marketing_email','withdrawn',null,null)$$, 'ok(1)');
reset role; reset request.jwt.claims;
select cs.val('CD11 DENOMINATOR: it has a grant and a withdrawal naming it',
  format($$select count(*)::text || '/' || count(withdraws_id)::text from public.consents where user_id=%L$$, :'leaver2'),
  '2/1');
create table cs.account_eraser (id uuid);
create function cs.erase_account() returns trigger language plpgsql set search_path = '' as $f$
begin
  delete from auth.users where id = new.id;
  return new;
end $f$;
create trigger cs_erase_account after insert on cs.account_eraser for each row execute function cs.erase_account();
-- The same audit_events.actor_user_id block as CD4 (see there).
delete from public.audit_events where actor_user_id = :'leaver2';
select cs.try('CD12 a trigger that deletes the auth account succeeds -- its cascade passes the guard',
  format($$insert into cs.account_eraser values (%L)$$, :'leaver2'), 'ok(1)');
select cs.val('CD13 ...its two events went, nobody else''s did',
  format($$select (select count(*) from public.consents where user_id=%L)::text || '/' ||
                  ((select count(*) from public.consents) = %s)::text$$, :'leaver2', :'ledger_before_eraser'),
  '0/true');
drop table cs.eraser;
drop table cs.account_eraser;

-- ===========================================================================
-- § CZ  HOUSEKEEPING
-- ===========================================================================
\o /dev/null
set session_replication_role = replica;
delete from public.audit_events where target_type = 'consent';
delete from public.audit_events where target_type = 'legal_document' and target_id = :'mp_draft';
delete from public.consents;
delete from public.legal_documents where id not in (select id from cs.legal_before);
update public.legal_documents d
   set status = s.status, superseded_at = s.superseded_at, published_at = s.published_at,
       published_by = s.published_by, updated_at = s.updated_at
  from cs.legal_before s
 where s.id = d.id;
set session_replication_role = default;
delete from public.incident_alerts where details->>'category' = 'consent_grant';
delete from public.rate_limit_counters where category = 'consent_grant';
\o
select cs.val('CZ1 the legal store is byte-for-byte what it was',
  $$select ((select count(*) from (select * from public.legal_documents except select * from cs.legal_before) a)
          + (select count(*) from (select * from cs.legal_before except select * from public.legal_documents) b))::text$$,
  '0');
select cs.val('CZ2 the ledger is empty again',
  $$select count(*)::text from public.consents$$, '0');
select cs.val('CZ3 the audit table is back to its size before this suite',
  format($$select ((select count(*) from public.audit_events) - %s)::text$$, :audit_before), '0');
select cs.val('CZ4 the alert table is back to its size before this suite',
  format($$select ((select count(*) from public.incident_alerts) - %s)::text$$, :alerts_before), '0');
select cs.val('CZ5 the guards are ENABLED again (replica mode was reset)',
  $$select current_setting('session_replication_role')$$, 'origin');

-- ===========================================================================
-- REPORT
-- ===========================================================================
\echo
\echo '=== Phase 8 consent ledger suite ==='
select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
from cs.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed
from cs.results;

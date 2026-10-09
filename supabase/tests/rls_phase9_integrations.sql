-- ===========================================================================
-- PHASE 9 -- INTEGRATIONS (schema only, no live provider; founder 2026-10-09).
--
-- Task 1 (20261030000000_integration_tables.sql):
--   IT  the tables, the catalogue, the constraints, the guard, the grants
--   IR  who reads a connection and its sync runs
--   IB  breakout: no client role writes either table
--   IZ  housekeeping
--
-- Re-runnable on one database (Phase 8 lesson 11): every fixture is a fresh
-- uuid, and IZ removes them.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists ig cascade;
create schema ig;

create table ig.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function ig.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into ig.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- Runs p_sql and records its single text result, or `denied(<sqlstate>:<hint>)`
-- when it raises. A refusal is therefore ALWAYS a recorded row, never a psql
-- ERROR line (psql exits 0 on ERROR; run_suite counts both).
create function ig.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text; v_hint text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint like 'Grant the required privileges%' then v_hint := 'missing_grant'; end if;
    v_actual := 'denied(' || sqlstate || coalesce(':' || nullif(v_hint, ''), '') || ')';
  end;
  perform ig.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema ig to authenticated;
grant execute on function ig.record(text,text,text) to authenticated;
grant execute on function ig.val(text,text,text)    to authenticated;

-- IT12's probe: a SECURITY DEFINER function owned by postgres that inserts a
-- connection, the shape Task 2's RPCs take. It must land under the
-- attribution trigger (which exempts the owner role) and the guard.
create function ig.definer_insert(p_org uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_by uuid;
begin
  insert into public.integration_connections (organisation_id, provider, status)
  values (p_org, 'quickbooks', 'pending') returning id, created_by into v_id, v_by;
  delete from public.integration_connections where id = v_id;
  return 'landed:created_by=' || coalesce(v_by::text, 'null');
end $$;
grant execute on function ig.definer_insert(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- FIXTURES (as postgres)
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as owner_a \gset
select gen_random_uuid()::text as admin_a \gset
select gen_random_uuid()::text as mgr_a   \gset
select gen_random_uuid()::text as ro_a    \gset
select gen_random_uuid()::text as owner_b \gset
select gen_random_uuid()::text as owner_f \gset
select gen_random_uuid()::text as org_a   \gset
select gen_random_uuid()::text as org_b   \gset
select gen_random_uuid()::text as org_f   \gset
select gen_random_uuid()::text as conn_a  \gset
select gen_random_uuid()::text as conn_am \gset
select gen_random_uuid()::text as conn_b  \gset
select gen_random_uuid()::text as conn_f  \gset
select gen_random_uuid()::text as conn_r  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_a') as owner_a_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'admin_a') as admin_a_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'mgr_a')   as mgr_a_c   \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'ro_a')    as ro_a_c    \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_b') as owner_b_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_f') as owner_f_c \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
  from (values (:'owner_a'::uuid, 'ig-owner-a-' || :'owner_a' || '@test.local'),
               (:'admin_a'::uuid, 'ig-admin-a-' || :'admin_a' || '@test.local'),
               (:'mgr_a'::uuid,   'ig-mgr-a-'   || :'mgr_a'   || '@test.local'),
               (:'ro_a'::uuid,    'ig-ro-a-'    || :'ro_a'    || '@test.local'),
               (:'owner_b'::uuid, 'ig-owner-b-' || :'owner_b' || '@test.local'),
               (:'owner_f'::uuid, 'ig-owner-f-' || :'owner_f' || '@test.local')) v(u, e);

insert into public.organisations (id, name, slug) values
  (:'org_a', 'Integrations Alpha', 'ig-alpha-' || left(:'org_a', 8)),
  (:'org_b', 'Integrations Beta',  'ig-beta-'  || left(:'org_b', 8)),
  (:'org_f', 'Integrations Free',  'ig-free-'  || left(:'org_f', 8));
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
select o, p, 'monthly', 4, 'active', now() + interval '30 days'
  from (values (:'org_a'::uuid, 'starter'), (:'org_b'::uuid, 'starter'), (:'org_f'::uuid, 'free')) v(o, p)
on conflict (organisation_id) do update set plan_id = excluded.plan_id, status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_a', :'owner_a', 'owner',     'active', now()),
  (:'org_a', :'admin_a', 'admin',     'active', now()),
  (:'org_a', :'mgr_a',   'manager',   'active', now()),
  (:'org_a', :'ro_a',    'read_only', 'active', now()),
  (:'org_b', :'owner_b', 'owner',     'active', now()),
  (:'org_f', :'owner_f', 'owner',     'active', now());

-- A: one workspace-scoped and one person-scoped (the Manager's) connection.
-- B and F: one workspace-scoped each. Every connection has one sync run.
insert into public.integration_connections (id, organisation_id, provider, owner_user_id, status) values
  (:'conn_a',  :'org_a', 'xero',            null,     'active'),
  (:'conn_am', :'org_a', 'google_calendar', :'mgr_a', 'active'),
  (:'conn_b',  :'org_b', 'xero',            null,     'active'),
  (:'conn_f',  :'org_f', 'quickbooks',      null,     'active');
insert into public.integration_sync_runs (organisation_id, connection_id, status, finished_at, items_read) values
  (:'org_a', :'conn_a',  'succeeded', now(), 3),
  (:'org_a', :'conn_am', 'succeeded', now(), 2),
  (:'org_b', :'conn_b',  'succeeded', now(), 1),
  (:'org_f', :'conn_f',  'succeeded', now(), 1);

-- ===========================================================================
-- § IT THE TABLES, THE CATALOGUE AND THE GRANTS (as postgres)
-- ===========================================================================
select ig.val('IT1 both tables exist',
  $$select (to_regclass('public.integration_connections') is not null
            and to_regclass('public.integration_sync_runs') is not null)::text$$, 'true');
select ig.val('IT2 RLS is ENABLED on both',
  $$select string_agg(relname || '=' || relrowsecurity, ',' order by relname) from pg_class
     where oid in ('public.integration_connections'::regclass, 'public.integration_sync_runs'::regclass)$$,
  'integration_connections=true,integration_sync_runs=true');
select ig.val('IT3 RLS is FORCED on both',
  $$select string_agg(relname || '=' || relforcerowsecurity, ',' order by relname) from pg_class
     where oid in ('public.integration_connections'::regclass, 'public.integration_sync_runs'::regclass)$$,
  'integration_connections=true,integration_sync_runs=true');
select ig.val('IT4 authenticated holds NO INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on either table (12 checks, 0 held)',
  $$select count(*)::text || ' checks, ' || count(*) filter (where has_table_privilege('authenticated', t, p))::text || ' held'
      from unnest(array['public.integration_connections','public.integration_sync_runs']) t,
           unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p$$,
  '12 checks, 0 held');
select ig.val('IT5 anon and service_role hold NOTHING on either table, table- or column-level',
  $$select (count(*) filter (where has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))::text
         || '/' || (select count(*) from information_schema.column_privileges
                     where table_schema = 'public' and table_name in ('integration_connections','integration_sync_runs')
                       and grantee in ('anon','service_role','PUBLIC'))::text
      from unnest(array['anon','service_role']) r,
           unnest(array['public.integration_connections','public.integration_sync_runs']) t$$,
  '0/0');
select ig.val('IT6 POSITIVE CONTROL: authenticated holds SELECT on both (the read path the IR section exercises)',
  $$select (has_table_privilege('authenticated', 'public.integration_connections', 'SELECT')
            and has_table_privilege('authenticated', 'public.integration_sync_runs', 'SELECT'))::text$$, 'true');
select ig.val('IT7 NO PROVIDER IS LIVE',
  $$select count(*)::text from private.integration_providers() where live$$, '0');
select ig.val('IT8 the catalogue is exactly the eight founder-approved providers',
  $$select count(*)::text || ':' || string_agg(provider || '/' || category, ',' order by provider)
      from private.integration_providers()$$,
  '8:fatsoma/ticketing,google_calendar/calendar,google_gmail/email,microsoft_365_calendar/calendar,microsoft_365_mail/email,quickbooks/accounting,skiddle/ticketing,xero/accounting');
select ig.val('IT8b no client role executes the catalogue',
  $$select count(*) filter (where has_function_privilege(r, 'private.integration_providers()', 'EXECUTE'))::text
      from unnest(array['anon','authenticated','service_role']) r$$, '0');
select ig.val('IT9a status ''bogus'' is refused by the CHECK',
  format($$insert into public.integration_connections (organisation_id, provider, status)
           values (%L, 'skiddle', 'bogus') returning 'written'$$, :'org_a'),
  'denied(23514)');
select ig.val('IT9b a provider outside the catalogue is refused by the guard',
  format($$insert into public.integration_connections (organisation_id, provider)
           values (%L, 'eventbrite') returning 'written'$$, :'org_a'),
  'denied(23514:unknown_integration_provider)');
select ig.val('IT9c ...and an UPDATE to one is refused too',
  format($$update public.integration_connections set provider = 'eventbrite' where id = %L returning 'written'$$, :'conn_a'),
  'denied(23514:unknown_integration_provider)');
select ig.val('IT9d a sync run''s free-text error_code is refused by the CHECK',
  format($$insert into public.integration_sync_runs (organisation_id, connection_id, status, finished_at, error_code)
           values (%L, %L, 'failed', now(), 'free text') returning 'written'$$, :'org_a', :'conn_a'),
  'denied(23514)');
select ig.val('IT9e a sync run cannot point at ANOTHER organisation''s connection (composite FK)',
  format($$insert into public.integration_sync_runs (organisation_id, connection_id)
           values (%L, %L) returning 'written'$$, :'org_a', :'conn_b'),
  'denied(23503)');
select ig.val('IT9f a second live connection to the same provider for the same scope is refused',
  format($$insert into public.integration_connections (organisation_id, provider) values (%L, 'xero') returning 'written'$$, :'org_a'),
  'denied(23505)');
select ig.val('IT9g a revoked connection must drop its secret reference',
  format($$insert into public.integration_connections (organisation_id, provider, status, revoked_at, token_secret_id)
           values (%L, 'fatsoma', 'revoked', now(), gen_random_uuid()) returning 'written'$$, :'org_a'),
  'denied(23514)');

-- Fix round 1, finding 2: every CHECK has a targeting assertion, and each
-- biconditional is probed in both directions. Every row is otherwise valid,
-- so the refusal measured is that one rule's.
select ig.val('IT9h revoked WITHOUT revoked_at is refused (status=revoked <=> revoked_at set, one way)',
  format($$insert into public.integration_connections (organisation_id, provider, status)
           values (%L, 'fatsoma', 'revoked') returning 'written'$$, :'org_a'),
  'denied(23514)');
select ig.val('IT9i ...and a live status WITH revoked_at is refused (the other way)',
  format($$insert into public.integration_connections (organisation_id, provider, status, revoked_at)
           values (%L, 'fatsoma', 'active', now()) returning 'written'$$, :'org_a'),
  'denied(23514)');
select ig.val('IT9j a FAILED sync run without an error_code is refused (status=failed <=> error_code set, one way)',
  format($$insert into public.integration_sync_runs (organisation_id, connection_id, status, finished_at)
           values (%L, %L, 'failed', now()) returning 'written'$$, :'org_a', :'conn_a'),
  'denied(23514)');
select ig.val('IT9k ...and a SUCCEEDED one carrying an error_code is refused (the other way)',
  format($$insert into public.integration_sync_runs (organisation_id, connection_id, status, finished_at, error_code)
           values (%L, %L, 'succeeded', now(), 'internal') returning 'written'$$, :'org_a', :'conn_a'),
  'denied(23514)');
select ig.val('IT9l a RUNNING sync run with finished_at set is refused (status=running <=> finished_at null, one way)',
  format($$insert into public.integration_sync_runs (organisation_id, connection_id, status, finished_at)
           values (%L, %L, 'running', now()) returning 'written'$$, :'org_a', :'conn_a'),
  'denied(23514)');
select ig.val('IT9m ...and a SUCCEEDED one without finished_at is refused (the other way)',
  format($$insert into public.integration_sync_runs (organisation_id, connection_id, status)
           values (%L, %L, 'succeeded') returning 'written'$$, :'org_a', :'conn_a'),
  'denied(23514)');
select ig.val('IT9n a negative items_read is refused',
  format($$insert into public.integration_sync_runs (organisation_id, connection_id, items_read)
           values (%L, %L, -1) returning 'written'$$, :'org_a', :'conn_a'),
  'denied(23514)');
select ig.val('IT9o a negative items_written is refused',
  format($$insert into public.integration_sync_runs (organisation_id, connection_id, items_written)
           values (%L, %L, -1) returning 'written'$$, :'org_a', :'conn_a'),
  'denied(23514)');

insert into public.integration_connections (id, organisation_id, provider, status, revoked_at)
values (:'conn_r', :'org_a', 'skiddle', 'revoked', now());
select ig.val('IT10 REVOKED IS TERMINAL: revoked -> active is refused, even as postgres with the row otherwise consistent',
  format($$update public.integration_connections set status = 'active', revoked_at = null where id = %L returning 'written'$$, :'conn_r'),
  'denied(23514:revoked_is_terminal)');
select ig.val('IT10b POSITIVE CONTROL: a live connection still moves (active -> error)',
  format($$update public.integration_connections set status = 'error' where id = %L returning status$$, :'conn_a'),
  'error');
update public.integration_connections set status = 'active' where id = :'conn_a';
delete from public.integration_connections where id = :'conn_r';

select ig.val('IT11 manage_integrations: seeded, does not survive suspension, Owner and Admin only',
  $$select p.survives_suspension::text || ':' ||
           (select string_agg(role_key, ',' order by role_key) from public.role_permissions
             where permission_key = 'manage_integrations')
      from public.permissions p where p.key = 'manage_integrations'$$,
  'false:admin,owner');

set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IT12 a postgres-owned SECURITY DEFINER insert (Task 2''s shape) lands under the attribution trigger, unstamped -- the RPC must set created_by itself',
  format($$select ig.definer_insert(%L)$$, :'org_a'), 'landed:created_by=null');
reset role;
reset request.jwt.claims;

select ig.val('IT13 the attribution rail is attached to integration_connections, enabled, BEFORE INSERT OR UPDATE',
  $$select count(*)::text from pg_trigger t
     where t.tgrelid = 'public.integration_connections'::regclass and not t.tgisinternal
       and t.tgfoid = 'private.stamp_row_attribution()'::regprocedure and t.tgenabled = 'O'
       and (t.tgtype & 2) <> 0 and (t.tgtype & 4) <> 0 and (t.tgtype & 16) <> 0$$, '1');
-- IT14: the rail BINDS a non-owner writer. No client role can write the table,
-- so the probe lends `authenticated` an INSERT grant inside a transaction that
-- is rolled back: a BEFORE ROW trigger fires ahead of the RLS WITH CHECK, so
-- the refusal measured is the trigger's. The record() row is rolled back with
-- it and re-recorded after (the KT pattern, rls_phase8_closure_backup.sql).
begin;
grant insert on public.integration_connections to authenticated;
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', :'owner_a_c', true) \gset
select ig.val('IT14 a non-owner INSERT naming someone else as created_by is refused by the attribution rail',
  format($$insert into public.integration_connections (organisation_id, provider, created_by)
           values (%L, 'quickbooks', %L) returning 'written'$$, :'org_a', :'admin_a'),
  'denied(23514:attribution_is_the_sessions)');
reset role;
select label as it14_label, expected as it14_expected, actual as it14_actual from ig.results where label like 'IT14%' \gset
rollback;
select ig.record(:'it14_label', :'it14_expected', :'it14_actual');

-- ===========================================================================
-- § IR WHO READS (A: workspace row + the Manager's person row; B; F)
-- ===========================================================================
\o /dev/null
select format($$select 'A=' || count(*) filter (where organisation_id = %L)
                    || ',B=' || count(*) filter (where organisation_id = %L)
                    || ',F=' || count(*) filter (where organisation_id = %L)
                  from public.integration_connections$$, :'org_a', :'org_b', :'org_f') as vis_c \gset
select format($$select 'A=' || count(*) filter (where organisation_id = %L)
                    || ',B=' || count(*) filter (where organisation_id = %L)
                    || ',F=' || count(*) filter (where organisation_id = %L)
                  from public.integration_sync_runs$$, :'org_a', :'org_b', :'org_f') as vis_r \gset
\o

set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IR1a A''s Owner reads both of A''s connections and none of B''s', :'vis_c', 'A=2,B=0,F=0');
select ig.val('IR1b ...and both of A''s sync runs, none of B''s',            :'vis_r', 'A=2,B=0,F=0');
set request.jwt.claims = :'admin_a_c';
select ig.val('IR2a A''s Admin reads both of A''s connections and none of B''s', :'vis_c', 'A=2,B=0,F=0');
select ig.val('IR2b ...and both of A''s sync runs',                            :'vis_r', 'A=2,B=0,F=0');
set request.jwt.claims = :'mgr_a_c';
select ig.val('IR3a A''s Manager reads ONLY the person-scoped connection they own',
  format($$select string_agg(id::text, ',') = %L from public.integration_connections$$, :'conn_am'), 'true');
select ig.val('IR3b ...and only its sync run',                                 :'vis_r', 'A=1,B=0,F=0');
set request.jwt.claims = :'ro_a_c';
select ig.val('IR4a A''s Read Only reads no connection',                        :'vis_c', 'A=0,B=0,F=0');
select ig.val('IR4b ...and no sync run',                                       :'vis_r', 'A=0,B=0,F=0');
set request.jwt.claims = :'owner_b_c';
select ig.val('IR5a B''s Owner reads B''s connection and never A''s',           :'vis_c', 'A=0,B=1,F=0');
select ig.val('IR5b ...and B''s sync run, never A''s',                          :'vis_r', 'A=0,B=1,F=0');
set request.jwt.claims = :'owner_f_c';
select ig.val('IR6a DOWNGRADE HIDES NOTHING: a Free workspace''s Owner still reads its connection', :'vis_c', 'A=0,B=0,F=1');
select ig.val('IR6b ...and its sync run',                                      :'vis_r', 'A=0,B=0,F=1');
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'owner_a') as owner_a_c1 \gset
set request.jwt.claims = :'owner_a_c1';
select ig.val('IR7 MFA: A''s Owner at aal1 reads no workspace-scoped connection (manage_integrations is aal2-gated)', :'vis_c', 'A=0,B=0,F=0');
reset role;
reset request.jwt.claims;

-- Fix round 1, finding 1: the person-scoped branch is owner_user_id = me AND
-- view_crm in that workspace. Without the second conjunct a person who has
-- been revoked from, or has left, the workspace keeps reading their old row.
-- IR3 is the positive control (same person, active membership).
update public.organisation_memberships set status = 'revoked'
 where organisation_id = :'org_a' and user_id = :'mgr_a';
set role authenticated;
set request.jwt.claims = :'mgr_a_c';
select ig.val('IR8a a REVOKED member no longer reads the person-scoped connection they own', :'vis_c', 'A=0,B=0,F=0');
select ig.val('IR8b ...nor its sync run',                                          :'vis_r', 'A=0,B=0,F=0');
reset role;
reset request.jwt.claims;
delete from public.organisation_memberships where organisation_id = :'org_a' and user_id = :'mgr_a';
set role authenticated;
set request.jwt.claims = :'mgr_a_c';
select ig.val('IR9a a member who has LEFT (membership deleted) no longer reads the connection they own', :'vis_c', 'A=0,B=0,F=0');
select ig.val('IR9b ...nor its sync run',                                          :'vis_r', 'A=0,B=0,F=0');
reset role;
reset request.jwt.claims;
select ig.val('IR9c FIXTURE: the row itself still exists, owned by them (the zero is the policy, not a missing row)',
  format($$select count(*)::text from public.integration_connections where id = %L and owner_user_id = %L$$, :'conn_am', :'mgr_a'), '1');

-- ===========================================================================
-- § IB BREAKOUT: A's Owner forges every write on both tables.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IB1 a forged INSERT on integration_connections is refused by privilege',
  format($$insert into public.integration_connections (organisation_id, provider) values (%L, 'quickbooks') returning 'written'$$, :'org_a'),
  'denied(42501:missing_grant)');
select ig.val('IB2 a forged UPDATE on integration_connections (planting a secret id) is refused by privilege',
  format($$update public.integration_connections set token_secret_id = gen_random_uuid() where id = %L returning 'written'$$, :'conn_a'),
  'denied(42501:missing_grant)');
select ig.val('IB3 a forged DELETE on integration_connections is refused by privilege',
  format($$delete from public.integration_connections where id = %L returning 'written'$$, :'conn_a'),
  'denied(42501:missing_grant)');
select ig.val('IB4a a forged INSERT on integration_sync_runs is refused by privilege',
  format($$insert into public.integration_sync_runs (organisation_id, connection_id) values (%L, %L) returning 'written'$$, :'org_a', :'conn_a'),
  'denied(42501:missing_grant)');
select ig.val('IB4b a forged UPDATE on integration_sync_runs is refused by privilege',
  format($$update public.integration_sync_runs set items_written = 99 where connection_id = %L returning 'written'$$, :'conn_a'),
  'denied(42501:missing_grant)');
select ig.val('IB4c a forged DELETE on integration_sync_runs is refused by privilege',
  format($$delete from public.integration_sync_runs where connection_id = %L returning 'written'$$, :'conn_a'),
  'denied(42501:missing_grant)');
reset role;
reset request.jwt.claims;
select ig.val('IB5 the row counts are unchanged (4 connections, 4 sync runs, none written to)',
  format($$select (select count(*) from public.integration_connections where organisation_id in (%L, %L, %L))::text || '/' ||
                  (select count(*) from public.integration_sync_runs where organisation_id in (%L, %L, %L) and items_written = 0)::text || '/' ||
                  (select count(*) from public.integration_connections where token_secret_id is not null)::text$$,
         :'org_a', :'org_b', :'org_f', :'org_a', :'org_b', :'org_f'),
  '4/4/0');

-- ===========================================================================
-- § IZ HOUSEKEEPING
-- ===========================================================================
delete from public.integration_connections where organisation_id in (:'org_a', :'org_b', :'org_f');
set session_replication_role = replica;
delete from public.audit_events where organisation_id in (:'org_a', :'org_b', :'org_f')
   or actor_user_id in (:'owner_a', :'admin_a', :'mgr_a', :'ro_a', :'owner_b', :'owner_f');
delete from public.organisation_memberships where organisation_id in (:'org_a', :'org_b', :'org_f');
delete from public.organisation_subscriptions where organisation_id in (:'org_a', :'org_b', :'org_f');
delete from public.organisations where id in (:'org_a', :'org_b', :'org_f');
set session_replication_role = origin;
delete from auth.users where id in (:'owner_a', :'admin_a', :'mgr_a', :'ro_a', :'owner_b', :'owner_f');
select ig.val('IZ1 housekeeping left no integration row behind',
  format($$select (select count(*) from public.integration_connections where organisation_id in (%L, %L, %L))
                + (select count(*) from public.integration_sync_runs where organisation_id in (%L, %L, %L))$$,
         :'org_a', :'org_b', :'org_f', :'org_a', :'org_b', :'org_f'), '0');

\echo
\echo ==================== PHASE 9 INTEGRATIONS ====================
select seq, label, expected, actual, pass from ig.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from ig.results;

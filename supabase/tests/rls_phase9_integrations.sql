-- ===========================================================================
-- PHASE 9 -- INTEGRATIONS (schema only, no live provider; founder 2026-10-09).
--
-- Task 1 (20261030000000_integration_tables.sql):
--   IT  the tables, the catalogue, the constraints, the guard, the grants
--   IR  who reads a connection and its sync runs
--   IB  breakout: no client role writes either table
--   IZ  housekeeping
--
-- Task 2 (20261030001000_integration_rpcs.sql):
--   IC  connect_integration's refusal rails, the only route to a row, downgrade
--   IV  Vault: store/read are the server's alone; revoke deletes the secret
--   IS  sync runs: open/close, failure, the closed error vocabulary
--   IA  no integration audit payload carries a secret id or a token
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
select gen_random_uuid()::text as mgr2_a  \gset
select gen_random_uuid()::text as owner_s \gset
select gen_random_uuid()::text as org_s   \gset
select gen_random_uuid()::text as conn_s  \gset
select gen_random_uuid()::text as conn_v  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'mgr2_a')  as mgr2_a_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_s') as owner_s_c \gset
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
               (:'owner_f'::uuid, 'ig-owner-f-' || :'owner_f' || '@test.local'),
               (:'mgr2_a'::uuid,  'ig-mgr2-a-'  || :'mgr2_a'  || '@test.local'),
               (:'owner_s'::uuid, 'ig-owner-s-' || :'owner_s' || '@test.local')) v(u, e);

insert into public.organisations (id, name, slug) values
  (:'org_a', 'Integrations Alpha', 'ig-alpha-' || left(:'org_a', 8)),
  (:'org_b', 'Integrations Beta',  'ig-beta-'  || left(:'org_b', 8)),
  (:'org_f', 'Integrations Free',  'ig-free-'  || left(:'org_f', 8)),
  (:'org_s', 'Integrations Suspended', 'ig-susp-' || left(:'org_s', 8));
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
select o, p, 'monthly', 4, 'active', now() + interval '30 days'
  from (values (:'org_a'::uuid, 'starter'), (:'org_b'::uuid, 'starter'), (:'org_f'::uuid, 'free'), (:'org_s'::uuid, 'starter')) v(o, p)
on conflict (organisation_id) do update set plan_id = excluded.plan_id, status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_a', :'owner_a', 'owner',     'active', now()),
  (:'org_a', :'admin_a', 'admin',     'active', now()),
  (:'org_a', :'mgr_a',   'manager',   'active', now()),
  (:'org_a', :'ro_a',    'read_only', 'active', now()),
  (:'org_b', :'owner_b', 'owner',     'active', now()),
  (:'org_f', :'owner_f', 'owner',     'active', now()),
  (:'org_a', :'mgr2_a',  'manager',   'active', now()),
  (:'org_s', :'owner_s', 'owner',     'active', now());

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
-- Task 2 narrowed connections to a COLUMN grant (token_secret_id withheld,
-- IT15), so its half of the control is has_any_column_privilege.
select ig.val('IT6 POSITIVE CONTROL: authenticated holds SELECT on both (columns of connections, the whole of sync runs; the read path IR exercises)',
  $$select (has_any_column_privilege('authenticated', 'public.integration_connections', 'SELECT')
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
-- TASK 2 (20261030001000): THE RPCs, VAULT AND THE AUDIT ACTIONS.
-- ===========================================================================
grant usage on schema ig to service_role;
grant execute on function ig.record(text,text,text) to service_role;
grant execute on function ig.val(text,text,text)    to service_role;

-- Deletes an account and undoes it, reporting whether the delete itself was
-- allowed (IT10d: the FK's ON DELETE SET NULL on a REVOKED row must get past
-- the frozen-row guard).
create function ig.probe_delete_user(p_user uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_hint text;
begin
  begin
    delete from auth.users where id = p_user;
    raise exception using errcode = 'P0001', message = 'ig_undo';
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'ig_undo' then return 'deleted_and_undone'; end if;
      return 'denied(P0001)';
    when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      return 'denied(' || sqlstate || coalesce(':' || nullif(v_hint, ''), '') || ')';
  end;
end $$;

-- The whole text of a refusal (message | detail | hint), so IS4b can prove a
-- refused value is not echoed back.
create function ig.err_text(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare m text; d text; h text;
begin
  begin
    execute p_sql;
    return 'no_error';
  exception when others then
    get stacked diagnostics m = message_text, d = pg_exception_detail, h = pg_exception_hint;
    return coalesce(m, '') || '|' || coalesce(d, '') || '|' || coalesce(h, '');
  end;
end $$;
grant execute on function ig.err_text(text) to service_role;

\o /dev/null
select gen_random_uuid()::text as conn_p \gset
select '{"role":"service_role"}' as svc_c \gset
select format('{"sub":"%s","role":"service_role"}', :'owner_a') as svc_sub_c \gset
\o

-- ---------------------------------------------------------------------------
-- § IT (Task 2): the column grant, and the frozen revoked row.
-- ---------------------------------------------------------------------------
select ig.val('IT15 token_secret_id is NOT selectable by authenticated (column-level)',
  $$select has_column_privilege('authenticated', 'public.integration_connections', 'token_secret_id', 'SELECT')::text$$,
  'false');
select ig.val('IT15b ...every OTHER column is (12 of 12), and no table-level SELECT remains to override the column revoke',
  $$select count(*) filter (where has_column_privilege('authenticated', 'public.integration_connections', a.attname, 'SELECT'))::text
           || '/' || count(*)::text || ':' ||
           has_table_privilege('authenticated', 'public.integration_connections', 'SELECT')::text
      from pg_attribute a
     where a.attrelid = 'public.integration_connections'::regclass and a.attnum > 0 and not a.attisdropped
       and a.attname <> 'token_secret_id'$$,
  '12/12:false');

insert into public.integration_connections (id, organisation_id, provider, status, revoked_at, revoked_by, created_by)
values (:'conn_r', :'org_a', 'skiddle', 'revoked', now(), :'admin_a', :'admin_a');
select ig.val('IT10c REVOKED IS FROZEN: any other column of a revoked row is refused (scopes), even as postgres',
  format($$update public.integration_connections set scopes = '{read}' where id = %L returning 'written'$$, :'conn_r'),
  'denied(23514:revoked_is_terminal)');
select ig.val('IT10c2 ...and last_synced_at',
  format($$update public.integration_connections set last_synced_at = now() where id = %L returning 'written'$$, :'conn_r'),
  'denied(23514:revoked_is_terminal)');
select ig.val('IT10c3 ...and re-pointing revoked_by at another person (only NULLING it is the FK''s)',
  format($$update public.integration_connections set revoked_by = %L where id = %L returning 'written'$$, :'owner_a', :'conn_r'),
  'denied(23514:revoked_is_terminal)');
select ig.val('IT10d POSITIVE CONTROL: deleting the account that revoked it still works (the FK''s SET NULL passes the guard)',
  format($$select ig.probe_delete_user(%L)$$, :'admin_a'), 'deleted_and_undone');
delete from public.integration_connections where id = :'conn_r';

-- ---------------------------------------------------------------------------
-- § IC CONNECT: one assertion per refusal, in the documented order.
-- ---------------------------------------------------------------------------
select ig.val('IC0 member RPCs: authenticated may EXECUTE connect and revoke; anon may not',
  $$select has_function_privilege('authenticated', 'public.connect_integration(uuid,text,uuid)', 'EXECUTE')::text || '/' ||
           has_function_privilege('authenticated', 'public.revoke_integration(uuid,uuid)', 'EXECUTE')::text || '/' ||
           has_function_privilege('anon', 'public.connect_integration(uuid,text,uuid)', 'EXECUTE')::text || '/' ||
           has_function_privilege('anon', 'public.revoke_integration(uuid,uuid)', 'EXECUTE')::text$$,
  'true/true/false/false');
select ig.val('IC0b server RPCs: service_role ALONE may EXECUTE store/read/sync',
  $$select string_agg(r || '=' || has_function_privilege(r, f, 'EXECUTE')::text, ',' order by f, r)
      from unnest(array['public.store_integration_token(uuid,jsonb,timestamptz)',
                        'public.read_integration_token(uuid)',
                        'public.record_integration_sync_run(uuid,uuid,text,integer,integer,text)']) f,
           unnest(array['anon','authenticated','service_role']) r$$,
  'anon=false,authenticated=false,service_role=true,anon=false,authenticated=false,service_role=true,anon=false,authenticated=false,service_role=true');

-- S: a Starter workspace with one connection, then suspended (as postgres;
-- the lifecycle guard exempts the owner role).
insert into public.integration_connections (id, organisation_id, provider, status)
values (:'conn_s', :'org_s', 'xero', 'active');
update public.organisations set deleted_at = now() where id = :'org_s';

set role authenticated;
set request.jwt.claims = '{"role":"authenticated"}';
select ig.val('IC1 not_authenticated: a session with no sub',
  format($$select public.connect_integration(%L, 'google_gmail')::text$$, :'org_a'), 'denied(28000:not_authenticated)');
set request.jwt.claims = :'mgr2_a_c';
select ig.val('IC2 forbidden: A''s Manager (no manage_integrations)',
  format($$select public.connect_integration(%L, 'google_gmail')::text$$, :'org_a'), 'denied(42501:forbidden)');
set request.jwt.claims = :'owner_a_c1';
select ig.val('IC2b forbidden: A''s Owner at aal1 (manage_integrations is MFA-gated)',
  format($$select public.connect_integration(%L, 'google_gmail')::text$$, :'org_a'), 'denied(42501:forbidden)');
set request.jwt.claims = :'owner_f_c';
select ig.val('IC3 plan: F''s Owner (Free tier)',
  format($$select public.connect_integration(%L, 'google_gmail')::text$$, :'org_f'), 'denied(42501:plan_does_not_include_integrations)');
set request.jwt.claims = :'owner_s_c';
select ig.val('IC4 not writable: S''s Owner, S suspended (Starter, so not the plan)',
  format($$select public.connect_integration(%L, 'google_gmail')::text$$, :'org_s'), 'denied(42501:workspace_not_writable)');
reset role;
update public.organisations set lifecycle_state = 'owner_closed' where id = :'org_s';
set role authenticated;
select ig.val('IC4b not writable: S''s Owner, S closed by its Owner',
  format($$select public.connect_integration(%L, 'google_gmail')::text$$, :'org_s'), 'denied(42501:workspace_not_writable)');
set request.jwt.claims = :'owner_a_c';
select ig.val('IC5 unknown: ''nope''',
  format($$select public.connect_integration(%L, 'nope')::text$$, :'org_a'), 'denied(22023:unknown_integration_provider)');
select ig.val('IC6 NOT LIVE: ''google_gmail'' (at MVP every real call ends here)',
  format($$select public.connect_integration(%L, 'google_gmail')::text$$, :'org_a'), 'denied(22023:integration_provider_not_live)');
set request.jwt.claims = :'admin_a_c';
select ig.val('IC6b ...and as A''s Admin',
  format($$select public.connect_integration(%L, 'xero')::text$$, :'org_a'), 'denied(22023:integration_provider_not_live)');
set request.jwt.claims = :'owner_b_c';
select ig.val('IC7 forbidden: B''s Owner on A',
  format($$select public.connect_integration(%L, 'google_gmail')::text$$, :'org_a'), 'denied(42501:forbidden)');
select ig.val('IC7b forbidden: a workspace that does not exist',
  $$select public.connect_integration(gen_random_uuid(), 'google_gmail')::text$$, 'denied(42501:forbidden)');
reset role;
reset request.jwt.claims;
select ig.val('IC8 no refused connect wrote a row or an audit row',
  format($$select (select count(*) from public.integration_connections where organisation_id in (%L, %L, %L, %L))::text || '/' ||
                  (select count(*) from public.audit_events where action = 'integration.connected'
                      and organisation_id in (%L, %L, %L, %L))::text$$,
         :'org_a', :'org_b', :'org_f', :'org_s', :'org_a', :'org_b', :'org_f', :'org_s'),
  '5/0');

-- IC9: THE ONLY ROUTE TO A ROW AT MVP IS A CATALOGUE CHANGE, and that is a
-- deliberate future migration. Here it is made inside a transaction that is
-- rolled back, so IT7 (no provider live) still holds after it. The results
-- recorded inside are carried across the rollback (the KT pattern).
begin;
create or replace function private.integration_providers()
returns table (provider text, category text, live boolean)
language sql immutable set search_path = '' as $$
  values ('google_gmail','email',false), ('google_calendar','calendar',false),
         ('microsoft_365_mail','email',false), ('microsoft_365_calendar','calendar',false),
         ('skiddle','ticketing',true), ('fatsoma','ticketing',false),
         ('xero','accounting',false), ('quickbooks','accounting',false)
$$;
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', :'owner_a_c', true) as ic9_claims \gset
select ig.val('IC9 POSITIVE CONTROL (the only route to a row at MVP: skiddle made live in a rolled-back transaction): A''s Owner connects',
  format($$select (public.connect_integration(%L, 'skiddle') is not null)::text$$, :'org_a'), 'true');
select ig.val('IC9c ...a second connect to the same provider and scope is refused',
  format($$select public.connect_integration(%L, 'skiddle')::text$$, :'org_a'), 'denied(23505:integration_already_connected)');
select ig.val('IC9d ...owner_not_a_member: a person-scoped connect for someone outside A',
  format($$select public.connect_integration(%L, 'skiddle', %L)::text$$, :'org_a', :'owner_b'), 'denied(22023:owner_not_a_member)');
select ig.val('IC9e ...a person-scoped connect for an active member of A lands',
  format($$select (public.connect_integration(%L, 'skiddle', %L) is not null)::text$$, :'org_a', :'mgr2_a'), 'true');
reset role;
select ig.val('IC9a ...exactly one workspace-scoped PENDING row, created_by = the caller (stamped by the RPC itself)',
  format($$select count(*)::text from public.integration_connections
            where organisation_id = %L and provider = 'skiddle' and owner_user_id is null
              and status = 'pending' and created_by = %L and token_secret_id is null$$, :'org_a', :'owner_a'), '1');
select ig.val('IC9b ...and one integration.connected audit row per landed connect, actor the caller, payload {provider, owner_scoped}',
  format($$select string_agg(after::text, ';' order by after::text) from public.audit_events
            where action = 'integration.connected' and organisation_id = %L and actor_user_id = %L$$, :'org_a', :'owner_a'),
  '{"provider": "skiddle", "owner_scoped": false};{"provider": "skiddle", "owner_scoped": true}');
select coalesce(json_agg(json_build_object('label', label, 'expected', expected, 'actual', actual) order by seq)::text, '[]') as ic9_rows
  from ig.results where label like 'IC9%' \gset
rollback;
insert into ig.results (label, expected, actual, pass)
select r.label, r.expected, r.actual, r.expected is not distinct from r.actual
  from json_to_recordset(:'ic9_rows'::json) as r(label text, expected text, actual text);
select ig.val('IC9z ...and the rollback took the row, the audit and the live provider with it',
  format($$select (select count(*) from public.integration_connections where organisation_id = %L and provider = 'skiddle')::text || '/' ||
                  (select count(*) from public.audit_events where action = 'integration.connected' and organisation_id = %L)::text || '/' ||
                  (select count(*) from private.integration_providers() where live)::text$$, :'org_a', :'org_a'),
  '0/0/0');

-- IC10: DOWNGRADE KEEPS DATA. A moves to Free with its rows in place.
update public.organisation_subscriptions set plan_id = 'free' where organisation_id = :'org_a';
set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IC10 downgraded to Free, A''s Owner still SELECTs both of A''s connections',
  format($$select count(*)::text from public.integration_connections where organisation_id = %L$$, :'org_a'), '2');
select ig.val('IC10b ...and a new connect is refused on the plan',
  format($$select public.connect_integration(%L, 'google_gmail')::text$$, :'org_a'), 'denied(42501:plan_does_not_include_integrations)');
reset role;
reset request.jwt.claims;
update public.organisation_subscriptions set plan_id = 'starter' where organisation_id = :'org_a';

-- IC11: REVOKE WORKS ON A WOUND-DOWN WORKSPACE (S suspended again).
update public.organisations set lifecycle_state = 'suspended' where id = :'org_s';
set role authenticated;
set request.jwt.claims = :'owner_b_c';
select ig.val('IC11a B''s Owner cannot revoke S''s connection',
  format($$select 'ok' from public.revoke_integration(%L, %L)$$, :'org_s', :'conn_s'), 'denied(42501:forbidden)');
select ig.val('IC11a2 ...nor learn whether an id exists (a made-up id is the same refusal)',
  format($$select 'ok' from public.revoke_integration(%L, gen_random_uuid())$$, :'org_s'), 'denied(42501:forbidden)');
set request.jwt.claims = :'owner_s_c';
select ig.val('IC11 S''s Owner revokes S''s connection while S is SUSPENDED',
  format($$select 'ok' from public.revoke_integration(%L, %L)$$, :'org_s', :'conn_s'), 'ok');
select ig.val('IC11c ...an unknown id in their own workspace is not_found, not forbidden',
  format($$select 'ok' from public.revoke_integration(%L, gen_random_uuid())$$, :'org_s'), 'denied(P0002:integration_connection_not_found)');
reset role;
reset request.jwt.claims;
select ig.val('IC11b ...it is revoked, revoked_at set, revoked_by = the caller (stamped by the RPC itself)',
  format($$select status || ':' || (revoked_at is not null)::text || ':' || (revoked_by = %L)::text
             from public.integration_connections where id = %L$$, :'owner_s', :'conn_s'),
  'revoked:true:true');

-- IC12: A PERSON REVOKES THEIR OWN person-scoped connection (no
-- manage_integrations needed); another member without it cannot.
insert into public.integration_connections (id, organisation_id, provider, owner_user_id, status)
values (:'conn_p', :'org_a', 'microsoft_365_mail', :'mgr2_a', 'active');
set role authenticated;
set request.jwt.claims = :'ro_a_c';
select ig.val('IC12a A''s Read Only cannot revoke the Manager''s person-scoped connection',
  format($$select 'ok' from public.revoke_integration(%L, %L)$$, :'org_a', :'conn_p'), 'denied(42501:forbidden)');
set request.jwt.claims = :'mgr2_a_c';
select ig.val('IC12 the Manager revokes the person-scoped connection they own',
  format($$select 'ok' from public.revoke_integration(%L, %L)$$, :'org_a', :'conn_p'), 'ok');
reset role;
reset request.jwt.claims;
select ig.val('IC12b ...revoked_by = the Manager',
  format($$select status || ':' || (revoked_by = %L)::text from public.integration_connections where id = %L$$, :'mgr2_a', :'conn_p'),
  'revoked:true');

-- ---------------------------------------------------------------------------
-- § IV VAULT. The token is the server's: stored, read and deleted by RPC.
-- ---------------------------------------------------------------------------
insert into public.integration_connections (id, organisation_id, provider, status)
values (:'conn_v', :'org_a', 'fatsoma', 'pending');

set role service_role;
set request.jwt.claims = :'svc_c';
select ig.val('IV1 service_role with no sub stores a token on a PENDING connection',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_live_abc123","refresh_token":"tok_refresh_xyz"}', now() + interval '1 hour')$$, :'conn_v'),
  'ok');
select ig.val('IV2 ...and reads it back',
  format($$select public.read_integration_token(%L) ->> 'access_token'$$, :'conn_v'), 'tok_live_abc123');
reset role;
reset request.jwt.claims;
\o /dev/null
select coalesce(token_secret_id::text, '00000000-0000-0000-0000-000000000000') as sec_v from public.integration_connections where id = :'conn_v' \gset
\o
select ig.val('IV3 ...the connection is active with an expiry, and a vault.secrets row named integration:<id> holds the token',
  format($$select c.status || ':' || (c.token_expires_at > now())::text || ':' ||
                  (select count(*) from vault.decrypted_secrets s
                    where s.id = c.token_secret_id and s.name = 'integration:' || c.id::text
                      and (s.decrypted_secret::jsonb ->> 'refresh_token') = 'tok_refresh_xyz')::text
             from public.integration_connections c where c.id = %L$$, :'conn_v'),
  'active:true:1');
set role service_role;
set request.jwt.claims = :'svc_c';
select ig.val('IV4 a second store ROTATES the token in place (update_secret, same secret id)',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_rotated_456"}', now() + interval '2 hours')$$, :'conn_v'),
  'ok');
select ig.val('IV4b ...the read returns the rotated token',
  format($$select public.read_integration_token(%L) ->> 'access_token'$$, :'conn_v'), 'tok_rotated_456');
-- The read needs status ACTIVE, not merely a secret: an `error` connection
-- that still holds its token is refused (the revoked case below cannot show
-- this, because a revoked row has no secret reference at all).
reset role;
update public.integration_connections set status = 'error' where id = :'conn_v';
set role service_role;
select ig.val('IV4c a connection in ERROR that still holds a token: the token is not read',
  format($$select public.read_integration_token(%L)::text$$, :'conn_v'), 'denied(P0002:integration_connection_not_active)');
reset role;
update public.integration_connections set status = 'active' where id = :'conn_v';
set role service_role;
-- A server role carrying a person: refused by the RPC itself, not by EXECUTE.
set request.jwt.claims = :'svc_sub_c';
select ig.val('IV5 a service_role session WITH a person on it cannot store',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_x"}', null)$$, :'conn_v'),
  'denied(42501:not_a_server_session)');
select ig.val('IV5b ...nor read',
  format($$select public.read_integration_token(%L)::text$$, :'conn_v'), 'denied(42501:not_a_server_session)');
select ig.val('IV5c ...nor record a sync run',
  format($$select public.record_integration_sync_run(%L, null, null, null, null, null)::text$$, :'conn_v'),
  'denied(42501:not_a_server_session)');
reset role;
reset request.jwt.claims;
select ig.val('IV3b ...the rotation kept the secret id',
  format($$select (token_secret_id = %L)::text from public.integration_connections where id = %L$$, :'sec_v', :'conn_v'), 'true');

set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IV6 A''s Owner (aal2) cannot EXECUTE store_integration_token',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_x"}', null)$$, :'conn_v'), 'denied(42501)');
select ig.val('IV6b ...nor read_integration_token',
  format($$select public.read_integration_token(%L)::text$$, :'conn_v'), 'denied(42501)');
select ig.val('IV6c ...nor record_integration_sync_run',
  format($$select public.record_integration_sync_run(%L, null, null, null, null, null)::text$$, :'conn_v'), 'denied(42501)');
select ig.val('IV7 ...nor read vault.decrypted_secrets',
  $$select count(*)::text from vault.decrypted_secrets$$, 'denied(42501)');
select ig.val('IV7b ...nor vault.secrets',
  $$select count(*)::text from vault.secrets$$, 'denied(42501)');
select ig.val('IV7c ...nor token_secret_id itself',
  format($$select token_secret_id::text from public.integration_connections where id = %L$$, :'conn_v'), 'denied(42501:missing_grant)');
select ig.val('IV7d ...so select * is refused too (the column list is the read path now)',
  format($$select count(*)::text from (select * from public.integration_connections where id = %L) x$$, :'conn_v'), 'denied(42501:missing_grant)');
select ig.val('IV7e POSITIVE CONTROL: the same Owner reads the row by naming its columns',
  format($$select provider || ':' || status from public.integration_connections where id = %L$$, :'conn_v'), 'fatsoma:active');
reset role;
reset request.jwt.claims;

select ig.val('IV8 NO integration_connections column holds the token text (of the rows with a secret, 1 checked)',
  $$select count(*) filter (where row_to_json(c)::text like '%tok\_%')::text || '/' ||
           count(*) filter (where c.token_secret_id is not null)::text
      from public.integration_connections c$$,
  '0/1');

set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IV9 A''s Owner revokes the connection',
  format($$select 'ok' from public.revoke_integration(%L, %L)$$, :'org_a', :'conn_v'), 'ok');
reset role;
reset request.jwt.claims;
select ig.val('IV9b ...the Vault secret is DELETED',
  format($$select count(*)::text from vault.secrets where id = %L$$, :'sec_v'), '0');
select ig.val('IV9c ...the row is revoked with no secret reference, revoked_by = the Owner',
  format($$select status || ':' || (token_secret_id is null)::text || ':' || (revoked_by = %L)::text
             from public.integration_connections where id = %L$$, :'owner_a', :'conn_v'),
  'revoked:true:true');
set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IV10 a second revoke is a quiet no-op',
  format($$select 'ok' from public.revoke_integration(%L, %L)$$, :'org_a', :'conn_v'), 'ok');
reset role;
reset request.jwt.claims;
select ig.val('IV10b ...ONE integration.revoked row, actor the Owner, payload {provider, owner_scoped}',
  format($$select count(*)::text || ':' || max(after::text) from public.audit_events
            where action = 'integration.revoked' and target_id = %L and actor_user_id = %L$$, :'conn_v', :'owner_a'),
  '1:{"provider": "fatsoma", "owner_scoped": false}');
set role service_role;
set request.jwt.claims = :'svc_c';
select ig.val('IV11 a revoked connection''s token cannot be read',
  format($$select public.read_integration_token(%L)::text$$, :'conn_v'), 'denied(P0002:integration_connection_not_active)');
select ig.val('IV11b ...nor stored again',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_again"}', null)$$, :'conn_v'),
  'denied(22023:integration_connection_revoked)');
reset role;
reset request.jwt.claims;
select ig.val('IV12 two integration.token_stored rows, actor the tombstone, payload the provider ONLY',
  format($$select count(*)::text || ':' || count(*) filter (where actor_user_id = private.erased_user_id())::text || ':' ||
                  string_agg(distinct after::text, ';')
             from public.audit_events where action = 'integration.token_stored' and target_id = %L$$, :'conn_v'),
  '2:2:{"provider": "fatsoma"}');

-- ---------------------------------------------------------------------------
-- § IS SYNC RUNS (conn_a, xero, active).
-- ---------------------------------------------------------------------------
set role service_role;
set request.jwt.claims = :'svc_c';
select ig.val('IS1 the server opens a sync run',
  format($$select (public.record_integration_sync_run(%L, null, null, null, null, null) is not null)::text$$, :'conn_a'), 'true');
reset role;
\o /dev/null
select coalesce(max(id::text), '00000000-0000-0000-0000-000000000000') as run1 from public.integration_sync_runs where connection_id = :'conn_a' and status = 'running' \gset
\o
set role service_role;
select ig.val('IS2 ...and closes it succeeded (5 read, 3 written)',
  format($$select (public.record_integration_sync_run(%L, %L, 'succeeded', 5, 3, null) = %L)::text$$, :'conn_a', :'run1', :'run1'), 'true');
reset role;
select ig.val('IS2b ...the run is succeeded 5/3 with finished_at, and the connection''s last_synced_at is set',
  format($$select r.status || ':' || r.items_read || '/' || r.items_written || ':' || (r.finished_at is not null)::text || ':' ||
                  (c.last_synced_at is not null)::text || ':' || c.status
             from public.integration_sync_runs r join public.integration_connections c on c.id = r.connection_id
            where r.id = %L$$, :'run1'),
  'succeeded:5/3:true:true:active');
set role service_role;
select ig.val('IS3 a second run opens',
  format($$select (public.record_integration_sync_run(%L, null, 'running', null, null, null) is not null)::text$$, :'conn_a'), 'true');
reset role;
\o /dev/null
select coalesce(max(id::text), '00000000-0000-0000-0000-000000000000') as run2 from public.integration_sync_runs where connection_id = :'conn_a' and status = 'running' \gset
\o
set role service_role;
select ig.val('IS3b ...and closes FAILED (rate_limited)',
  format($$select (public.record_integration_sync_run(%L, %L, 'failed', 1, 0, 'rate_limited') = %L)::text$$, :'conn_a', :'run2', :'run2'), 'true');
reset role;
select ig.val('IS3c ...the connection is now in error',
  format($$select status from public.integration_connections where id = %L$$, :'conn_a'), 'error');
select ig.val('IS3d ...ONE integration.sync_failed row, actor the tombstone, payload {provider, error_code}',
  format($$select count(*)::text || ':' || bool_and(actor_user_id = private.erased_user_id())::text || ':' || max(after::text)
             from public.audit_events where action = 'integration.sync_failed' and target_id = %L$$, :'conn_a'),
  '1:true:{"provider": "xero", "error_code": "rate_limited"}');
set role service_role;
select ig.val('IS4 a run on an ERROR connection still opens (a retry)',
  format($$select (public.record_integration_sync_run(%L, null, null, null, null, null) is not null)::text$$, :'conn_a'), 'true');
reset role;
\o /dev/null
select coalesce(max(id::text), '00000000-0000-0000-0000-000000000000') as run3 from public.integration_sync_runs where connection_id = :'conn_a' and status = 'running' \gset
\o
set role service_role;
select ig.val('IS5 a FREE-TEXT error code is refused, before the CHECK sees it',
  format($$select public.record_integration_sync_run(%L, %L, 'failed', 0, 0, 'token tok_leak_999 expired')::text$$, :'conn_a', :'run3'),
  'denied(22023:unknown_sync_error_code)');
select ig.val('IS5b ...and the refusal does not echo the value back (message, detail and hint)',
  format($$select case when e = 'no_error' then 'no_error' when e like '%%tok_leak%%' then 'echoed' else 'clean' end
             from (select ig.err_text(%L) e) x$$,
         format($q$select public.record_integration_sync_run(%L, %L, 'failed', 0, 0, 'token tok_leak_999 expired')$q$, :'conn_a', :'run3')),
  'clean');
select ig.val('IS6 a failed close without an error_code is refused',
  format($$select public.record_integration_sync_run(%L, %L, 'failed', 0, 0, null)::text$$, :'conn_a', :'run3'),
  'denied(22023:sync_run_error_code_mismatch)');
select ig.val('IS7 closing an already-closed run is refused',
  format($$select public.record_integration_sync_run(%L, %L, 'succeeded', 0, 0, null)::text$$, :'conn_a', :'run1'),
  'denied(P0002:sync_run_not_running)');
select ig.val('IS8 a run cannot open on a REVOKED connection',
  format($$select public.record_integration_sync_run(%L, null, null, null, null, null)::text$$, :'conn_v'),
  'denied(22023:integration_connection_not_active)');
reset role;
reset request.jwt.claims;
select ig.val('IS9 ...the refused closes changed nothing: run3 is still running, one failed run, one sync_failed row',
  format($$select (select status from public.integration_sync_runs where id = %L) || ':' ||
                  (select count(*) from public.integration_sync_runs where connection_id = %L and status = 'failed')::text || ':' ||
                  (select count(*) from public.audit_events where action = 'integration.sync_failed' and target_id = %L)::text$$,
         :'run3', :'conn_a', :'conn_a'),
  'running:1:1');

-- ---------------------------------------------------------------------------
-- § IA AUDIT PAYLOADS. Every integration audit row this suite wrote (IC9's
-- were rolled back and are checked inside IC9b) holds neither the secret id
-- nor a token.
-- ---------------------------------------------------------------------------
select ig.val('IA1 DENOMINATOR: the integration audit rows written (3 revokes, 2 stores, 1 failed sync)',
  format($$select string_agg(action || '=' || n, ',' order by action) from (
             select action, count(*) n from public.audit_events
              where action like 'integration.%%' and organisation_id in (%L, %L, %L, %L)
              group by action) x$$, :'org_a', :'org_b', :'org_f', :'org_s'),
  'integration.revoked=3,integration.sync_failed=1,integration.token_stored=2');
select ig.val('IA2 NONE of them carries the secret uuid or a token string',
  format($$select count(*)::text from public.audit_events
            where action like 'integration.%%' and organisation_id in (%L, %L, %L, %L)
              and (coalesce(before::text, '') || coalesce(after::text, '') like '%%' || %L || '%%'
                   or coalesce(before::text, '') || coalesce(after::text, '') like '%%tok\_%%')$$,
         :'org_a', :'org_b', :'org_f', :'org_s', :'sec_v'),
  '0');

-- ===========================================================================
-- § IZ HOUSEKEEPING
-- ===========================================================================
delete from vault.secrets where name in (select 'integration:' || id::text from public.integration_connections
                                          where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s'));
delete from public.integration_connections where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s');
set session_replication_role = replica;
delete from public.audit_events where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s')
   or actor_user_id in (:'owner_a', :'admin_a', :'mgr_a', :'ro_a', :'owner_b', :'owner_f', :'mgr2_a', :'owner_s');
delete from public.organisation_memberships where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s');
delete from public.organisation_subscriptions where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s');
delete from public.organisations where id in (:'org_a', :'org_b', :'org_f', :'org_s');
set session_replication_role = origin;
delete from auth.users where id in (:'owner_a', :'admin_a', :'mgr_a', :'ro_a', :'owner_b', :'owner_f', :'mgr2_a', :'owner_s');
select ig.val('IZ1 housekeeping left no integration row and no integration secret behind',
  format($$select (select count(*) from public.integration_connections where organisation_id in (%L, %L, %L, %L))
                + (select count(*) from public.integration_sync_runs where organisation_id in (%L, %L, %L, %L))
                + (select count(*) from vault.secrets where name in ('integration:' || %L, 'integration:' || %L))$$,
         :'org_a', :'org_b', :'org_f', :'org_s', :'org_a', :'org_b', :'org_f', :'org_s', :'conn_v', :'conn_a'), '0');

\echo
\echo ==================== PHASE 9 INTEGRATIONS ====================
select seq, label, expected, actual, pass from ig.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from ig.results;

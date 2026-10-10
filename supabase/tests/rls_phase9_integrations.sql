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
-- IT10e (fix round 1, m4): THE FREEZE FAILS CLOSED. A column added after the
-- guard was written is frozen too. The column is added inside a transaction
-- that is rolled back; the result is carried across (the KT pattern).
begin;
alter table public.integration_connections add column ig_probe text;
select ig.val('IT10e a column added LATER is frozen on a revoked row too (the freeze compares the whole row, not a list)',
  format($$update public.integration_connections set ig_probe = 'x' where id = %L returning 'written'$$, :'conn_r'),
  'denied(23514:revoked_is_terminal)');
select label as it10e_label, expected as it10e_expected, actual as it10e_actual from ig.results where label like 'IT10e%' \gset
rollback;
select ig.record(:'it10e_label', :'it10e_expected', :'it10e_actual');
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

-- IV5d/e/f (fix round 1, C1): THE ROLE HALF of not_a_server_session. IV5-IV5c
-- prove the `sub` half; with no sub at all, only the role check stands
-- between `anon` and a token if a later rebuild drops the EXECUTE revoke. So
-- EXECUTE is lent to anon inside a rolled-back transaction, and anon (no sub)
-- calls each RPC. Results carried across the rollback (the IC9 pattern).
begin;
grant execute on function public.store_integration_token(uuid, jsonb, timestamptz) to anon;
grant execute on function public.read_integration_token(uuid) to anon;
grant execute on function public.record_integration_sync_run(uuid, uuid, text, integer, integer, text) to anon;
grant usage on schema ig to anon;
grant execute on function ig.val(text, text, text) to anon;
grant execute on function ig.record(text, text, text) to anon;
set local role anon;
select pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true) as iv5_claims \gset
select ig.val('IV5d anon with NO sub (EXECUTE lent) cannot store: the role half of the rail',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_anon"}', null)$$, :'conn_v'),
  'denied(42501:not_a_server_session)');
select ig.val('IV5e ...nor read',
  format($$select public.read_integration_token(%L)::text$$, :'conn_v'), 'denied(42501:not_a_server_session)');
select ig.val('IV5f ...nor record a sync run',
  format($$select public.record_integration_sync_run(%L, null, null, null, null, null)::text$$, :'conn_v'),
  'denied(42501:not_a_server_session)');
reset role;
select coalesce(json_agg(json_build_object('label', label, 'expected', expected, 'actual', actual) order by seq)::text, '[]') as iv5_rows
  from ig.results where label like 'IV5d%' or label like 'IV5e%' or label like 'IV5f%' \gset
rollback;
insert into ig.results (label, expected, actual, pass)
select r.label, r.expected, r.actual, r.expected is not distinct from r.actual
  from json_to_recordset(:'iv5_rows'::json) as r(label text, expected text, actual text);
select ig.val('IV5g ...and the lent grants went with the rollback (anon executes none of the three)',
  $$select count(*) filter (where has_function_privilege('anon', f, 'EXECUTE'))::text
      from unnest(array['public.store_integration_token(uuid,jsonb,timestamptz)',
                        'public.read_integration_token(uuid)',
                        'public.record_integration_sync_run(uuid,uuid,text,integer,integer,text)']) f$$, '0');

-- IV4e-i (fix round 1, m6): A DANGLING SECRET REFERENCE. The secret is deleted
-- out of band (as postgres); the next store must leave a READABLE token, not
-- an `active` row with nothing behind it.
delete from vault.secrets where id = :'sec_v';
set role service_role;
set request.jwt.claims = :'svc_c';
select ig.val('IV4e a store over a DANGLING token_secret_id (secret deleted out of band) succeeds',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_recreated_789"}', now() + interval '1 hour')$$, :'conn_v'),
  'ok');
select ig.val('IV4f ...and the token is READABLE afterwards (the secret was recreated, not silently left missing)',
  format($$select public.read_integration_token(%L) ->> 'access_token'$$, :'conn_v'), 'tok_recreated_789');
reset role;
reset request.jwt.claims;
select ig.val('IV4g ...the row names a NEW, existing secret',
  format($$select (c.token_secret_id <> %L)::text || ':' ||
                  (select count(*) from vault.secrets s where s.id = c.token_secret_id)::text
             from public.integration_connections c where c.id = %L$$, :'sec_v', :'conn_v'),
  'true:1');
-- The other dangling shape: the id is lost while a secret under the
-- connection's own name survives (its unique name would collide).
update public.integration_connections set token_secret_id = gen_random_uuid() where id = :'conn_v';
set role service_role;
set request.jwt.claims = :'svc_c';
select ig.val('IV4h a store whose secret id is lost while a secret under the connection''s NAME survives succeeds',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_renamed_321"}', now() + interval '1 hour')$$, :'conn_v'),
  'ok');
reset role;
reset request.jwt.claims;
select ig.val('IV4i ...leaving exactly one secret under that name, the one the row names, holding the new token',
  format($$select count(*)::text || ':' || bool_and(s.id = c.token_secret_id)::text || ':' ||
                  max(s.decrypted_secret::jsonb ->> 'access_token')
             from vault.decrypted_secrets s, public.integration_connections c
            where c.id = %L and s.name = 'integration:' || c.id::text$$, :'conn_v'),
  '1:true:tok_renamed_321');
\o /dev/null
select coalesce(token_secret_id::text, '00000000-0000-0000-0000-000000000000') as sec_v from public.integration_connections where id = :'conn_v' \gset
\o

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
select ig.val('IV12 four integration.token_stored rows (IV1, IV4, IV4e, IV4h), actor the tombstone, payload the provider ONLY',
  format($$select count(*)::text || ':' || count(*) filter (where actor_user_id = private.erased_user_id())::text || ':' ||
                  string_agg(distinct after::text, ';')
             from public.audit_events where action = 'integration.token_stored' and target_id = %L$$, :'conn_v'),
  '4:4:{"provider": "fatsoma"}');

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
-- Since Task 3 (20261030003000) the revokes are FOUR: IR8 moved the Manager's
-- membership to `revoked` as postgres, and the membership trigger revoked
-- their person-scoped connection (conn_am) then -- audited with the tombstone
-- as actor, nobody being on that session. IM0 measures that row directly.
select ig.val('IM0 IR8''s membership revoke already revoked the Manager''s person-scoped connection (trigger, no session: tombstone actor, reason membership_ended)',
  format($$select c.status || ':' || (c.revoked_by is null)::text || ':' ||
                  (select count(*) from public.audit_events a
                    where a.action = 'integration.revoked' and a.target_id = c.id
                      and a.actor_user_id = private.erased_user_id()
                      and a.after = '{"provider":"google_calendar","owner_scoped":true,"reason":"membership_ended"}'::jsonb)::text
             from public.integration_connections c where c.id = %L$$, :'conn_am'),
  'revoked:true:1');
select ig.val('IA1 DENOMINATOR: the integration audit rows written (4 revokes, 4 stores, 1 failed sync)',
  format($$select string_agg(action || '=' || n, ',' order by action) from (
             select action, count(*) n from public.audit_events
              where action like 'integration.%%' and organisation_id in (%L, %L, %L, %L)
              group by action) x$$, :'org_a', :'org_b', :'org_f', :'org_s'),
  'integration.revoked=4,integration.sync_failed=1,integration.token_stored=4');
select ig.val('IA2 NONE of them carries the secret uuid or a token string',
  format($$select count(*)::text from public.audit_events
            where action like 'integration.%%' and organisation_id in (%L, %L, %L, %L)
              and (coalesce(before::text, '') || coalesce(after::text, '') like '%%' || %L || '%%'
                   or coalesce(before::text, '') || coalesce(after::text, '') like '%%tok\_%%')$$,
         :'org_a', :'org_b', :'org_f', :'org_s', :'sec_v'),
  '0');

-- ===========================================================================
-- TASK 3 (20261030003000): THE PRIVACY LIFECYCLE.
--   IM  a person who leaves a workspace loses their person-scoped connections
--   IE  erasing an account: its own connections go BEFORE auth.users does
--   IP  purging a workspace takes its Vault secrets with it
--   IX  the exports carry the metadata and never token_secret_id
--   IN  retention: the two classes, swept by the real live sweep
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as mgr3_a  \gset
select gen_random_uuid()::text as mgr4_a  \gset
select gen_random_uuid()::text as er_a    \gset
select gen_random_uuid()::text as owner_p \gset
select gen_random_uuid()::text as org_p   \gset
select gen_random_uuid()::text as conn_m3  \gset
select gen_random_uuid()::text as conn_m3b \gset
select gen_random_uuid()::text as conn_w3  \gset
select gen_random_uuid()::text as conn_m4  \gset
select gen_random_uuid()::text as conn_e1  \gset
select gen_random_uuid()::text as conn_e2  \gset
select gen_random_uuid()::text as conn_e3  \gset
select gen_random_uuid()::text as conn_p1  \gset
select gen_random_uuid()::text as conn_p2  \gset
select gen_random_uuid()::text as conn_p3  \gset
select gen_random_uuid()::text as conn_old \gset
select gen_random_uuid()::text as conn_new \gset
select gen_random_uuid()::text as ie_job  \gset
select gen_random_uuid()::text as ip_job  \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
  from (values (:'mgr3_a'::uuid,  'ig-mgr3-a-'  || :'mgr3_a'  || '@test.local'),
               (:'mgr4_a'::uuid,  'ig-mgr4-a-'  || :'mgr4_a'  || '@test.local'),
               (:'er_a'::uuid,    'ig-er-a-'    || :'er_a'    || '@test.local'),
               (:'owner_p'::uuid, 'ig-owner-p-' || :'owner_p' || '@test.local')) v(u, e);
insert into public.organisations (id, name, slug) values
  (:'org_p', 'Integrations Purged', 'ig-purge-' || left(:'org_p', 8));
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'org_p', 'starter', 'monthly', 2, 'active', now() + interval '30 days')
on conflict (organisation_id) do update set plan_id = excluded.plan_id, status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_a', :'mgr3_a',  'manager', 'active', now()),
  (:'org_b', :'mgr3_a',  'manager', 'active', now()),
  (:'org_a', :'mgr4_a',  'manager', 'active', now()),
  (:'org_a', :'er_a',    'manager', 'active', now()),
  (:'org_p', :'owner_p', 'owner',   'active', now());

-- IM: mgr3_a owns a person-scoped Gmail in A AND in B, and created A's
-- workspace-scoped QuickBooks. mgr4_a owns a person-scoped Outlook in A.
insert into public.integration_connections (id, organisation_id, provider, owner_user_id, status, created_by) values
  (:'conn_m3',  :'org_a', 'google_gmail',       :'mgr3_a', 'active', :'mgr3_a'),
  (:'conn_m3b', :'org_b', 'google_gmail',       :'mgr3_a', 'active', :'mgr3_a'),
  (:'conn_w3',  :'org_a', 'quickbooks',         null,      'active', :'mgr3_a'),
  (:'conn_m4',  :'org_a', 'microsoft_365_mail', :'mgr4_a', 'active', :'mgr4_a');
-- IE: er_a owns a person-scoped XERO in A -- A already holds a LIVE
-- workspace-scoped xero (conn_a, in `error` since IS3), which is the 23505
-- case -- with two sync runs; created A's workspace-scoped Fatsoma; and
-- created AND revoked A's workspace-scoped Skiddle.
insert into public.integration_connections (id, organisation_id, provider, owner_user_id, status, created_by) values
  (:'conn_e1', :'org_a', 'xero',    :'er_a', 'active', :'er_a'),
  (:'conn_e2', :'org_a', 'fatsoma', null,    'active', :'er_a');
insert into public.integration_connections (id, organisation_id, provider, status, created_by, revoked_at, revoked_by)
values (:'conn_e3', :'org_a', 'skiddle', 'revoked', :'er_a', now(), :'er_a');
insert into public.integration_sync_runs (organisation_id, connection_id, status, finished_at) values
  (:'org_a', :'conn_e1', 'succeeded', now()), (:'org_a', :'conn_e1', 'succeeded', now());
-- IP: one workspace-scoped and one person-scoped connection in P.
insert into public.integration_connections (id, organisation_id, provider, owner_user_id, status) values
  (:'conn_p1', :'org_p', 'xero',            null,       'active'),
  (:'conn_p2', :'org_p', 'google_calendar', :'owner_p', 'active'),
  -- Fix round 1 (C2): pending, no token_secret_id, a secret filed under its
  -- NAME (planted before IP1) -- only the purge's by-name clause can find it.
  (:'conn_p3', :'org_p', 'skiddle',         null,       'pending');
insert into public.integration_sync_runs (organisation_id, connection_id, status, finished_at) values
  (:'org_p', :'conn_p1', 'succeeded', now());

-- Every one of those person-scoped (and P's) connections holds a real token.
set role service_role;
set request.jwt.claims = :'svc_c';
select count(public.store_integration_token(x::uuid, '{"access_token":"tok_lifecycle"}', now() + interval '1 hour'))
  from unnest(array[:'conn_m3', :'conn_m3b', :'conn_m4', :'conn_e1', :'conn_p1', :'conn_p2']) x \gset ig_stored_
reset role;
reset request.jwt.claims;
\o /dev/null
select coalesce(string_agg(token_secret_id::text, ',' order by id), '') as sec_lifecycle
  from public.integration_connections where id in (:'conn_m3', :'conn_e1', :'conn_p1', :'conn_p2') \gset
select token_secret_id::text as sec_m3 from public.integration_connections where id = :'conn_m3' \gset
select token_secret_id::text as sec_e1 from public.integration_connections where id = :'conn_e1' \gset
\o
select ig.val('IL0 FIXTURE: six tokens stored, each a vault secret named for its connection',
  format($$select count(*)::text from vault.secrets s join public.integration_connections c
            on c.token_secret_id = s.id and s.name = 'integration:' || c.id::text
           where c.id in (%L, %L, %L, %L, %L, %L)$$,
         :'conn_m3', :'conn_m3b', :'conn_m4', :'conn_e1', :'conn_p1', :'conn_p2'), '6');

-- IL1 (fix round 1, C2): THE PRIMITIVE'S BY-NAME DELETE. A pending connection
-- whose token_secret_id is NULL while a secret filed under its NAME exists:
-- only the `or s.name = ...` clause can find it.
\o /dev/null
select gen_random_uuid()::text as conn_n \gset
\o
insert into public.integration_connections (id, organisation_id, provider, status)
values (:'conn_n', :'org_a', 'microsoft_365_calendar', 'pending');
select vault.create_secret('{"access_token":"tok_name_only"}', 'integration:' || :'conn_n') is not null as ig_planted_n \gset
set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IL1 FIXTURE: A''s Owner revokes a connection with NO token_secret_id but a secret filed under its name',
  format($$select 'ok' from public.revoke_integration(%L, %L)$$, :'org_a', :'conn_n'), 'ok');
reset role;
reset request.jwt.claims;
select ig.val('IL1b ...and the secret found only BY NAME is gone (revoke_integration_row''s name clause)',
  format($$select count(*)::text from vault.secrets where name = 'integration:' || %L$$, :'conn_n'), '0');

-- ---------------------------------------------------------------------------
-- § IM MEMBERSHIP REMOVAL, through the product path (the Owner's own DELETE
-- and UPDATE under RLS, as PostgREST would send them).
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IM1 A''s Owner removes mgr3_a from A (DELETE under the manage_members policy)',
  format($$with d as (delete from public.organisation_memberships
                       where organisation_id = %L and user_id = %L returning 1)
           select count(*)::text from d$$, :'org_a', :'mgr3_a'), '1');
reset role;
reset request.jwt.claims;
select ig.val('IM2 their person-scoped connection in A is REVOKED, with no secret reference, revoked_by = the Owner who removed them',
  format($$select status || ':' || (token_secret_id is null)::text || ':' || (revoked_by = %L)::text
             from public.integration_connections where id = %L$$, :'owner_a', :'conn_m3'),
  'revoked:true:true');
select ig.val('IM3 ...and its Vault secret is GONE (by id and by name)',
  format($$select (select count(*) from vault.secrets where id = %L)::text || '/' ||
                  (select count(*) from vault.secrets where name = 'integration:' || %L)::text$$, :'sec_m3', :'conn_m3'),
  '0/0');
select ig.val('IM4 the WORKSPACE-scoped connection they created stays active, still attributed to them',
  format($$select status || ':' || (created_by = %L)::text from public.integration_connections where id = %L$$,
         :'mgr3_a', :'conn_w3'),
  'active:true');
select ig.val('IM5 their person-scoped connection in ANOTHER workspace (B) is untouched, its token still readable',
  format($$select c.status || ':' || (select count(*) from vault.secrets s where s.id = c.token_secret_id)::text
             from public.integration_connections c where c.id = %L$$, :'conn_m3b'),
  'active:1');
select ig.val('IM6 ONE integration.revoked row: actor the Owner, payload {provider, owner_scoped, reason membership_ended}',
  format($$select count(*)::text || ':' || max(after::text) from public.audit_events
            where action = 'integration.revoked' and target_id = %L and actor_user_id = %L$$, :'conn_m3', :'owner_a'),
  '1:{"reason": "membership_ended", "provider": "google_gmail", "owner_scoped": true}');
set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ig.val('IM7 A''s Owner REVOKES mgr4_a''s membership (status -> revoked, the UPDATE path)',
  format($$update public.organisation_memberships set status = 'revoked'
            where organisation_id = %L and user_id = %L returning status$$, :'org_a', :'mgr4_a'), 'revoked');
reset role;
reset request.jwt.claims;
select ig.val('IM8 ...their person-scoped connection is revoked and its secret gone',
  format($$select c.status || ':' || (c.token_secret_id is null)::text || ':' ||
                  (select count(*) from vault.secrets s where s.name = 'integration:' || c.id::text)::text
             from public.integration_connections c where c.id = %L$$, :'conn_m4'),
  'revoked:true:0');
-- IM9: the trigger FIRES on any UPDATE naming status, so its own filter is
-- what keeps a non-departure from revoking. (Read in a SECOND statement: a
-- data-modifying CTE's outer query cannot see the trigger's writes.)
select ig.val('IM9 THE SAME TRIGGER, A NON-DEPARTURE: an UPDATE naming status (unchanged) and the ROLE lands...',
  format($$update public.organisation_memberships set status = status, role = 'read_only'
            where organisation_id = %L and user_id = %L returning status$$, :'org_b', :'mgr3_a'), 'active');
select ig.val('IM9b ...and revokes nothing',
  format($$select status from public.integration_connections where id = %L$$, :'conn_m3b'), 'active');
-- IM10: a membership row MOVED to another person (identity is immutable
-- through the client UPDATE policy, so this is postgres) is the old person
-- departing, whatever its status says.
update public.organisation_memberships set user_id = :'mgr4_a'
 where organisation_id = :'org_b' and user_id = :'mgr3_a';
select ig.val('IM10 a membership moved to ANOTHER person (status still active) revokes the old person''s person-scoped connection there',
  format($$select c.status || ':' || (select count(*) from vault.secrets s where s.name = 'integration:' || c.id::text)::text
             from public.integration_connections c where c.id = %L$$, :'conn_m3b'),
  'revoked:0');
-- IM10b (fix round 1, C3): the same row moved to ANOTHER WORKSPACE (B -> F)
-- is the person departing B.
\o /dev/null
select gen_random_uuid()::text as conn_m5 \gset
\o
insert into public.integration_connections (id, organisation_id, provider, owner_user_id, status)
values (:'conn_m5', :'org_b', 'google_calendar', :'mgr4_a', 'active');
update public.organisation_memberships set organisation_id = :'org_f'
 where organisation_id = :'org_b' and user_id = :'mgr4_a';
select ig.val('IM10b a membership moved to ANOTHER WORKSPACE revokes the person''s person-scoped connection in the one they left',
  format($$select status from public.integration_connections where id = %L$$, :'conn_m5'), 'revoked');

-- ---------------------------------------------------------------------------
-- § IE ERASURE. The Task 1 review case: a person-scoped xero beside A's live
-- workspace-scoped xero. Without step 5c the erasure FAILS (23505); with it,
-- the person's own connection goes before auth.users does.
-- ---------------------------------------------------------------------------
select ig.val('IE0 FIXTURE: A holds a LIVE workspace-scoped xero beside er_a''s person-scoped one (the 23505 shape)',
  format($$select count(*)::text from public.integration_connections
            where organisation_id = %L and provider = 'xero' and status <> 'revoked'$$, :'org_a'), '2');
select ig.val('IE1 (c) THE ERASURE SUCCEEDS: auth.users row deleted, the person''s connection and its two runs counted on the summary',
  format($$select (r ->> 'auth_users') || ':' || (r ->> 'integration_connections.deleted') || ':' ||
                  (r ->> 'integration_sync_runs.deleted') || ':' || (r ->> 'integration_connections.created_by') || ':' ||
                  (r ->> 'integration_connections.revoked_by')
             from (select private.erase_account(%L, %L) r) x$$, :'er_a', :'ie_job'),
  '1:1:2:2:1');
select ig.val('IE2 (a) NO ROW with the person''s former connection id survives, and NONE became workspace-scoped (A has one live xero, conn_a)',
  format($$select (select count(*) from public.integration_connections where id = %L)::text || '/' ||
                  (select string_agg(id::text, ',') from public.integration_connections
                    where organisation_id = %L and provider = 'xero' and owner_user_id is null) || '/' ||
                  (select count(*) from public.integration_connections where owner_user_id = %L)::text$$,
         :'conn_e1', :'org_a', :'er_a'),
  format('0/%s/0', :'conn_a'));
select ig.val('IE3 ...nor any of its sync runs',
  format($$select count(*)::text from public.integration_sync_runs where connection_id = %L$$, :'conn_e1'), '0');
select ig.val('IE4 (b) its Vault secret is GONE (by id and by name)',
  format($$select (select count(*) from vault.secrets where id = %L)::text || '/' ||
                  (select count(*) from vault.secrets where name = 'integration:' || %L)::text$$, :'sec_e1', :'conn_e1'),
  '0/0');
select ig.val('IE5 the WORKSPACE-scoped connection they created stays, active, created_by = the tombstone',
  format($$select status || ':' || (created_by = private.erased_user_id())::text
             from public.integration_connections where id = %L$$, :'conn_e2'),
  'active:true');
select ig.val('IE6 the REVOKED one they created and revoked: both columns moved to the tombstone (the guard admits that one move)',
  format($$select status || ':' || (created_by = private.erased_user_id())::text || ':' ||
                  (revoked_by = private.erased_user_id())::text
             from public.integration_connections where id = %L$$, :'conn_e3'),
  'revoked:true:true');
select ig.val('IE7 NO audit payload anywhere still holds their id (step 10b''s scan, asked again from outside)',
  format($$select count(*)::text from public.audit_events
            where strpos(lower(coalesce(before::text, '') || coalesce(after::text, '')), %L) > 0$$, :'er_a'), '0');
select ig.val('IE8 the revoke step audited as the tombstone, reason account_erased, and no id of theirs in it',
  format($$select count(*)::text || ':' || max(after::text) from public.audit_events
            where action = 'integration.revoked' and target_id = %L and actor_user_id = private.erased_user_id()$$, :'conn_e1'),
  '1:{"reason": "account_erased", "provider": "xero", "owner_scoped": true}');
select ig.val('IE9 a second erasure of the same account is the idempotent no-op',
  format($$select private.erase_account(%L, null)::text$$, :'er_a'), '{"already_erased": true}');

-- IE10: AN ACCOUNT DELETED OUTSIDE THE ERASURE (a raw `delete from
-- auth.users`, the Auth admin API's shape; no product path does it). The FK's
-- SET NULL reaches the person-scoped xero BEFORE any membership trigger, so
-- the guard revokes it in that write. Measured inside a probe that undoes the
-- delete.
\o /dev/null
select gen_random_uuid()::text as raw_a  \gset
select gen_random_uuid()::text as conn_r2 \gset
\o
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values (:'raw_a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'ig-raw-a-' || :'raw_a' || '@test.local', now(), now(), now());
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
values (:'org_a', :'raw_a', 'manager', 'active', now());
insert into public.integration_connections (id, organisation_id, provider, owner_user_id, status)
values (:'conn_r2', :'org_a', 'xero', :'raw_a', 'active');
-- Fix round 1 (C2): a second, PENDING person-scoped row with no
-- token_secret_id and a secret filed under its name -- only the guard's
-- by-name clause can find that one.
\o /dev/null
select gen_random_uuid()::text as conn_r3 \gset
\o
insert into public.integration_connections (id, organisation_id, provider, owner_user_id, status)
values (:'conn_r3', :'org_a', 'google_gmail', :'raw_a', 'pending');
select vault.create_secret('{"access_token":"tok_raw_name"}', 'integration:' || :'conn_r3') is not null as ig_planted_r3 \gset
set role service_role;
set request.jwt.claims = :'svc_c';
select ig.val('IE10a FIXTURE: the raw-deleted person''s xero holds a token, beside A''s live workspace xero',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_raw"}', null)$$, :'conn_r2'), 'ok');
reset role;
reset request.jwt.claims;
create function ig.raw_delete_probe(p_user uuid, p_conn uuid, p_conn2 uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  begin
    delete from auth.users where id = p_user;
    v := (select c.status || ':' || coalesce(c.owner_user_id::text, 'null') || ':' ||
                 (c.token_secret_id is null)::text || ':' ||
                 (select count(*) from vault.secrets s where s.name = 'integration:' || c.id::text)::text || ':' ||
                 (select count(*) from public.audit_events a where a.target_id = c.id and a.action = 'integration.revoked'
                     and a.actor_user_id = private.erased_user_id()
                     and a.after ->> 'reason' = 'account_deleted')::text
            from public.integration_connections c where c.id = p_conn)
         || ':' || (select count(*) from vault.secrets s where s.name = 'integration:' || p_conn2::text)::text;
    raise exception using errcode = 'P0001', message = 'ig_undo', detail = coalesce(v, 'row gone');
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'ig_undo' then
        get stacked diagnostics v = pg_exception_detail;
        return v;
      end if;
      return 'denied(P0001)';
    when others then
      return 'denied(' || sqlstate || ')';
  end;
end $$;
select ig.val('IE10 a RAW account delete succeeds (no 23505) and leaves the person''s xero REVOKED, ownerless, its secret gone, audited as account_deleted; and the pending row''s secret filed only BY NAME is gone too (the guard''s name clause)',
  format($$select ig.raw_delete_probe(%L, %L, %L)$$, :'raw_a', :'conn_r2', :'conn_r3'), 'revoked:null:true:0:1:0');
select ig.val('IE10b ...and the probe undid it: the person and their live connection are back',
  format($$select c.status || ':' || (c.owner_user_id = %L)::text from public.integration_connections c where c.id = %L$$,
         :'raw_a', :'conn_r2'), 'active:true');

-- ---------------------------------------------------------------------------
-- § IP WORKSPACE PURGE (P closed as postgres, then purged by the primitive).
-- ---------------------------------------------------------------------------
select vault.create_secret('{"access_token":"tok_purge_name"}', 'integration:' || :'conn_p3') is not null as ig_planted_p3 \gset
update public.organisations set deleted_at = now() where id = :'org_p';
select ig.val('IP1 the purge of P reports three secrets (two by id, one by name only) and three connections deleted before the cascade',
  format($$select (r ->> 'integration_secrets') || ':' || (r ->> 'integration_connections')
             from (select private.erase_organisation(%L, %L, true) r) x$$, :'org_p', :'ip_job'),
  '3:3');
select ig.val('IP3b the secret filed only BY NAME (conn_p3, no token_secret_id) is gone too (the purge''s name clause)',
  format($$select count(*)::text from vault.secrets where name = 'integration:' || %L$$, :'conn_p3'), '0');
select ig.val('IP2 0 rows left in either table for P',
  format($$select (select count(*) from public.integration_connections where organisation_id = %L)::text || '/' ||
                  (select count(*) from public.integration_sync_runs where organisation_id = %L)::text$$, :'org_p', :'org_p'),
  '0/0');
select ig.val('IP3 0 Vault secrets named integration:<P''s connection ids>, and 0 by their former ids',
  format($$select (select count(*) from vault.secrets where name in ('integration:' || %L, 'integration:' || %L))::text || '/' ||
                  (select count(*) from vault.secrets where id::text = any (string_to_array(%L, ',')))::text$$,
         :'conn_p1', :'conn_p2', :'sec_lifecycle'),
  '0/0');

-- IP4: a workspace deleted RAW (no step 5c ahead of the cascade) while it
-- holds a live person-scoped connection. The cascaded membership delete fires
-- the trigger, and by then the cascade has ALREADY removed the connection
-- (measured), so nothing is revoked and no audit row names a workspace that
-- is gone (which would be a 23503 and fail the delete).
\o /dev/null
select gen_random_uuid()::text as org_q  \gset
select gen_random_uuid()::text as conn_q \gset
\o
insert into public.organisations (id, name, slug) values (:'org_q', 'Integrations Raw', 'ig-raw-' || left(:'org_q', 8));
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
values (:'org_q', :'owner_p', 'owner', 'active', now());
insert into public.integration_connections (id, organisation_id, provider, owner_user_id, status)
values (:'conn_q', :'org_q', 'google_calendar', :'owner_p', 'active');
select ig.val('IP4 a RAW delete of a workspace holding a live person-scoped connection succeeds: the cascade removes the connection before the membership trigger looks',
  format($$with d as (delete from public.organisations where id = %L returning 1)
           select count(*)::text from d$$, :'org_q'), '1');
select ig.val('IP4b ...and the connection went with the workspace',
  format($$select count(*)::text from public.integration_connections where id = %L$$, :'conn_q'), '0');

-- ---------------------------------------------------------------------------
-- § IX EXPORTS, read the way the runner reads them (public.export_read_page,
-- as postgres with nobody on the session).
-- ---------------------------------------------------------------------------
set role service_role;
set request.jwt.claims = :'svc_c';
select ig.val('IX0 FIXTURE: A''s workspace-scoped QuickBooks holds a token, so the page has a secret to leak',
  format($$select 'ok' from public.store_integration_token(%L, '{"access_token":"tok_export_probe"}', now() + interval '1 hour')$$, :'conn_w3'),
  'ok');
reset role;
reset request.jwt.claims;
\o /dev/null
select token_secret_id::text as sec_w3 from public.integration_connections where id = :'conn_w3' \gset
set role authenticated;
set request.jwt.claims = :'owner_a_c';
with j as (insert into public.export_jobs (kind, organisation_id) values ('workspace', :'org_a') returning id)
select id::text as ix_ws_job from j \gset
set request.jwt.claims = :'mgr2_a_c';
with j as (insert into public.export_jobs (kind) values ('account') returning id)
select id::text as ix_acc_job from j \gset
reset role;
reset request.jwt.claims;
update public.export_jobs set status = 'running', started_at = now() where id in (:'ix_ws_job', :'ix_acc_job');
\o
select ig.val('IX1 POSITIVE CONTROL: A''s workspace export carries A''s connections (conn_a, the created conn_w3)',
  format($$select (p::text like '%%' || %L || '%%' and p::text like '%%' || %L || '%%')::text
             from (select public.export_read_page(%L, 'integration_connections', '', 500) p) x$$,
         :'conn_a', :'conn_w3', :'ix_ws_job'),
  'true');
select ig.val('IX2 NO ROW of it has a key named token_secret_id; every row has exactly the twelve metadata keys',
  format($$select count(*) filter (where e ? 'token_secret_id')::text || '/' ||
                  count(*) filter (where (select count(*) from jsonb_object_keys(e)) <> 12)::text || '/' ||
                  (count(*) > 0)::text
             from jsonb_array_elements(public.export_read_page(%L, 'integration_connections', '', 500)) e$$, :'ix_ws_job'),
  '0/0/true');
select ig.val('IX3 ...and neither conn_w3''s secret id nor any token text is anywhere in the page (its row IS there)',
  format($$select (p::text like '%%' || %L || '%%')::text || ':' ||
                  (p::text like '%%tok\_%%' or p::text like '%%' || %L || '%%')::text
             from (select public.export_read_page(%L, 'integration_connections', '', 500) p) x$$, :'conn_w3', :'sec_w3', :'ix_ws_job'),
  'true:false');
-- IX4: REQUESTER RLS, EXACTLY. Task 1's policy lets a manage_integrations
-- holder read every connection in the workspace (a colleague's person-scoped
-- row included -- its metadata, never its token: IR1a). The export is that
-- read and no wider: the same ids, row for row.
set role authenticated;
set request.jwt.claims = :'owner_a_c';
\o /dev/null
select string_agg(id::text, ',' order by id::text) as ix_owner_reads
  from public.integration_connections where organisation_id = :'org_a' \gset
\o
reset role;
reset request.jwt.claims;
select ig.val('IX4 the workspace export is EXACTLY the Owner''s own RLS read of A''s connections, row for row (a colleague''s person-scoped conn_p included, as IR1a reads it)',
  format($$select string_agg(e ->> 'id', ',' order by e ->> 'id') = %L and %L like '%%' || %L || '%%'
             from jsonb_array_elements(public.export_read_page(%L, 'integration_connections', '', 500)) e$$,
         :'ix_owner_reads', :'ix_owner_reads', :'conn_p', :'ix_ws_job')::text,
  'true');
select ig.val('IX5 the workspace export carries A''s sync runs',
  format($$select (jsonb_array_length(public.export_read_page(%L, 'integration_sync_runs', '', 500)) >= 3)::text$$, :'ix_ws_job'),
  'true');
select ig.val('IX6 the ACCOUNT export of mgr2_a carries ONLY their own person-scoped connection (conn_p), no workspace one',
  format($$select string_agg(e ->> 'id', ',') from jsonb_array_elements(public.export_read_page(%L, 'integration_connections', '', 500)) e$$,
         :'ix_acc_job'),
  :'conn_p');
select ig.val('IX7 ...with no token_secret_id key either',
  format($$select count(*) filter (where e ? 'token_secret_id')::text
             from jsonb_array_elements(public.export_read_page(%L, 'integration_connections', '', 500)) e$$, :'ix_acc_job'),
  '0');
select ig.val('IX8 the catalogue: both tables exported from the workspace, connections from the account, token_secret_id projected OUT',
  $$select string_agg(export_kind || '.' || table_name || ':' || disposition || ':' || authorisation || ':' ||
                      coalesce((not ('token_secret_id' = any (projection)))::text, 'all'), ',' order by export_kind, table_name)
      from private.export_catalogue() where table_name like 'integration\_%'$$,
  'account.integration_connections:exported:requester_rls:true,workspace.integration_connections:exported:requester_rls:true,workspace.integration_sync_runs:exported:requester_rls:all');
update public.export_jobs set status = 'failed', failure_reason = 'ig measurement' where id in (:'ix_ws_job', :'ix_acc_job');

-- ---------------------------------------------------------------------------
-- § IN RETENTION, through the REAL sweep body inside a subtransaction that is
-- rolled back (the cw.live_sweep_probe() shape), so nothing outside it moves.
-- ---------------------------------------------------------------------------
select ig.val('IN1 the two classes are declared: sync runs 90 days, revoked connections 2 years',
  $$select string_agg(class || '=' || period::text, ',' order by class) from private.retention_periods()
     where class like 'integration\_%'$$,
  'integration_connection_revoked=2 years,integration_sync_run=90 days');
select ig.val('IN2 both tables are SWEPT subjects under those classes (the Task 1 interim `cascades` rows are gone)',
  $$select string_agg(table_name || ':' || treatment || ':' || class, ',' order by table_name) from private.retention_subjects()
     where table_name like 'integration\_%'$$,
  'integration_connections:swept:integration_connection_revoked,integration_sync_runs:swept:integration_sync_run');
select ig.val('IN3 both clock columns are classified `clock` and every integration candidate the walk derives is classified',
  $$select (select string_agg(table_name || '.' || column_name || ':' || role, ',' order by table_name)
              from private.retention_clock_columns() where table_name like 'integration\_%') || '/' ||
           (select count(*) from private.retention_clock_candidates() c
             where c.table_name like 'integration\_%'
               and not exists (select 1 from private.retention_clock_columns() d
                                where d.schema_name = c.schema_name and d.table_name = c.table_name
                                  and d.column_name = c.column_name))::text$$,
  'integration_connections.revoked_at:clock,integration_sync_runs.finished_at:clock/0');

insert into public.integration_sync_runs (id, organisation_id, connection_id, status, started_at, finished_at) values
  (gen_random_uuid(), :'org_a', :'conn_a', 'succeeded', now() - interval '92 days', now() - interval '91 days'),
  (gen_random_uuid(), :'org_a', :'conn_a', 'succeeded', now() - interval '90 days', now() - interval '89 days');
insert into public.integration_connections (id, organisation_id, provider, status, revoked_at) values
  (:'conn_old', :'org_a', 'google_calendar', 'revoked', now() - interval '2 years 1 day'),
  (:'conn_new', :'org_a', 'google_calendar', 'revoked', now() - interval '2 years' + interval '1 day');

-- Fix round 1 (C1): each planted revoked connection has a secret filed under
-- its name, so the sweep's Vault delete has something to delete (conn_old's)
-- and something it must leave (conn_new's, not yet expired).
select vault.create_secret('{"access_token":"tok_sweep_old"}', 'integration:' || :'conn_old') is not null as ig_planted_old \gset
select vault.create_secret('{"access_token":"tok_sweep_new"}', 'integration:' || :'conn_new') is not null as ig_planted_new \gset
create function ig.live_sweep_probe(p_org uuid, p_old uuid, p_new uuid)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v text; v_s jsonb; v_r jsonb;
begin
  begin
    select swept, refused into v_s, v_r from private.retention_sweep_body(false, 100000);
    v := (select count(*) from public.integration_sync_runs
           where organisation_id = p_org and finished_at < now() - interval '90 days')::text || '/' ||
         (select count(*) from public.integration_sync_runs
           where organisation_id = p_org and finished_at between now() - interval '90 days' and now() - interval '88 days')::text || '/' ||
         (select count(*) from public.integration_connections where id = p_old)::text || '/' ||
         (select count(*) from public.integration_connections where id = p_new)::text || '/' ||
         ((v_s ->> 'integration_sync_runs.rows')::int >= 1)::text || '/' ||
         ((v_s ->> 'integration_connections.rows')::int >= 1)::text || '/' ||
         (not (v_r ? 'integrations'))::text || '/' ||
         (select count(*) from vault.secrets s where s.name = 'integration:' || p_old::text)::text || '/' ||
         (select count(*) from vault.secrets s where s.name = 'integration:' || p_new::text)::text;
    raise exception 'ig_rollback' using detail = v;
  exception when others then
    if sqlerrm = 'ig_rollback' then
      get stacked diagnostics v = pg_exception_detail;
      return v;
    end if;
    return 'error(' || sqlstate || ':' || sqlerrm || ')';
  end;
end $$;
select ig.val('IN4 THE LIVE SWEEP: the run finished 91 days ago is swept, the one at 89 kept; the connection revoked 2y+1d ago is swept, the one at 2y-1d kept; the sweep reports both and refuses neither; the swept connection''s secret is deleted and the kept one''s is not',
  format($$select ig.live_sweep_probe(%L, %L, %L)$$, :'org_a', :'conn_old', :'conn_new'),
  '0/1/0/1/true/true/true/0/1');
select ig.val('IN5 ...and it was rolled back: both planted runs and both planted connections are still here',
  format($$select (select count(*) from public.integration_sync_runs
                    where organisation_id = %L and finished_at < now() - interval '88 days')::text || '/' ||
                  (select count(*) from public.integration_connections where id in (%L, %L))::text$$,
         :'org_a', :'conn_old', :'conn_new'),
  '2/2');

-- ===========================================================================
-- § IZ HOUSEKEEPING
-- ===========================================================================
delete from public.audit_events where correlation_id in (:'ie_job', :'ip_job');
set session_replication_role = replica;
delete from public.export_jobs where id in (:'ix_ws_job', :'ix_acc_job');
delete from public.organisation_memberships where organisation_id = :'org_p';
delete from public.organisation_subscriptions where organisation_id = :'org_p';
delete from public.organisations where id = :'org_p';
set session_replication_role = origin;
delete from vault.secrets where name in (select 'integration:' || x
                                          from unnest(array[:'conn_m3', :'conn_m3b', :'conn_m4', :'conn_e1', :'conn_p1', :'conn_p2', :'conn_p3']) x);
delete from vault.secrets where name in (select 'integration:' || id::text from public.integration_connections
                                          where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s'));
delete from public.integration_connections where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s');
set session_replication_role = replica;
delete from public.audit_events where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s')
   or actor_user_id in (:'owner_a', :'admin_a', :'mgr_a', :'ro_a', :'owner_b', :'owner_f', :'mgr2_a', :'owner_s',
                        :'mgr3_a', :'mgr4_a', :'er_a', :'owner_p', :'raw_a');
delete from public.organisation_memberships where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s');
delete from public.organisation_subscriptions where organisation_id in (:'org_a', :'org_b', :'org_f', :'org_s');
delete from public.organisations where id in (:'org_a', :'org_b', :'org_f', :'org_s');
set session_replication_role = origin;
delete from auth.users where id in (:'owner_a', :'admin_a', :'mgr_a', :'ro_a', :'owner_b', :'owner_f', :'mgr2_a', :'owner_s',
                                    :'mgr3_a', :'mgr4_a', :'er_a', :'owner_p', :'raw_a');
select ig.val('IZ1 housekeeping left no integration row and no integration secret behind',
  format($$select (select count(*) from public.integration_connections where organisation_id in (%L, %L, %L, %L))
                + (select count(*) from public.integration_sync_runs where organisation_id in (%L, %L, %L, %L))
                + (select count(*) from vault.secrets where name in ('integration:' || %L, 'integration:' || %L))$$,
         :'org_a', :'org_b', :'org_f', :'org_s', :'org_a', :'org_b', :'org_f', :'org_s', :'conn_v', :'conn_a'), '0');

\echo
\echo ==================== PHASE 9 INTEGRATIONS ====================
select seq, label, expected, actual, pass from ig.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from ig.results;

-- ===========================================================================
-- INVOICES, PART 3 OF 3 -- NETWORK DELIVERY (spec docs/superpowers/specs/2026-11-13-invoices-network-delivery-design.md).
--
-- Task 1 (20261117000000): DT table, grants, policy; DR who reads the base table;
--                          DB no client writes; DK the catalogues
-- Task 2 (20261117001000): DD deliver; DW withdraw; DS the page's state; DL the budget
-- Task 3 (20261117002000): DV the received view; DP the received PDF audit
-- Task 4 (20261117003000): DN the notice resolver and ledger
-- Later tasks add their sections ABOVE § DZ.
--
-- EVERY ASSERTION IS ONE LINE BEGINNING `select idl.val(`: run-rls-tests.sh's
-- pin is `grep -c '^select idl.val(' supabase/tests/rls_invoice_deliveries.sql`.
-- Re-runnable on one database: every fixture is a fresh uuid, § DZ removes them.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists idl cascade;
create schema idl;

create table idl.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function idl.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into idl.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- Runs p_sql and records its single text result, or `denied(<sqlstate>:<hint>)`
-- when it raises. A refusal is ALWAYS a recorded row, never a psql ERROR line
-- (psql exits 0 on ERROR; run_suite counts both, and ON_ERROR_STOP halts here).
create function idl.val(p_label text, p_sql text, p_expected text)
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
  perform idl.record(p_label, p_expected, v_actual);
end $$;

-- Runs p_sql in a subtransaction that is ALWAYS rolled back, and answers which
-- CHECK (or unique index) refused it (`violates <constraint>`, `unique <name>`),
-- or `written` when none did. The constraint NAME is the point: denied(23514)
-- cannot tell the shape CHECKs apart. Any other error reaches idl.val as
-- denied(...).
create function idl.violated(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_name text;
begin
  begin
    execute p_sql;
    raise exception 'undo the probe row' using errcode = 'IDLOK';
  exception
    when sqlstate 'IDLOK' then return 'written';
    when check_violation then
      get stacked diagnostics v_name = constraint_name;
      return 'violates ' || v_name;
    when unique_violation then
      get stacked diagnostics v_name = constraint_name;
      return 'unique ' || v_name;
  end;
end $$;

grant usage on schema idl to authenticated, service_role;
grant execute on function idl.record(text,text,text) to authenticated, service_role;
grant execute on function idl.val(text,text,text)    to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- FIXTURES (as postgres)
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as fin_s \gset
select gen_random_uuid()::text as ro_s  \gset
select gen_random_uuid()::text as own_s \gset
select gen_random_uuid()::text as fin_r \gset
select gen_random_uuid()::text as bk_r  \gset
select gen_random_uuid()::text as own_r \gset
select gen_random_uuid()::text as fin_t \gset
select gen_random_uuid()::text as fin_u \gset
select gen_random_uuid()::text as fin_x \gset
select gen_random_uuid()::text as org_s \gset
select gen_random_uuid()::text as org_r \gset
select gen_random_uuid()::text as org_t \gset
select gen_random_uuid()::text as org_u \gset
select gen_random_uuid()::text as org_x \gset
select gen_random_uuid()::text as prof_s  \gset
select gen_random_uuid()::text as prof_r  \gset
select gen_random_uuid()::text as prof_u  \gset
select gen_random_uuid()::text as prof_x  \gset
select gen_random_uuid()::text as prof_t  \gset
select gen_random_uuid()::text as prof_rd \gset
select gen_random_uuid()::text as com_s \gset
select gen_random_uuid()::text as com_x \gset
select gen_random_uuid()::text as con_s \gset
select gen_random_uuid()::text as inv_i \gset
select gen_random_uuid()::text as inv_p \gset
select gen_random_uuid()::text as inv_v \gset
select gen_random_uuid()::text as inv_d \gset
select gen_random_uuid()::text as inv_c \gset
select gen_random_uuid()::text as inv_x \gset
select gen_random_uuid()::text as del_sr \gset
select 'acct_IDL' || replace(gen_random_uuid()::text, '-', '') as acct_s \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_s') as fin_s_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'ro_s')  as ro_s_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_r') as fin_r_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'own_r') as own_r_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_t') as fin_t_c \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
  from (values (:'fin_s'::uuid, 'idl-fin-s-' || :'fin_s' || '@test.local'),
               (:'ro_s'::uuid,  'idl-ro-s-'  || :'ro_s'  || '@test.local'),
               (:'own_s'::uuid, 'idl-own-s-' || :'own_s' || '@test.local'),
               (:'fin_r'::uuid, 'idl-fin-r-' || :'fin_r' || '@test.local'),
               (:'bk_r'::uuid,  'idl-bk-r-'  || :'bk_r'  || '@test.local'),
               (:'own_r'::uuid, 'idl-own-r-' || :'own_r' || '@test.local'),
               (:'fin_t'::uuid, 'idl-fin-t-' || :'fin_t' || '@test.local'),
               (:'fin_u'::uuid, 'idl-fin-u-' || :'fin_u' || '@test.local'),
               (:'fin_x'::uuid, 'idl-fin-x-' || :'fin_x' || '@test.local')) v(u, e);

insert into public.organisations (id, name, slug) values
  (:'org_s', 'IDL Sender',   'idl-sender-'   || left(:'org_s', 8)),
  (:'org_r', 'IDL Receiver', 'idl-receiver-' || left(:'org_r', 8)),
  (:'org_t', 'IDL Third',    'idl-third-'    || left(:'org_t', 8)),
  (:'org_u', 'IDL Unconnected', 'idl-unconn-' || left(:'org_u', 8)),
  (:'org_x', 'IDL Starter Sender', 'idl-starter-' || left(:'org_x', 8));
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
select o, p, 'monthly', 4, 'active', now() + interval '30 days'
  from (values (:'org_s'::uuid, 'pro'), (:'org_r'::uuid, 'starter'), (:'org_t'::uuid, 'pro'),
               (:'org_u'::uuid, 'pro'), (:'org_x'::uuid, 'starter')) v(o, p)
on conflict (organisation_id) do update set plan_id = excluded.plan_id, status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_s', :'fin_s', 'finance',   'active', now()),
  (:'org_s', :'ro_s',  'read_only', 'active', now()),
  (:'org_s', :'own_s', 'owner',     'active', now()),
  (:'org_r', :'fin_r', 'finance',   'active', now()),
  (:'org_r', :'bk_r',  'booker',    'active', now()),
  (:'org_r', :'own_r', 'owner',     'active', now()),
  (:'org_t', :'fin_t', 'finance',   'active', now()),
  (:'org_u', :'fin_u', 'finance',   'active', now()),
  (:'org_x', :'fin_x', 'finance',   'active', now());

-- One published profile per workspace, plus a DRAFT one in R. entity_id is a
-- fresh uuid: the profile's own entity row is not what these suites read.
insert into public.network_profiles (id, organisation_id, entity_kind, entity_id, status, display_name, published_at) values
  (:'prof_s',  :'org_s', 'company', gen_random_uuid(), 'published', 'IDL S', now()),
  (:'prof_r',  :'org_r', 'company', gen_random_uuid(), 'published', 'IDL R', now()),
  (:'prof_u',  :'org_u', 'company', gen_random_uuid(), 'published', 'IDL U', now()),
  (:'prof_x',  :'org_x', 'company', gen_random_uuid(), 'published', 'IDL X', now()),
  (:'prof_t',  :'org_t', 'company', gen_random_uuid(), 'published', 'IDL T', now());
insert into public.network_profiles (id, organisation_id, entity_kind, entity_id, status, display_name) values
  (:'prof_rd', :'org_r', 'company', gen_random_uuid(), 'draft', 'IDL R draft');

insert into public.companies (id, organisation_id, name) values
  (:'com_s', :'org_s', 'IDL Sender Customer Ltd'), (:'com_x', :'org_x', 'IDL Starter Customer Ltd');
insert into public.contacts (id, organisation_id, name) values (:'con_s', :'org_s', 'IDL Customer Person');

-- S links its company to R's published profile, to U's (linked, NOT connected)
-- and to R's draft; X links its company to R's published profile.
insert into public.network_links (organisation_id, network_profile_id, private_entity_type, private_entity_id) values
  (:'org_s', :'prof_r',  'company', :'com_s'),
  (:'org_s', :'prof_u',  'company', :'com_s'),
  (:'org_s', :'prof_rd', 'company', :'com_s'),
  (:'org_x', :'prof_r',  'company', :'com_x');
-- Accepted requests: S->R (from S) and X<->R (from R).
insert into public.network_connection_requests
  (from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id, status, responded_at) values
  (:'org_s', :'prof_s', :'org_r', :'prof_r', 'accepted', now()),
  (:'org_r', :'prof_r', :'org_x', :'prof_x', 'accepted', now());

insert into public.invoice_settings (organisation_id, business_name, business_address) values
  (:'org_s', 'IDL Sender Ltd',  '1 Sender Street, London'),
  (:'org_x', 'IDL Starter Ltd', '2 Starter Road, Leeds');

-- Drafts first, then their lines; the issued ones are flipped AFTER their
-- lines exist (the line freeze refuses a line on an issued invoice). Each is
-- gross 12000 (net 10000 + 20% VAT 2000). inv_d stays a draft.
insert into public.invoices (id, organisation_id, recipient_company_id, recipient_contact_id, recipient_address, created_by) values
  (:'inv_i', :'org_s', :'com_s', null,     '8 Customer Road, London', :'fin_s'),
  (:'inv_p', :'org_s', :'com_s', null,     '8 Customer Road, London', :'fin_s'),
  (:'inv_v', :'org_s', :'com_s', null,     '8 Customer Road, London', :'fin_s'),
  (:'inv_d', :'org_s', :'com_s', null,     '8 Customer Road, London', :'fin_s'),
  (:'inv_c', :'org_s', null,     :'con_s', '9 Person Road, London',   :'fin_s'),
  (:'inv_x', :'org_x', :'com_x', null,     '7 Buyer Street, Leeds',   :'fin_x');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity,
                                  unit_price_minor, vat_rate, net_minor, vat_minor)
select i.organisation_id, i.id, 1, 'Fee', 1.00, 10000, 'standard_20', 10000, 2000
  from public.invoices i where i.id in (:'inv_i', :'inv_p', :'inv_v', :'inv_d', :'inv_c', :'inv_x');
update public.invoices set net_minor = 10000, vat_minor = 2000, gross_minor = 12000
 where id in (:'inv_i', :'inv_p', :'inv_v', :'inv_d', :'inv_c', :'inv_x');
update public.invoices i
   set status = 'issued', number = v.n, issue_date = current_date, supply_date = current_date,
       due_date = current_date + 30,
       snapshot = private.build_invoice_snapshot(i.id, v.n, current_date, current_date, current_date + 30)
  from (values (:'inv_i'::uuid, 'IDL-0001'), (:'inv_p'::uuid, 'IDL-0002'),
               (:'inv_v'::uuid, 'IDL-0003'), (:'inv_c'::uuid, 'IDL-0004'),
               (:'inv_x'::uuid, 'IDL-0001')) v(id, n)
 where i.id = v.id;
update public.invoices set status = 'paid', paid_on = current_date, paid_by = :'fin_s', paid_via = 'manual' where id = :'inv_p';
update public.invoices set status = 'void', voided_at = now(), voided_by = :'fin_s', void_reason = 'Wrong amount' where id = :'inv_v';

-- S's live Stripe account, so Task 3's § DV can see card_payment_enabled.
insert into public.invoice_stripe_accounts (organisation_id, stripe_account_id, charges_enabled, linked_by)
values (:'org_s', :'acct_s', true, :'fin_s');


-- ===========================================================================
-- § DT THE TABLE, ITS GRANTS AND ITS POLICY (as postgres)
-- ===========================================================================
select idl.val('DT1 the table exists and RLS is enabled', $$select relrowsecurity::text from pg_class where oid = 'public.invoice_deliveries'::regclass$$, 'true');
select idl.val('DT2 authenticated holds SELECT and nothing else on it', $$select coalesce((select string_agg(p, '/' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where case when p in ('INSERT','UPDATE','REFERENCES') then has_any_column_privilege('authenticated', 'public.invoice_deliveries', p) else has_table_privilege('authenticated', 'public.invoice_deliveries', p) end), 'none')$$, 'SELECT');
select idl.val('DT3 anon and service_role hold NOTHING on it, table- or column-level', $$select (count(*) filter (where has_table_privilege(r, 'public.invoice_deliveries', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))::text || '/' || (select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name = 'invoice_deliveries' and grantee in ('anon', 'PUBLIC', 'service_role'))::text from unnest(array['anon','service_role']) r$$, '0/0');
select idl.val('DT4 exactly one policy, a SELECT', $$select string_agg(c.relname || '=' || p.polcmd::text, ',' order by c.relname) from pg_policy p join pg_class c on c.oid = p.polrelid where c.oid = 'public.invoice_deliveries'::regclass$$, 'invoice_deliveries=r');
select idl.val('DT5 every FK column leads an index', $$select string_agg(a.attname, ',' order by a.attname) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] where c.conrelid = 'public.invoice_deliveries'::regclass and c.contype = 'f' and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])$$, '<null>');
select idl.val('DT6 a workspace cannot deliver to itself', format($$select idl.violated(%L)$$, format('insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id) values (%L, %L, %L)', :'inv_i', :'org_s', :'org_s')), 'violates invoice_deliveries_not_to_self');
select idl.val('DT7 POSITIVE CONTROL: the same delivery to another workspace is written (and rolled back)', format($$select idl.violated(%L)$$, format('insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id) values (%L, %L, %L)', :'inv_i', :'org_s', :'org_r')), 'written');
select idl.val('DT8 a second LIVE delivery of one invoice to one workspace is refused by the partial unique index', format($$select idl.violated(%L)$$, format('insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id) values (%1$L, %2$L, %3$L), (%1$L, %2$L, %3$L)', :'inv_i', :'org_s', :'org_r')), 'unique invoice_deliveries_live_unique');
select idl.val('DT9 POSITIVE CONTROL: a second delivery beside a WITHDRAWN one is written (and rolled back)', format($$select idl.violated(%L)$$, format('insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id, withdrawn_at) values (%1$L, %2$L, %3$L, now()), (%1$L, %2$L, %3$L, null)', :'inv_i', :'org_s', :'org_r')), 'written');

-- ===========================================================================
-- § DR WHO READS THE BASE TABLE. One delivery, S -> R. Only S's view_finance
-- holders read it; THE RECEIVER NEVER DOES (it reads public.received_invoices).
-- ===========================================================================
insert into public.invoice_deliveries (id, invoice_id, from_organisation_id, to_organisation_id, delivered_by)
values (:'del_sr', :'inv_i', :'org_s', :'org_r', :'fin_s');
select format($$select count(*)::text from public.invoice_deliveries where id = %L$$, :'del_sr') as vis \gset
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DR1 the sender''s Finance user reads its delivery', :'vis', '1');
set request.jwt.claims = :'ro_s_c';
select idl.val('DR2 the sender''s Read Only user (no view_finance) reads nothing', :'vis', '0');
set request.jwt.claims = :'fin_r_c';
select idl.val('DR3 THE RECEIVER''S Finance user reads NO row of the base table', :'vis', '0');
set request.jwt.claims = :'fin_t_c';
select idl.val('DR4 BREAKOUT: a third workspace''s Finance user reads nothing', :'vis', '0');
set request.jwt.claims = :'own_r_c';
select idl.val('DR5 the receiver''s Owner reads nothing either (no role in the receiver reads the base table)', :'vis', '0');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § DB BREAKOUT: the sender's Finance user (aal2, the strongest sender there
-- is) forges a write. Only public.deliver_invoice / withdraw_invoice_delivery
-- (Task 2) write the table.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DB1 a forged INSERT is refused by privilege', format($$insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id) values (%L, %L, %L) returning 'written'$$, :'inv_p', :'org_s', :'org_r'), 'denied(42501:missing_grant)');
select idl.val('DB2 a forged UPDATE (a withdrawal) is refused by privilege', format($$update public.invoice_deliveries set withdrawn_at = now() where id = %L returning 'written'$$, :'del_sr'), 'denied(42501:missing_grant)');
select idl.val('DB3 a forged DELETE is refused by privilege', format($$delete from public.invoice_deliveries where id = %L returning 'written'$$, :'del_sr'), 'denied(42501:missing_grant)');
reset role;
reset request.jwt.claims;
select idl.val('DB4 POSITIVE CONTROL: the same UPDATE as postgres (the owner) writes the row', format($$with u as (update public.invoice_deliveries set withdrawn_at = now() where id = %L returning 1) select count(*)::text from u$$, :'del_sr'), '1');
-- Task 2's first delivery of inv_i to R must be a real one, not the idempotent repeat.
delete from public.invoice_deliveries where id = :'del_sr';

-- ===========================================================================
-- § DK THE CATALOGUES the table, its budget and its actions joined
-- ===========================================================================
select idl.val('DK1 every public table is still classified for retention', $$select string_agg(x, ',') from private.unclassified_retention_subjects() x$$, '<null>');
select idl.val('DK2 invoice_deliveries is retention-classified as cascading from its invoice', $$select treatment from private.retention_subjects() where table_name = 'invoice_deliveries'$$, 'cascades');
select idl.val('DK3 the three audit actions are in the catalogue', $$select count(*)::text from private.platform_audit_actions() a where a in ('invoice.delivered','invoice.delivery_withdrawn','invoice.received_pdf_downloaded')$$, '3');
select idl.val('DK4 the export catalogue exports it in the sender''s workspace export and excuses the account export', $$select string_agg(export_kind || ':' || disposition || ':' || coalesce(array_to_string(scope_columns, '/'), '-'), ',' order by export_kind) from private.export_catalogue() where table_name = 'invoice_deliveries'$$, 'account:excused:-,workspace:exported:from_organisation_id');
select idl.val('DK5 the export catalogue is sound', $$select private.export_catalogue_is_sound()$$, 'sound');
select idl.val('DK6 the delivery budget is 30 per hour per user', $$select max_requests || '/' || window_seconds || '/' || subject_scope from public.rate_limit_policies where category = 'invoice_delivery'$$, '30/3600/user');
select idl.val('DK7 the meter trigger is the table''s only trigger', $$select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.invoice_deliveries'::regclass and not tgisinternal$$, 'meter_invoice_delivery');

-- ===========================================================================
-- § DZ HOUSEKEEPING (later tasks insert their sections ABOVE this line)
-- ===========================================================================
reset role;
reset request.jwt.claims;
-- ORIGIN mode, so the organisation delete cascades to every fixture row
-- (deliveries, requests, links, profiles, lines, invoices: the freeze triggers
-- admit a cascade). Ledger stamps first: the org delete sets
-- audit_events.organisation_id to null, and the replica-mode audit delete
-- below fires no cascade.
delete from private.notification_deliveries where audit_event_id in (select id from public.audit_events where organisation_id in (:'org_s', :'org_r', :'org_t', :'org_u', :'org_x'));
delete from public.organisations where id in (:'org_s', :'org_r', :'org_t', :'org_u', :'org_x');
set session_replication_role = replica;
delete from public.audit_events
 where organisation_id in (:'org_s', :'org_r', :'org_t', :'org_u', :'org_x')
    or actor_user_id in (:'fin_s', :'ro_s', :'own_s', :'fin_r', :'bk_r', :'own_r', :'fin_t', :'fin_u', :'fin_x');
set session_replication_role = origin;
delete from auth.users where id in (:'fin_s', :'ro_s', :'own_s', :'fin_r', :'bk_r', :'own_r', :'fin_t', :'fin_u', :'fin_x');
select idl.val('DZ1 housekeeping left no row behind in any table the suite wrote', format($$select ((select count(*) from public.invoices where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.invoice_deliveries where from_organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L) or to_organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.network_profiles where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.network_connection_requests where from_organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.invoice_stripe_accounts where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from auth.users where id in (%6$L, %7$L, %8$L)))::text$$, :'org_s', :'org_r', :'org_t', :'org_u', :'org_x', :'fin_s', :'fin_r', :'fin_x'), '0');

\echo
\echo ==================== INVOICE DELIVERIES ====================
select seq, label, expected, actual, pass from idl.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from idl.results;

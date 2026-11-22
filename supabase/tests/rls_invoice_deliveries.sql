-- ===========================================================================
-- INVOICES, PART 3 OF 3 -- NETWORK DELIVERY (spec docs/superpowers/specs/2026-11-13-invoices-network-delivery-design.md).
--
-- Task 1 (20261119000000): DT table, grants, policy; DR who reads the base table;
--                          DB no client writes; DK the catalogues
-- Task 2 (20261119001000): DD deliver; DW withdraw; DS the page's state; DL the budget
-- Task 3 (20261119002000): DV the received view; DP the received PDF audit
-- Task 4 (20261119003000): DN the notice resolver and ledger
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
-- Runs p_sql and answers its single text result, or `denied(<sqlstate>:<hint>)`
-- when it raises. idl.val records it; § DL calls it from inside a format().
create function idl.try_text(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
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
  return v_actual;
end $$;

create function idl.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
begin
  perform idl.record(p_label, p_expected, idl.try_text(p_sql));
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
grant execute on function idl.try_text(text)         to authenticated, service_role;

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
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_x') as fin_x_c \gset
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
select idl.val('DT5 every FK column leads an index', $$select string_agg(a.attname, ',' order by a.attname) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] where c.conrelid = 'public.invoice_deliveries'::regclass and c.contype = 'f' and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1] and i.indpred is null)$$, '<null>');
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
-- § DD DELIVER. Rule 1 (manage_finance) is the RPC's; rules 2-6 are
-- private.invoice_delivery_target's. EVERY refusal is one error:
-- 42501 / invoice_delivery_refused. Each refusal below is paired with a
-- positive control on the same inputs (DD1, DD7c, DD11, DD14c, DD17c).
-- ===========================================================================
select format($$select (public.deliver_invoice(%L, %L) is not null)::text$$, :'inv_i', :'prof_r') as call_ir \gset
select format($$select (public.deliver_invoice(%L, %L) is not null)::text$$, :'inv_p', :'prof_r') as call_pr \gset
select format($$select (public.deliver_invoice(%L, %L) is not null)::text$$, :'inv_x', :'prof_r') as call_xr \gset
select format($$select (public.deliver_invoice(%L, %L) is not null)::text$$, :'inv_d', :'prof_r') as call_dr \gset
select format($$select (public.deliver_invoice(%L, %L) is not null)::text$$, :'inv_v', :'prof_r') as call_vr \gset
select format($$select (public.deliver_invoice(%L, %L) is not null)::text$$, :'inv_c', :'prof_r') as call_cr \gset
select format($$select (public.deliver_invoice(%L, %L) is not null)::text$$, :'inv_i', :'prof_t') as call_it \gset
select format($$select (public.deliver_invoice(%L, %L) is not null)::text$$, :'inv_p', :'prof_rd') as call_prd \gset
select format($$select (public.deliver_invoice(%L, %L) is not null)::text$$, :'inv_p', :'prof_u') as call_pu \gset

select idl.val('DD0 who may EXECUTE the three RPCs, and all are definers with an empty search_path (! marks one that is not)', $$select string_agg(p.proname || '=' || coalesce((select string_agg(r, '/' order by r) from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r, p.oid, 'EXECUTE')), '-') || (case when p.prosecdef and p.proconfig = array['search_path=""'] then '' else '!' end), ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('deliver_invoice','withdraw_invoice_delivery','invoice_delivery_state')$$, 'deliver_invoice=authenticated,invoice_delivery_state=authenticated,withdraw_invoice_delivery=authenticated');
select idl.val('DD0b the eligibility predicate is executable by none of the three roles', $$select count(*)::text from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r, 'private.invoice_delivery_target(uuid,uuid)', 'EXECUTE')$$, '0');

set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD1 POSITIVE: the sender''s Finance user delivers its issued invoice to the connected receiver''s profile', :'call_ir', 'true');
reset role;
reset request.jwt.claims;
select id as del_ir from public.invoice_deliveries where invoice_id = :'inv_i' and withdrawn_at is null \gset
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD2 the repeat is a no-op returning the same delivery id', format($$select (public.deliver_invoice(%L, %L) = %L)::text$$, :'inv_i', :'prof_r', :'del_ir'), 'true');
reset role;
reset request.jwt.claims;
select idl.val('DD3 still one live row and one invoice.delivered audit row for it', format($$select (select count(*) from public.invoice_deliveries where invoice_id = %1$L and withdrawn_at is null)::text || '/' || (select count(*) from public.audit_events where action = 'invoice.delivered' and target_id = %2$L)::text$$, :'inv_i', :'del_ir'), '1/1');
select idl.val('DD4 the audit row is name-only: the invoice number and nothing else', format($$select after::text from public.audit_events where action = 'invoice.delivered' and target_id = %L$$, :'del_ir'), '{"number": "IDL-0001"}');

-- Rule 1: manage_finance in the invoice's workspace.
set role authenticated;
set request.jwt.claims = :'ro_s_c';
select idl.val('DD5 a Read Only user in the sender is refused', :'call_pr', 'denied(42501:invoice_delivery_refused)');
set request.jwt.claims = :'fin_t_c';
select idl.val('DD6 BREAKOUT: another workspace''s Finance user is refused', :'call_pr', 'denied(42501:invoice_delivery_refused)');
-- Rule 2: the invoice's workspace is Pro.
set request.jwt.claims = :'fin_x_c';
select idl.val('DD7 a Starter sender (otherwise eligible) is refused', :'call_xr', 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
update public.organisation_subscriptions set plan_id = 'pro' where organisation_id = :'org_x';
set role authenticated;
set request.jwt.claims = :'fin_x_c';
select idl.val('DD7c CONTROL: the same call once the sender is Pro delivers', :'call_xr', 'true');
reset role;
reset request.jwt.claims;
update public.organisation_subscriptions set plan_id = 'starter' where organisation_id = :'org_x';
-- Rule 2: ... and not read-only.
update public.organisations set deleted_at = now() where id = :'org_s';
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD8 a read-only (suspended) sender is refused', :'call_pr', 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
update public.organisations set deleted_at = null where id = :'org_s';
-- Rule 3: issued or paid.
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD9 a draft invoice is refused', :'call_dr', 'denied(42501:invoice_delivery_refused)');
select idl.val('DD10 a void invoice is refused', :'call_vr', 'denied(42501:invoice_delivery_refused)');
select idl.val('DD11 CONTROL: a paid invoice is delivered', :'call_pr', 'true');
-- Rule 4: to a company, with the caller's own live manual link.
select idl.val('DD12 an invoice to a contact is refused', :'call_cr', 'denied(42501:invoice_delivery_refused)');
select idl.val('DD13 a published profile in a workspace the sender has NO link to is refused', :'call_it', 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
delete from public.invoice_deliveries where invoice_id = :'inv_p';
update public.network_links set deleted_at = now() where organisation_id = :'org_s' and network_profile_id = :'prof_r';
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD14 a soft-deleted link is refused', :'call_pr', 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
update public.network_links set deleted_at = null where organisation_id = :'org_s' and network_profile_id = :'prof_r';
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD14c CONTROL: the same call with the link restored delivers', :'call_pr', 'true');
reset role;
reset request.jwt.claims;
delete from public.invoice_deliveries where invoice_id = :'inv_p';
-- Rule 5: a published, live profile in a workspace that is not read-only.
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD15 a DRAFT profile (linked, in a connected workspace) is refused', :'call_prd', 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
update public.organisations set deleted_at = now() where id = :'org_r';
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD16 a read-only receiver is refused', :'call_pr', 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
update public.organisations set deleted_at = null where id = :'org_r';
-- Rule 6: an ACCEPTED connection, either way round.
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD17 a linked, live profile in a workspace with NO connection is refused', :'call_pu', 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
insert into public.network_connection_requests (from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id, status, responded_at)
values (:'org_s', :'prof_s', :'org_u', :'prof_u', 'accepted', now());
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD17c CONTROL: the same call once the connection is accepted delivers', :'call_pu', 'true');
reset role;
reset request.jwt.claims;
delete from public.invoice_deliveries where invoice_id = :'inv_p';
delete from public.network_connection_requests where from_organisation_id = :'org_s' and to_organisation_id = :'org_u';
insert into public.network_connection_requests (from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id, status)
values (:'org_s', :'prof_s', :'org_u', :'prof_u', 'pending');
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DD18 a connection request that is only PENDING does not count', :'call_pu', 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
delete from public.network_connection_requests where from_organisation_id = :'org_s' and to_organisation_id = :'org_u';
set role authenticated;
select idl.val('DD19 no session: refused as not authenticated', :'call_ir', 'denied(28000:not_authenticated)');
reset role;

-- ===========================================================================
-- § DW WITHDRAW. Live now: inv_i S->R (del_ir) and inv_x X->R (from DD7c).
-- ===========================================================================
insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id, delivered_by) values (:'inv_p', :'org_s', :'org_r', :'fin_s');
select id as del_w1 from public.invoice_deliveries where invoice_id = :'inv_p' and withdrawn_at is null \gset
set role authenticated;
set request.jwt.claims = :'ro_s_c';
select idl.val('DW1 a Read Only user in the sender cannot withdraw (its own live delivery of inv_p, so only the permission can refuse it)', format($$select 'ok' from (select public.withdraw_invoice_delivery(%L)) s$$, :'del_w1'), 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
delete from public.invoice_deliveries where invoice_id = :'inv_p';
insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id, delivered_by) values (:'inv_p', :'org_s', :'org_r', :'fin_s');
select id as del_w2 from public.invoice_deliveries where invoice_id = :'inv_p' and withdrawn_at is null \gset
set role authenticated;
set request.jwt.claims = :'fin_r_c';
select idl.val('DW2 THE RECEIVER''S Finance user cannot withdraw the sender''s delivery (its own live delivery of inv_p, so only the permission can refuse it)', format($$select 'ok' from (select public.withdraw_invoice_delivery(%L)) s$$, :'del_w2'), 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
delete from public.invoice_deliveries where invoice_id = :'inv_p';
insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id, delivered_by) values (:'inv_p', :'org_s', :'org_r', :'fin_s');
select id as del_w3 from public.invoice_deliveries where invoice_id = :'inv_p' and withdrawn_at is null \gset
set role authenticated;
set request.jwt.claims = :'fin_t_c';
select idl.val('DW3 BREAKOUT: a third workspace''s Finance user cannot withdraw it (its own live delivery of inv_p, so only the permission can refuse it)', format($$select 'ok' from (select public.withdraw_invoice_delivery(%L)) s$$, :'del_w3'), 'denied(42501:invoice_delivery_refused)');
reset role;
reset request.jwt.claims;
delete from public.invoice_deliveries where invoice_id = :'inv_p';
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DW4 POSITIVE: the sender''s Finance user withdraws it', format($$select 'ok' from (select public.withdraw_invoice_delivery(%L)) s$$, :'del_ir'), 'ok');
reset role;
reset request.jwt.claims;
select idl.val('DW5 the row is stamped withdrawn by fin_s, with one invoice.delivery_withdrawn audit row', format($$select (select (withdrawn_at is not null)::text || '/' || (withdrawn_by = %2$L)::text from public.invoice_deliveries where id = %1$L) || '/' || (select count(*) from public.audit_events where action = 'invoice.delivery_withdrawn' and target_id = %1$L)::text$$, :'del_ir', :'fin_s'), 'true/true/1');
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DW6 withdrawing again is refused (no live row)', format($$select 'ok' from (select public.withdraw_invoice_delivery(%L)) s$$, :'del_ir'), 'denied(42501:invoice_delivery_refused)');
select idl.val('DW7 the invoice can be delivered again', :'call_ir', 'true');
reset role;
reset request.jwt.claims;
select id as del_ir2 from public.invoice_deliveries where invoice_id = :'inv_i' and withdrawn_at is null \gset
select idl.val('DW8 ...as a NEW delivery', format($$select (%L::uuid <> %L::uuid)::text$$, :'del_ir2', :'del_ir'), 'true');
select id as del_xr from public.invoice_deliveries where invoice_id = :'inv_x' and withdrawn_at is null \gset
set role authenticated;
set request.jwt.claims = :'fin_x_c';
select idl.val('DW9 a STARTER sender can still withdraw (no tier gate)', format($$select 'ok' from (select public.withdraw_invoice_delivery(%L)) s$$, :'del_xr'), 'ok');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § DS THE SENDER PAGE'S STATE READ. inv_i has one live delivery to R (del_ir2).
-- ===========================================================================
delete from public.invoice_deliveries where invoice_id = :'inv_p';
select $$select string_agg(coalesce(display_name,'-') || ':' || (delivery_id is not null) || ':' || can_deliver, ',' order by display_name) from public.invoice_delivery_state(%L)$$ as ds_sql \gset
select format(:'ds_sql', :'inv_i') as ds_i \gset
select format(:'ds_sql', :'inv_p') as ds_p \gset
select format(:'ds_sql', :'inv_c') as ds_c \gset
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DS1 a live delivery shows named; the unconnected (U) and draft profiles are absent', :'ds_i', 'IDL R:true:false');
select idl.val('DS2 an invoice with no live delivery offers the connected profile', :'ds_p', 'IDL R:false:true');
select idl.val('DS3 an invoice to a contact has no rows', :'ds_c', '<null>');
set request.jwt.claims = :'fin_t_c';
select idl.val('DS4 BREAKOUT: another workspace''s Finance user gets no rows, not an error', :'ds_i', '<null>');
set request.jwt.claims = :'ro_s_c';
select idl.val('DS5 a Read Only user gets what view_finance gives it: nothing (DR2)', :'ds_i', '<null>');
reset role;
reset request.jwt.claims;
update public.network_links set deleted_at = now() where organisation_id = :'org_s' and network_profile_id = :'prof_r';
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DS6 a live delivery whose link was removed afterwards still shows, without a name', :'ds_i', '-:true:false');
reset role;
reset request.jwt.claims;
update public.network_links set deleted_at = null where organisation_id = :'org_s' and network_profile_id = :'prof_r';

-- ===========================================================================
-- § DL THE BUDGET: 30 spent in this hour, so the 31st is refused at the insert.
-- ===========================================================================
insert into public.rate_limit_counters (category, subject_scope, subject_id, window_start, request_count)
values ('invoice_delivery', 'user', :'fin_s', private.rate_limit_window_start(now(), 3600), 30)
on conflict (category, subject_scope, subject_id, window_start) do update set request_count = 30;
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DL1 the 31st delivery in the hour is refused with 429', format($$select (x like 'denied(PT429:%%')::text from (select idl.try_text(format('select public.deliver_invoice(%%L, %%L)::text', %L, %L)) x) s$$, :'inv_p', :'prof_r'), 'true');
reset role;
reset request.jwt.claims;
delete from public.rate_limit_counters where category = 'invoice_delivery' and subject_scope = 'user' and subject_id = :'fin_s';
set role authenticated;
set request.jwt.claims = :'fin_s_c';
select idl.val('DL2 CONTROL: with the counter gone the same delivery is accepted', :'call_pr', 'true');
reset role;
reset request.jwt.claims;
delete from public.rate_limit_counters where category = 'invoice_delivery' and subject_id in (:'fin_s', :'fin_x');

-- ===========================================================================
-- § DV THE RECEIVER'S VIEW. public.received_invoices is a definer view, the
-- ONLY read path into another workspace's invoice. Its column list and its
-- dependencies are pinned (DV2-DV4); its WHERE is the row gate (DV6-DV11).
-- Live now: inv_i S->R (del_ir2). inv_v (void) is planted S->R here so the
-- void case is visible.
-- ===========================================================================
select id as del_ir2 from public.invoice_deliveries where invoice_id = :'inv_i' and withdrawn_at is null \gset
select count(*)::text as live_inv_i from public.invoice_deliveries where invoice_id = :'inv_i' and withdrawn_at is null \gset
select idl.val('DV0 FIXTURE: inv_i has exactly one live delivery and inv_v none before the view is read', format($$select %L || '/' || (select count(*) from public.invoice_deliveries where invoice_id = %L and withdrawn_at is null)::text$$, :'live_inv_i', :'inv_v'), '1/0');
insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id, delivered_by) values (:'inv_v', :'org_s', :'org_r', :'fin_s');
select id as del_vr from public.invoice_deliveries where invoice_id = :'inv_v' and withdrawn_at is null \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'bk_r') as bk_r_c \gset

-- The pg_depend walk of rls_phase6_network.sql's nw.view_deps / nw.view_fn_deps,
-- restricted to public views (copied, not referenced).
create view idl.view_deps as
  select v.relname as viewname,
         coalesce(string_agg(distinct tn.nspname || '.' || t.relname, ','
                             order by tn.nspname || '.' || t.relname), '<none>') as tables,
         count(distinct tn.nspname || '.' || t.relname)::text as n
    from pg_catalog.pg_class v
    join pg_catalog.pg_rewrite rw on rw.ev_class = v.oid
    join pg_catalog.pg_depend d
      on d.objid = rw.oid and d.classid = 'pg_catalog.pg_rewrite'::regclass
    join pg_catalog.pg_class t on t.oid = d.refobjid
    join pg_catalog.pg_namespace tn on tn.oid = t.relnamespace
   where v.relnamespace = 'public'::regnamespace and v.relkind = 'v' and t.oid <> v.oid
   group by v.relname;
create view idl.view_fn_deps as
  select v.relname as viewname,
         coalesce(string_agg(distinct pn.nspname || '.' || p.proname, ','
                             order by pn.nspname || '.' || p.proname), '<none>') as fns
    from pg_catalog.pg_class v
    join pg_catalog.pg_rewrite rw on rw.ev_class = v.oid
    join pg_catalog.pg_depend d
      on d.objid = rw.oid and d.classid = 'pg_catalog.pg_rewrite'::regclass
     and d.refclassid = 'pg_catalog.pg_proc'::regclass
    join pg_catalog.pg_proc p on p.oid = d.refobjid
    join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
   where v.relnamespace = 'public'::regnamespace and v.relkind = 'v'
   group by v.relname;
grant select on idl.view_deps, idl.view_fn_deps to authenticated, service_role;

-- A row in every sender table DV16 says the receiver cannot read, so each
-- refusal there can fail (the sender's control DV16c reads them all as >= 1).
insert into public.invoice_sends (organisation_id, invoice_id, to_email, sent_by)
values (:'org_s', :'inv_i', 'customer@example.test', :'fin_s');
insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id, amount_minor, currency, outcome)
values (:'org_s', :'inv_i', 'evt_idl1', 'pi_idl1' || replace(:'inv_i', '-', ''), 12000, 'GBP', 'applied');

select idl.val('DV1 it is a view: security_invoker off, security_barrier on', $$select (relkind = 'v')::text || '/' || (coalesce(reloptions::text,'') like '%security_barrier=true%')::text || '/' || (coalesce(reloptions::text,'') like '%security_invoker=true%')::text from pg_class where oid = 'public.received_invoices'::regclass$$, 'true/true/false');
select idl.val('DV2 THE COLUMN LIST IS PINNED (no event_id, recipient ids, paid_entry_id, void_reason, actor or Stripe columns)', $$select string_agg(attname, ',' order by attnum) from pg_attribute where attrelid = 'public.received_invoices'::regclass and attnum > 0$$, 'id,organisation_id,delivered_at,invoice_id,sender_name,number,status,issue_date,due_date,currency,net_minor,vat_minor,gross_minor,paid_on,snapshot,card_payment_enabled');
select idl.val('DV3 THE RELATION DEPENDENCIES ARE PINNED', $$select tables || ' (' || n || ')' from idl.view_deps where viewname = 'received_invoices'$$, 'public.invoice_deliveries,public.invoice_stripe_accounts,public.invoices (3)');
select idl.val('DV4 THE FUNCTION DEPENDENCIES ARE PINNED', $$select fns from idl.view_fn_deps where viewname = 'received_invoices'$$, 'private.permitted_organisations,private.request_is_from_server');
select idl.val('DV5 authenticated holds SELECT and nothing else; anon and service_role nothing', $$select coalesce((select string_agg(p, '/' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where case when p in ('INSERT','UPDATE','REFERENCES') then has_any_column_privilege('authenticated', 'public.received_invoices', p) else has_table_privilege('authenticated', 'public.received_invoices', p) end), 'none') || '/' || (select (count(*) filter (where has_table_privilege(r, 'public.received_invoices', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))::text || '/' || (select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name = 'received_invoices' and grantee in ('anon', 'PUBLIC', 'service_role'))::text from unnest(array['anon','service_role']) r)$$, 'SELECT/0/0');

select format($$select count(*) filter (where id = %L) || '/' || count(*) filter (where id = %L) from public.received_invoices$$, :'del_ir2', :'del_vr') as rcv \gset
set role authenticated;
set request.jwt.claims = :'fin_r_c';
select idl.val('DV6 CONTROL: the receiver''s Finance user (a Starter workspace) reads both deliveries', :'rcv', '1/1');
set request.jwt.claims = :'own_r_c';
select idl.val('DV7 the receiver''s Owner reads both', :'rcv', '1/1');
set request.jwt.claims = :'bk_r_c';
select idl.val('DV8 the receiver''s Booker (no view_finance) reads neither', :'rcv', '0/0');
set request.jwt.claims = :'fin_t_c';
select idl.val('DV9 BREAKOUT: a third workspace''s Finance user reads neither', :'rcv', '0/0');
set request.jwt.claims = :'fin_s_c';
select idl.val('DV10 the sender reads neither: it reads its own base table, not the inbox', :'rcv', '0/0');
set request.jwt.claims = :'fin_r_c';
set getsetpaid.from_server = off;
select idl.val('DV11 the same receiver, the same query, with the server mark off: neither', :'rcv', '0/0');
set getsetpaid.from_server = on;
select idl.val('DV12 the row is the receiver''s and carries the sender''s name', format($$select (organisation_id = %L)::text || '/' || sender_name || '/' || status from public.received_invoices where id = %L$$, :'org_r', :'del_ir2'), 'true/IDL Sender Ltd/issued');
select idl.val('DV13 the void invoice stays visible with status void', format($$select status from public.received_invoices where id = %L$$, :'del_vr'), 'void');
select idl.val('DV14 card_payment_enabled: true for the issued invoice on a live account, false for the void one', format($$select (select card_payment_enabled from public.received_invoices where id = %L)::text || '/' || (select card_payment_enabled from public.received_invoices where id = %L)::text$$, :'del_ir2', :'del_vr'), 'true/false');
select format($$select (select count(*) from public.invoices where id = %1$L) || '/' || (select count(*) from public.invoice_lines where invoice_id = %1$L) || '/' || (select count(*) from public.invoice_sends where invoice_id = %1$L) || '/' || (select count(*) from public.invoice_deliveries where invoice_id = %1$L) || '/' || (select count(*) from public.invoice_stripe_accounts where organisation_id = %2$L) || '/' || (select count(*) from public.invoice_card_payments where invoice_id = %1$L)$$, :'inv_i', :'org_s') as sender_tables \gset
select idl.val('DV16 THE RECEIVER READS NO SENDER TABLE: invoices, lines, sends, deliveries, Stripe account, card payments', :'sender_tables', '0/0/0/0/0/0');
set request.jwt.claims = :'fin_s_c';
select idl.val('DV16c CONTROL: the sender reads the SAME six counts as >= 1 each (invoices, lines, sends, live deliveries, Stripe account, card payments)', format($$select (select count(*) from public.invoices where id = %1$L) || '/' || (select count(*) from public.invoice_lines where invoice_id = %1$L) || '/' || (select count(*) from public.invoice_sends where invoice_id = %1$L) || '/' || (select count(*) from public.invoice_deliveries where invoice_id = %1$L and withdrawn_at is null) || '/' || (select count(*) from public.invoice_stripe_accounts where organisation_id = %2$L) || '/' || (select count(*) from public.invoice_card_payments where invoice_id = %1$L)$$, :'inv_i', :'org_s'), '1/1/1/1/1/1');
select idl.val('DV15 the sender withdraws the void one', format($$select 'ok' from (select public.withdraw_invoice_delivery(%L)) s$$, :'del_vr'), 'ok');
set request.jwt.claims = :'fin_r_c';
select idl.val('DV15b ...and a withdrawn delivery leaves the receiver''s view', format($$select count(*)::text from public.received_invoices where id = %L$$, :'del_vr'), '0');
reset role;
reset request.jwt.claims;
update public.organisations set deleted_at = now() where id = :'org_r';
select format($$select count(*)::text from public.received_invoices where id = %L$$, :'del_ir2') as rcv_one \gset
set role authenticated;
set request.jwt.claims = :'fin_r_c';
select idl.val('DV17 a suspended receiver reads nothing (view_finance does not survive suspension)', :'rcv_one', '0');
reset role;
reset request.jwt.claims;
update public.organisations set deleted_at = null where id = :'org_r';
set role authenticated;
set request.jwt.claims = :'fin_r_c';
select idl.val('DV17c CONTROL: restored, the same user reads it again', :'rcv_one', '1');
reset role;
reset request.jwt.claims;

-- DV17d: a suspended SENDER keeps the delivery readable (spec § Edge rules). Only the
-- receiver's own read-only state closes the inbox (DV17); the sender's does not. The
-- control is DV17c just above (same user, same row, readable) and the restore below.
update public.organisations set deleted_at = now(), lifecycle_state = 'suspended' where id = :'org_s';
set role authenticated;
set request.jwt.claims = :'fin_r_c';
select idl.val('DV17d a suspended SENDER leaves the delivered invoice readable to the receiver', :'rcv_one', '1');
reset role;
reset request.jwt.claims;
update public.organisations set deleted_at = null, lifecycle_state = 'active' where id = :'org_s';

-- DV18: recipient.email in the snapshot is the sender's private CRM contact
-- email; the view blanks it. Plant one on inv_i's frozen snapshot (as postgres,
-- replica mode like § DZ: the freeze trigger refuses it otherwise), prove the
-- BASE row carries it, then read the view as the receiver. Restored after.
set session_replication_role = replica;
update public.invoices set snapshot = jsonb_set(snapshot, '{recipient,email}', '"leak@sender-private.test"') where id = :'inv_i';
set session_replication_role = origin;
select idl.val('DV18a CONTROL: the planted email is on the sender''s base row', format($$select snapshot->'recipient'->>'email' from public.invoices where id = %L$$, :'inv_i'), 'leak@sender-private.test');
set role authenticated;
set request.jwt.claims = :'fin_r_c';
select idl.val('DV18 THE VIEW BLANKS recipient.email (key kept as null) while the rest of the snapshot is intact', format($$select (snapshot->'recipient'->>'email' is null)::text || '/' || (snapshot->'recipient' ? 'email')::text || '/' || (snapshot->'seller'->>'name') from public.received_invoices where id = %L$$, :'del_ir2'), 'true/true/IDL Sender Ltd');
reset role;
reset request.jwt.claims;
set session_replication_role = replica;
update public.invoices set snapshot = jsonb_set(snapshot, '{recipient,email}', 'null'::jsonb) where id = :'inv_i';
set session_replication_role = origin;

-- ===========================================================================
-- § DP THE RECEIVED PDF AUDIT
-- ===========================================================================
select format($$select 'ok' from (select public.audit_received_invoice_download(%L)) s$$, :'del_ir2') as dp_ir \gset
select format($$select 'ok' from (select public.audit_received_invoice_download(%L)) s$$, :'del_vr') as dp_vr \gset
set role authenticated;
set request.jwt.claims = :'fin_r_c';
select idl.val('DP1 the receiver''s Finance user audits a download of a live delivery', :'dp_ir', 'ok');
reset role;
reset request.jwt.claims;
select idl.val('DP2 the audit row is in R, targets the delivery and carries number and status only', format($$select (organisation_id = %L)::text || '/' || after::text from public.audit_events where action = 'invoice.received_pdf_downloaded' and target_id = %L$$, :'org_r', :'del_ir2'), 'true/{"number": "IDL-0001", "status": "issued"}');
set role authenticated;
set request.jwt.claims = :'bk_r_c';
select idl.val('DP3 the receiver''s Booker (no view_finance) is refused', :'dp_ir', 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_t_c';
select idl.val('DP4 BREAKOUT: a third workspace''s Finance user is refused', :'dp_ir', 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_s_c';
select idl.val('DP5 the sender is refused (it is not the receiver)', :'dp_ir', 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_r_c';
select idl.val('DP6 a withdrawn delivery is refused to the receiver that DP1 let in on the live one', :'dp_vr', 'denied(42501:forbidden)');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § DN THE DELIVERY NOTICE. public.pending_invoice_delivery_notifications is
-- the delivery tick's queue: one row per LIVE invoice.delivered audit row, with
-- the RECEIVING workspace's view_finance holders' addresses. Live now: inv_i
-- S->R (del_ir2, audited by deliver_invoice); del_ir is withdrawn.
-- ===========================================================================
reset role;
reset request.jwt.claims;
delete from private.notification_deliveries where notice = 'invoice_delivered' and audit_event_id in (select id from public.audit_events where action = 'invoice.delivered' and organisation_id in (:'org_s', :'org_r', :'org_x'));
select (select slug from public.organisations where id = :'org_r') || ':IDL Sender Ltd:' || (select string_agg(email, '+' order by email) from auth.users where id in (:'fin_r', :'own_r')) as dn1_want \gset
select id as dn_aud from public.audit_events where action = 'invoice.delivered' and target_id = :'del_ir2' \gset
select id as dn_wd from public.audit_events where action = 'invoice.delivery_withdrawn' and target_id = :'del_ir' \gset
select id as dn_old from public.audit_events where action = 'invoice.delivered' and target_id = :'del_ir' \gset
select format($$select string_agg(organisation_slug || ':' || sender_name || ':' || array_to_string(emails, '+'), ',') from public.pending_invoice_delivery_notifications(30) where audit_event_id = %L$$, :'dn_aud') as dn_q \gset
select idl.val('DN0 the resolver is executable by service_role only, a definer with an empty search_path', $$select string_agg(p.proname || '=' || coalesce((select string_agg(r, '/' order by r) from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r, p.oid, 'EXECUTE')), '-') || (case when p.prosecdef and p.proconfig = array['search_path=""'] then '' else '!' end), ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'pending_invoice_delivery_notifications'$$, 'pending_invoice_delivery_notifications=service_role');
select idl.val('DN1 the live delivery is one row: the RECEIVER''s slug, the SENDER''s business name, and the addresses of R''s view_finance holders only (not the booker, not any S member)', :'dn_q', :'dn1_want');
select idl.val('DN1a CONTROL: the stripped-down expectation really names two addresses and not bk_r', format($$select (cardinality(string_to_array(%L, '+')) = 2)::text || '/' || (position(%L in %L) = 0)::text$$, :'dn1_want', 'idl-bk-r-' || :'bk_r', :'dn1_want'), 'true/true');
select idl.val('DN6 a WITHDRAWN delivery''s audit row is not pending (DN1 shows a live one is)', format($$select count(*)::text from public.pending_invoice_delivery_notifications(30) where audit_event_id = %L$$, :'dn_old'), '0');
set role authenticated;
set request.jwt.claims = :'fin_r_c';
select idl.val('DN2 a signed-in user is refused the resolver by privilege', $$select count(*)::text from public.pending_invoice_delivery_notifications(30)$$, 'denied(42501)');
reset role;
reset request.jwt.claims;
set role service_role;
select idl.val('DN2c CONTROL: service_role with no user session reads the queue', $$select (count(*) > 0)::text from public.pending_invoice_delivery_notifications(30)$$, 'true');
set request.jwt.claims = :'fin_r_c';
select idl.val('DN2b service_role carrying a USER''s session is refused by the body''s own guard', $$select count(*)::text from public.pending_invoice_delivery_notifications(30)$$, 'denied(42501:notification_stamp_is_server_only)');
reset role;
reset request.jwt.claims;
select idl.val('DN3 stamping the delivered audit row under invoice_delivered writes one ledger row', format($$select public.mark_notices_delivered('invoice_delivered', array[%L::uuid])::text$$, :'dn_aud'), '1');
select idl.val('DN3a ...and the row leaves the queue', :'dn_q', '<null>');
select idl.val('DN4 the stamp refuses an invoice.delivery_withdrawn audit id under this notice', format($$select public.mark_notices_delivered('invoice_delivered', array[%L::uuid])::text$$, :'dn_wd'), '0');
select idl.val('DN4a ...and so does the undeliverable stamp', format($$select public.mark_notices_undeliverable('invoice_delivered', array[%L::uuid], 'no_recipient')::text$$, :'dn_wd'), '0');

-- A fresh live delivery (inv_p, S->R) with its own audit row, planted directly.
delete from public.invoice_deliveries where invoice_id = :'inv_p';
select gen_random_uuid()::text as dn_del \gset
select gen_random_uuid()::text as dn_aud5 \gset
insert into public.invoice_deliveries (id, invoice_id, from_organisation_id, to_organisation_id, delivered_by) values (:'dn_del', :'inv_p', :'org_s', :'org_r', :'fin_s');
insert into public.audit_events (id, organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
values (:'dn_aud5', :'org_s', :'fin_s', 'invoice.delivered', 'invoice_delivery', :'dn_del', gen_random_uuid(), '{"number": "IDL-0002"}');
select format($$select count(*)::text from public.pending_invoice_delivery_notifications(30) where audit_event_id = %L$$, :'dn_aud5') as dn_q5 \gset
update public.organisations set deleted_at = now() where id = :'org_r';
select idl.val('DN5 a receiver that went read-only gets nothing', :'dn_q5', '0');
update public.organisations set deleted_at = null where id = :'org_r';
select idl.val('DN5c CONTROL: restored, the same delivery is pending', :'dn_q5', '1');
select idl.val('DN5d the undeliverable stamp records it once', format($$select public.mark_notices_undeliverable('invoice_delivered', array[%L::uuid], 'no_recipient')::text$$, :'dn_aud5'), '1');
select idl.val('DN5e ...and an undeliverable row leaves the queue too', :'dn_q5', '0');

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
select idl.val('DZ1 housekeeping left no row behind in any table the suite wrote', format($$select ((select count(*) from public.invoices where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.invoice_deliveries where from_organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L) or to_organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.network_profiles where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.network_connection_requests where from_organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.invoice_stripe_accounts where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.invoice_sends where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.invoice_card_payments where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from auth.users where id in (%6$L, %7$L, %8$L)))::text$$, :'org_s', :'org_r', :'org_t', :'org_u', :'org_x', :'fin_s', :'fin_r', :'fin_x'), '0');

\echo
\echo ==================== INVOICE DELIVERIES ====================
select seq, label, expected, actual, pass from idl.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from idl.results;

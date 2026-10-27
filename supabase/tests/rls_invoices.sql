-- ===========================================================================
-- INVOICES, PART 1 OF 3 (spec docs/superpowers/specs/2026-10-20-invoices-design.md).
--
-- Task 3 (20261107000000_invoice_tables.sql):
--   IT  the four tables, their constraints, grants and policies
--   IA  the line/VAT arithmetic and the numbering (bound to the TS port)
--   IR  who reads an invoice, its lines, its sends and the settings
--   IB  breakout: no client role writes any of the four tables
--   IF  the freeze: an issued invoice's content cannot change, for any role
--   IN  the network views never read an invoice table
--   IC  the catalogues the tables joined (audit, retention, export)
-- Task 4 (20261107001000_invoice_draft_rpcs.sql):
--   ID  drafts: save_invoice_draft / delete_invoice_draft
-- Task 5 (20261107002000_invoice_issue.sql):
--   IS  issue: numbering, snapshot, refusals, one entry billed once (Q255)
-- Task 6 (20261107003000_invoice_paid_and_void.sql):
--   IP  mark paid, and the finance link (net income booked on a live event)
--   IV  void, reversing exactly what mark-paid booked
--   IE  an erased account's invoices: the re-point to the tombstone
-- Later tasks add their sections ABOVE § IZ.
--
-- EVERY ASSERTION IS ONE LINE BEGINNING `select inv.val(`: run-rls-tests.sh's
-- pin is `grep -c '^select inv.val(' supabase/tests/rls_invoices.sql`.
-- Re-runnable on one database: every fixture is a fresh uuid, § IZ removes them.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists inv cascade;
create schema inv;

create table inv.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function inv.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into inv.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- Runs p_sql and records its single text result, or `denied(<sqlstate>:<hint>)`
-- when it raises. A refusal is ALWAYS a recorded row, never a psql ERROR line
-- (psql exits 0 on ERROR; run_suite counts both, and ON_ERROR_STOP halts here).
create function inv.val(p_label text, p_sql text, p_expected text)
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
  perform inv.record(p_label, p_expected, v_actual);
end $$;

-- Runs p_sql in a subtransaction that is ALWAYS rolled back, and answers which
-- CHECK refused it (`violates <constraint>`), or `written` when none did. The
-- constraint NAME is the point: inv.val's denied(23514) cannot tell the three
-- shape CHECKs apart. Any other error reaches inv.val as denied(...).
create function inv.violated(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_name text;
begin
  begin
    execute p_sql;
    raise exception 'undo the probe row' using errcode = 'IVOK0';
  exception
    when sqlstate 'IVOK0' then return 'written';
    when check_violation then
      get stacked diagnostics v_name = constraint_name;
      return 'violates ' || v_name;
  end;
end $$;

grant usage on schema inv to authenticated, service_role;
grant execute on function inv.record(text,text,text) to authenticated, service_role;
grant execute on function inv.val(text,text,text)    to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- FIXTURES (as postgres)
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as own_a \gset
select gen_random_uuid()::text as adm_a \gset
select gen_random_uuid()::text as fin_a \gset
select gen_random_uuid()::text as mgr_a \gset
select gen_random_uuid()::text as ro_a  \gset
select gen_random_uuid()::text as fin_b \gset
select gen_random_uuid()::text as fin_s \gset
select gen_random_uuid()::text as fin_f \gset
select gen_random_uuid()::text as fin_p \gset
select gen_random_uuid()::text as org_a \gset
select gen_random_uuid()::text as org_b \gset
select gen_random_uuid()::text as org_s \gset
select gen_random_uuid()::text as org_f \gset
select gen_random_uuid()::text as org_p \gset
select gen_random_uuid()::text as com_a \gset
select gen_random_uuid()::text as con_a \gset
select gen_random_uuid()::text as ev_a  \gset
select gen_random_uuid()::text as fe_a  \gset
select gen_random_uuid()::text as com_b \gset
select gen_random_uuid()::text as con_b \gset
select gen_random_uuid()::text as con_s \gset
select gen_random_uuid()::text as con_p \gset
select gen_random_uuid()::text as inv_ad \gset
select gen_random_uuid()::text as inv_ai \gset
select gen_random_uuid()::text as inv_bd \gset
select gen_random_uuid()::text as inv_sd \gset
select gen_random_uuid()::text as inv_pi \gset
select gen_random_uuid()::text as inv_x  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'own_a') as own_a_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'adm_a') as adm_a_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_a') as fin_a_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'fin_a') as fin_a_c1 \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'mgr_a') as mgr_a_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'ro_a')  as ro_a_c   \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_b') as fin_b_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_s') as fin_s_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_f') as fin_f_c  \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
  from (values (:'own_a'::uuid, 'inv-own-a-' || :'own_a' || '@test.local'),
               (:'adm_a'::uuid, 'inv-adm-a-' || :'adm_a' || '@test.local'),
               (:'fin_a'::uuid, 'inv-fin-a-' || :'fin_a' || '@test.local'),
               (:'mgr_a'::uuid, 'inv-mgr-a-' || :'mgr_a' || '@test.local'),
               (:'ro_a'::uuid,  'inv-ro-a-'  || :'ro_a'  || '@test.local'),
               (:'fin_b'::uuid, 'inv-fin-b-' || :'fin_b' || '@test.local'),
               (:'fin_s'::uuid, 'inv-fin-s-' || :'fin_s' || '@test.local'),
               (:'fin_f'::uuid, 'inv-fin-f-' || :'fin_f' || '@test.local'),
               (:'fin_p'::uuid, 'inv-fin-p-' || :'fin_p' || '@test.local')) v(u, e);

insert into public.organisations (id, name, slug) values
  (:'org_a', 'Invoices Alpha',   'inv-alpha-'   || left(:'org_a', 8)),
  (:'org_b', 'Invoices Beta',    'inv-beta-'    || left(:'org_b', 8)),
  (:'org_s', 'Invoices Starter', 'inv-starter-' || left(:'org_s', 8)),
  (:'org_f', 'Invoices Free',    'inv-free-'    || left(:'org_f', 8)),
  (:'org_p', 'Invoices Purged',  'inv-purged-'  || left(:'org_p', 8));
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
select o, p, 'monthly', 4, 'active', now() + interval '30 days'
  from (values (:'org_a'::uuid, 'pro'), (:'org_b'::uuid, 'pro'), (:'org_s'::uuid, 'starter'),
               (:'org_f'::uuid, 'free'), (:'org_p'::uuid, 'pro')) v(o, p)
on conflict (organisation_id) do update set plan_id = excluded.plan_id, status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_a', :'own_a', 'owner',     'active', now()),
  (:'org_a', :'adm_a', 'admin',     'active', now()),
  (:'org_a', :'fin_a', 'finance',   'active', now()),
  (:'org_a', :'mgr_a', 'manager',   'active', now()),
  (:'org_a', :'ro_a',  'read_only', 'active', now()),
  (:'org_b', :'fin_b', 'finance',   'active', now()),
  (:'org_s', :'fin_s', 'finance',   'active', now()),
  (:'org_f', :'fin_f', 'finance',   'active', now()),
  (:'org_p', :'fin_p', 'finance',   'active', now());

insert into public.companies (id, organisation_id, name) values
  (:'com_a', :'org_a', 'Alpha Customer Ltd'), (:'com_b', :'org_b', 'Beta Customer Ltd');
insert into public.contacts (id, organisation_id, name, email) values
  (:'con_a', :'org_a', 'Sam Booker', 'sam@example.test'),
  (:'con_b', :'org_b', 'Bea Buyer', 'bea@example.test'),
  (:'con_s', :'org_s', 'Stan Starter', null),
  (:'con_p', :'org_p', 'Pat Purged', null);
insert into public.events (id, organisation_id, name, starts_at)
  values (:'ev_a', :'org_a', 'Alpha Night', now() + interval '10 days');
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description)
  values (:'fe_a', :'org_a', :'ev_a', 'income', 'budgeted', 300000, 'Box office guarantee');

insert into public.invoice_settings (organisation_id, business_name, business_address, vat_number,
                                     bank_account_name, bank_sort_code, bank_account_number) values
  (:'org_a', 'Alpha Promotions Ltd', '1 Alpha Street, London', 'GB123456789', 'Alpha Promotions Ltd', '123456', '12345678'),
  (:'org_b', 'Beta Events', '2 Beta Road, Leeds', null, null, null, null),
  (:'org_s', 'Starter Shows', '3 Starter Lane, Bristol', null, null, null, null),
  (:'org_p', 'Purged Ltd', '4 Purged Way, York', null, null, null, null);

-- Drafts first, then their lines; the two issued invoices are flipped AFTER
-- their lines exist (the line freeze refuses a line on an issued invoice).
insert into public.invoices (id, organisation_id, recipient_contact_id, recipient_company_id, event_id,
                             recipient_address, created_by) values
  (:'inv_ad', :'org_a', :'con_a', null,     :'ev_a', '9 Customer Road, London', :'fin_a'),
  (:'inv_ai', :'org_a', null,     :'com_a', null,    '8 Customer Road, London', :'fin_a'),
  (:'inv_bd', :'org_b', :'con_b', null,     null,    '7 Buyer Street, Leeds',   :'fin_b'),
  (:'inv_sd', :'org_s', :'con_s', null,     null,    '6 Starter Close, Bristol', :'fin_s'),
  (:'inv_pi', :'org_p', :'con_p', null,     null,    '5 Purged Lane, York',     :'fin_p');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity,
                                  unit_price_minor, vat_rate, net_minor, vat_minor) values
  (:'org_a', :'inv_ad', 1, 'Production fee', 1.00, 50000,  'standard_20', 50000,  10000),
  (:'org_a', :'inv_ai', 1, 'Headline fee',   1.00, 120000, 'standard_20', 120000, 24000),
  (:'org_b', :'inv_bd', 1, 'Hire',           2.00, 10000,  'none',        20000,  0),
  (:'org_s', :'inv_sd', 1, 'Hire',           1.00, 50000,  'none',        50000,  0),
  (:'org_p', :'inv_pi', 1, 'Hire',           1.00, 1000,   'none',        1000,   0);
update public.invoices set net_minor = 50000, vat_minor = 10000, gross_minor = 60000 where id = :'inv_ad';
update public.invoices set net_minor = 20000, gross_minor = 20000 where id = :'inv_bd';
update public.invoices set net_minor = 50000, gross_minor = 50000 where id = :'inv_sd';
update public.invoices i
   set status = 'issued', number = 'FIX-0001', issue_date = current_date, supply_date = current_date,
       due_date = current_date + 30, net_minor = 120000, vat_minor = 24000, gross_minor = 144000,
       snapshot = private.build_invoice_snapshot(i.id, 'FIX-0001', current_date, current_date, current_date + 30)
 where i.id = :'inv_ai';
update public.invoices i
   set status = 'issued', number = 'FIX-0001', issue_date = current_date, supply_date = current_date,
       due_date = current_date, net_minor = 1000, gross_minor = 1000,
       snapshot = private.build_invoice_snapshot(i.id, 'FIX-0001', current_date, current_date, current_date)
 where i.id = :'inv_pi';
insert into public.invoice_sends (organisation_id, invoice_id, to_email, sent_by) values
  (:'org_a', :'inv_ai', 'ap@example.test', :'fin_a'),
  (:'org_p', :'inv_pi', 'pat@example.test', :'fin_p');

-- ===========================================================================
-- § IT THE TABLES, THEIR CONSTRAINTS, GRANTS AND POLICIES (as postgres)
-- ===========================================================================
select inv.val('IT1 the four invoice tables exist', $$select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname in ('invoice_settings','invoices','invoice_lines','invoice_sends')$$, '4');
select inv.val('IT2 RLS is enabled AND forced on all four', $$select string_agg(relname || '=' || relrowsecurity || '/' || relforcerowsecurity, ',' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relname in ('invoice_settings','invoices','invoice_lines','invoice_sends')$$, 'invoice_lines=true/true,invoice_sends=true/true,invoice_settings=true/true,invoices=true/true');
select inv.val('IT3 authenticated holds NO write privilege on any of the four, table- OR column-level (24 checks, 0 held)', $$select count(*)::text || ' checks, ' || count(*) filter (where case when p in ('INSERT','UPDATE','REFERENCES') then has_any_column_privilege('authenticated', t, p) else has_table_privilege('authenticated', t, p) end)::text || ' held' from unnest(array['public.invoice_settings','public.invoices','public.invoice_lines','public.invoice_sends']) t, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p$$, '24 checks, 0 held');
select inv.val('IT4 anon and service_role hold NOTHING on any of the four, table- or column-level (decision 13: the freeze is proved as postgres)', $$select (count(*) filter (where has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))::text || '/' || (select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name in ('invoice_settings','invoices','invoice_lines','invoice_sends') and grantee in ('anon','service_role','PUBLIC'))::text from unnest(array['anon','service_role']) r, unnest(array['public.invoice_settings','public.invoices','public.invoice_lines','public.invoice_sends']) t$$, '0/0');
select inv.val('IT5 POSITIVE CONTROL: authenticated holds SELECT on all four (the read path § IR exercises)', $$select count(*) filter (where has_table_privilege('authenticated', t, 'SELECT'))::text from unnest(array['public.invoice_settings','public.invoices','public.invoice_lines','public.invoice_sends']) t$$, '4');
select inv.val('IT6 each table carries exactly one policy, a SELECT', $$select string_agg(c.relname || '=' || p.polcmd::text, ',' order by c.relname) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'public'::regnamespace and c.relname in ('invoice_settings','invoices','invoice_lines','invoice_sends')$$, 'invoice_lines=r,invoice_sends=r,invoice_settings=r,invoices=r');
select inv.val('IT7 a status outside the four is refused', format($$insert into public.invoices (organisation_id, created_by, status) values (%L, %L, 'sent') returning 'written'$$, :'org_a', :'fin_a'), 'denied(23514)');
select inv.val('IT8 a draft naming BOTH a company and a contact is refused', format($$insert into public.invoices (organisation_id, created_by, recipient_company_id, recipient_contact_id) values (%L, %L, %L, %L) returning 'written'$$, :'org_a', :'fin_a', :'com_a', :'con_a'), 'denied(23514)');
select inv.val('IT9 a currency other than GBP is refused', format($$insert into public.invoices (organisation_id, created_by, currency) values (%L, %L, 'EUR') returning 'written'$$, :'org_a', :'fin_a'), 'denied(23514)');
select inv.val('IT10 an invoice naming ANOTHER workspace''s company is refused by the composite FK', format($$insert into public.invoices (organisation_id, created_by, recipient_company_id) values (%L, %L, %L) returning 'written'$$, :'org_a', :'fin_a', :'com_b'), 'denied(23503)');
select inv.val('IT11 a line on ANOTHER workspace''s invoice is refused by the composite FK', format($$insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor) values (%L, %L, 9, 'x', 1, 1, 'none', 1, 0) returning 'written'$$, :'org_a', :'inv_bd'), 'denied(23503)');
select inv.val('IT12 a line with quantity 0 is refused', format($$insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor) values (%L, %L, 9, 'x', 0, 1, 'none', 0, 0) returning 'written'$$, :'org_a', :'inv_ad'), 'denied(23514)');
select inv.val('IT13 a line with a VAT rate outside the five is refused', format($$insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor) values (%L, %L, 9, 'x', 1, 1, 'standard', 1, 0) returning 'written'$$, :'org_a', :'inv_ad'), 'denied(23514)');
select inv.val('IT14 an empty line description is refused', format($$insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor) values (%L, %L, 9, '', 1, 1, 'none', 1, 0) returning 'written'$$, :'org_a', :'inv_ad'), 'denied(23514)');
select inv.val('IT15 gross must equal net plus VAT', format($$update public.invoices set gross_minor = gross_minor + 1 where id = %L returning 'written'$$, :'inv_ad'), 'denied(23514)');
select inv.val('IT16 the number is constrained to the shape a filename can carry', $$select (pg_get_constraintdef(oid) like '%[A-Z0-9-]{0,12}[0-9]{4,10}%')::text from pg_constraint where conname = 'invoices_number_check'$$, 'true');
select inv.val('IT17 two invoices in one workspace cannot share a number', $$select pg_get_constraintdef(oid) from pg_constraint where conname = 'invoices_number_unique'$$, 'UNIQUE (organisation_id, number)');
select inv.val('IT18 a sort code that is not six digits is refused', format($$update public.invoice_settings set bank_sort_code = '12-34-56' where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(23514)');
select inv.val('IT19 a number prefix outside A-Z, 0-9 and hyphen is refused', format($$update public.invoice_settings set number_prefix = 'inv/' where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(23514)');
select inv.val('IT20 bank details are all three or none', format($$update public.invoice_settings set bank_sort_code = null where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(23514)');
select inv.val('IT21 a VAT number outside the UK formats is refused', format($$update public.invoice_settings set vat_number = 'FR12345678901' where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(23514)');
select inv.val('IT22 a send to something that is not an email address is refused', format($$insert into public.invoice_sends (organisation_id, invoice_id, to_email, sent_by) values (%L, %L, 'not-an-email', %L) returning 'written'$$, :'org_a', :'inv_ai', :'fin_a'), 'denied(23514)');
select inv.val('IT23 clearing an issued row''s recipient address by UPDATE is refused, and the freeze answers before the issued shape', format($$update public.invoices set recipient_address = null where id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
-- The three shape CHECKs, reached by INSERT (the freeze is UPDATE/DELETE
-- only), each beside a control that differs from it in ONE column.
select inv.val('IT24 an issued row with no recipient address is refused by invoices_issued_shape', format($$select inv.violated(%L)$$, format($$insert into public.invoices (organisation_id, created_by, recipient_contact_id, recipient_address, status, number, snapshot, issue_date, due_date, supply_date) values (%L, %L, %L, null, 'issued', 'TST-0001', '{}', current_date, current_date, current_date)$$, :'org_a', :'fin_a', :'con_a')), 'violates invoices_issued_shape');
select inv.val('IT25 POSITIVE CONTROL: the same issued row WITH an address is written (and rolled back)', format($$select inv.violated(%L)$$, format($$insert into public.invoices (organisation_id, created_by, recipient_contact_id, recipient_address, status, number, snapshot, issue_date, due_date, supply_date) values (%L, %L, %L, '1 Probe Road', 'issued', 'TST-0001', '{}', current_date, current_date, current_date)$$, :'org_a', :'fin_a', :'con_a')), 'written');
select inv.val('IT26 a paid row with no paid_on/paid_by is refused by invoices_paid_shape', format($$select inv.violated(%L)$$, format($$insert into public.invoices (organisation_id, created_by, recipient_contact_id, recipient_address, status, number, snapshot, issue_date, due_date, supply_date, paid_on, paid_by) values (%L, %L, %L, '1 Probe Road', 'paid', 'TST-0001', '{}', current_date, current_date, current_date, null, null)$$, :'org_a', :'fin_a', :'con_a')), 'violates invoices_paid_shape');
select inv.val('IT27 POSITIVE CONTROL: the same paid row WITH paid_on/paid_by is written (and rolled back)', format($$select inv.violated(%L)$$, format($$insert into public.invoices (organisation_id, created_by, recipient_contact_id, recipient_address, status, number, snapshot, issue_date, due_date, supply_date, paid_on, paid_by) values (%L, %L, %L, '1 Probe Road', 'paid', 'TST-0001', '{}', current_date, current_date, current_date, current_date, %L)$$, :'org_a', :'fin_a', :'con_a', :'fin_a')), 'written');
select inv.val('IT28 a void row with no reason is refused by invoices_void_shape', format($$select inv.violated(%L)$$, format($$insert into public.invoices (organisation_id, created_by, recipient_contact_id, recipient_address, status, number, snapshot, issue_date, due_date, supply_date, voided_at, voided_by, void_reason) values (%L, %L, %L, '1 Probe Road', 'void', 'TST-0001', '{}', current_date, current_date, current_date, now(), %L, null)$$, :'org_a', :'fin_a', :'con_a', :'fin_a')), 'violates invoices_void_shape');
select inv.val('IT29 POSITIVE CONTROL: the same void row WITH a reason is written (and rolled back)', format($$select inv.violated(%L)$$, format($$insert into public.invoices (organisation_id, created_by, recipient_contact_id, recipient_address, status, number, snapshot, issue_date, due_date, supply_date, voided_at, voided_by, void_reason) values (%L, %L, %L, '1 Probe Road', 'void', 'TST-0001', '{}', current_date, current_date, current_date, now(), %L, 'Raised in error')$$, :'org_a', :'fin_a', :'con_a', :'fin_a')), 'written');

-- ===========================================================================
-- § IA THE ARITHMETIC AND THE NUMBERING (as postgres)
-- ===========================================================================
create table inv.cases (qty text, unit bigint, rate text, net bigint, vat bigint);
-- ARITHMETIC CASES BEGIN (bound to tests/unit/invoices/arithmetic-cases.ts by arithmetic-cases-match-sql.test.ts)
insert into inv.cases values
  ('1.00', 10000, 'standard_20', 10000, 2000),
  ('2.50', 333, 'standard_20', 833, 167),
  ('0.01', 1, 'standard_20', 0, 0),
  ('0.50', 1, 'standard_20', 1, 0),
  ('3.00', 1999, 'reduced_5', 5997, 300),
  ('1.00', 250, 'standard_20', 250, 50),
  ('1.00', 2, 'reduced_5', 2, 0),
  ('1.00', 10, 'reduced_5', 10, 1),
  ('7.25', 100, 'zero', 725, 0),
  ('1.00', 12345, 'exempt', 12345, 0),
  ('1.00', 12345, 'none', 12345, 0),
  ('12.34', 5678, 'standard_20', 70067, 14013);
-- ARITHMETIC CASES END
select inv.val('IA1 private.invoice_line_amounts matches every row of the shared case table', $$select count(*)::text || ' cases, ' || count(*) filter (where (a.net_minor, a.vat_minor) is distinct from (c.net, c.vat))::text || ' wrong' from inv.cases c cross join lateral private.invoice_line_amounts(c.qty::numeric(12,2), c.unit, c.rate) a$$, '12 cases, 0 wrong');
select inv.val('IA2 numbers pad to four digits and never truncate (decision 11)', $$select private.format_invoice_number('INV-', 1) || ',' || private.format_invoice_number('', 42) || ',' || private.format_invoice_number('INV-', 9999) || ',' || private.format_invoice_number('INV-', 12345)$$, 'INV-0001,0042,INV-9999,INV-12345');
select inv.val('IA3 the snapshot of the issued fixture carries seller VAT, bank, recipient, one line and its totals', format($$select concat_ws('|', snapshot ->> 'number', snapshot -> 'seller' ->> 'vat_number', snapshot -> 'seller' -> 'bank' ->> 'sort_code', snapshot -> 'recipient' ->> 'kind', snapshot -> 'recipient' ->> 'name', jsonb_array_length(snapshot -> 'lines'), snapshot -> 'lines' -> 0 ->> 'quantity', snapshot -> 'totals' ->> 'gross_minor') from public.invoices where id = %L$$, :'inv_ai'), 'FIX-0001|GB123456789|123456|company|Alpha Customer Ltd|1|1.00|144000');
select inv.val('IA4 no client role can execute the three private helpers', $$select count(*) filter (where has_function_privilege(r, f, 'EXECUTE'))::text from unnest(array['anon','authenticated','service_role']) r, unnest(array['private.invoice_line_amounts(numeric,bigint,text)','private.format_invoice_number(text,integer)','private.build_invoice_snapshot(uuid,text,date,date,date)']) f$$, '0');

-- ===========================================================================
-- § IR WHO READS WHAT. One string per persona: invoices, lines, settings and
-- sends, each as A/B/S counts.
-- ===========================================================================
select format($$select 'inv:' || (select count(*) from public.invoices where organisation_id = %1$L) || '/' || (select count(*) from public.invoices where organisation_id = %2$L) || '/' || (select count(*) from public.invoices where organisation_id = %3$L) || ' lines:' || (select count(*) from public.invoice_lines where organisation_id = %1$L) || '/' || (select count(*) from public.invoice_lines where organisation_id = %2$L) || '/' || (select count(*) from public.invoice_lines where organisation_id = %3$L) || ' set:' || (select count(*) from public.invoice_settings where organisation_id = %1$L) || '/' || (select count(*) from public.invoice_settings where organisation_id = %2$L) || '/' || (select count(*) from public.invoice_settings where organisation_id = %3$L) || ' sends:' || (select count(*) from public.invoice_sends where organisation_id = %1$L) || '/' || (select count(*) from public.invoice_sends where organisation_id = %2$L) || '/' || (select count(*) from public.invoice_sends where organisation_id = %3$L)$$, :'org_a', :'org_b', :'org_s') as vis \gset
select inv.val('IR0 FIXTURE: as postgres every planted row is there', :'vis', 'inv:2/1/1 lines:2/1/1 set:1/1/1 sends:1/0/0');
set role authenticated;
set request.jwt.claims = :'own_a_c';
select inv.val('IR1 A''s Owner reads A''s invoices, lines, settings and sends, and nothing of B or S', :'vis', 'inv:2/0/0 lines:2/0/0 set:1/0/0 sends:1/0/0');
set request.jwt.claims = :'adm_a_c';
select inv.val('IR2 A''s Admin reads the same', :'vis', 'inv:2/0/0 lines:2/0/0 set:1/0/0 sends:1/0/0');
set request.jwt.claims = :'fin_a_c';
select inv.val('IR3 A''s Finance user reads the same', :'vis', 'inv:2/0/0 lines:2/0/0 set:1/0/0 sends:1/0/0');
set request.jwt.claims = :'mgr_a_c';
select inv.val('IR4 A''s Manager (no view_finance) reads nothing', :'vis', 'inv:0/0/0 lines:0/0/0 set:0/0/0 sends:0/0/0');
set request.jwt.claims = :'ro_a_c';
select inv.val('IR5 A''s Read Only reads nothing', :'vis', 'inv:0/0/0 lines:0/0/0 set:0/0/0 sends:0/0/0');
set request.jwt.claims = :'fin_a_c1';
select inv.val('IR6 MFA: A''s Finance user at aal1 reads nothing (view_finance is aal2-gated)', :'vis', 'inv:0/0/0 lines:0/0/0 set:0/0/0 sends:0/0/0');
set request.jwt.claims = :'fin_b_c';
select inv.val('IR7 B''s Finance user reads B and never A', :'vis', 'inv:0/1/0 lines:0/1/0 set:0/1/0 sends:0/0/0');
set request.jwt.claims = :'fin_s_c';
select inv.val('IR8 DOWNGRADE HIDES NOTHING: a Starter workspace''s Finance user still reads its invoices', :'vis', 'inv:0/0/1 lines:0/0/1 set:0/0/1 sends:0/0/0');
set request.jwt.claims = :'fin_f_c';
select inv.val('IR9 a Free workspace''s Finance user reads nothing of anybody else''s', :'vis', 'inv:0/0/0 lines:0/0/0 set:0/0/0 sends:0/0/0');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § IB BREAKOUT: A's Finance user (aal2, the strongest writer there is)
-- forges a write on every table.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select inv.val('IB1 a forged INSERT on invoices is refused by privilege', format($$insert into public.invoices (organisation_id, created_by) values (%L, %L) returning 'written'$$, :'org_a', :'fin_a'), 'denied(42501:missing_grant)');
select inv.val('IB2 a forged UPDATE on a DRAFT invoice is refused by privilege', format($$update public.invoices set notes = 'forged' where id = %L returning 'written'$$, :'inv_ad'), 'denied(42501:missing_grant)');
select inv.val('IB3 a forged DELETE on invoices is refused by privilege', format($$delete from public.invoices where id = %L returning 'written'$$, :'inv_ad'), 'denied(42501:missing_grant)');
select inv.val('IB4 a forged INSERT on invoice_lines is refused by privilege', format($$insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor) values (%L, %L, 9, 'x', 1, 1, 'none', 1, 0) returning 'written'$$, :'org_a', :'inv_ad'), 'denied(42501:missing_grant)');
select inv.val('IB5 a forged UPDATE on invoice_lines is refused by privilege', format($$update public.invoice_lines set unit_price_minor = 1 where invoice_id = %L returning 'written'$$, :'inv_ad'), 'denied(42501:missing_grant)');
select inv.val('IB6 a forged UPDATE of next_number is refused by privilege', format($$update public.invoice_settings set next_number = 1 where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select inv.val('IB7 a forged INSERT on invoice_sends is refused by privilege', format($$insert into public.invoice_sends (organisation_id, invoice_id, to_email, sent_by) values (%L, %L, 'x@example.test', %L) returning 'written'$$, :'org_a', :'inv_ai', :'fin_a'), 'denied(42501:missing_grant)');
select inv.val('IB8 a forged DELETE on invoice_sends is refused by privilege', format($$delete from public.invoice_sends where invoice_id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:missing_grant)');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § IF THE FREEZE, as postgres -- the table owner, past RLS (decision 13).
-- ===========================================================================
select inv.val('IF1 an issued invoice''s totals cannot change', format($$update public.invoices set net_minor = net_minor + 1, gross_minor = gross_minor + 1 where id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF2 ...nor its snapshot', format($$update public.invoices set snapshot = '{"version":1}'::jsonb where id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF3 ...nor its number', format($$update public.invoices set number = 'FIX-0002' where id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF4 ...nor its recipient', format($$update public.invoices set recipient_company_id = null, recipient_contact_id = %L where id = %L returning 'written'$$, :'con_a', :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF5 an issued invoice cannot go back to draft', format($$update public.invoices set status = 'draft', number = null, snapshot = null, issue_date = null, due_date = null where id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_transition_not_allowed)');
select inv.val('IF6 a draft cannot jump straight to paid', format($$update public.invoices set status = 'paid' where id = %L returning 'written'$$, :'inv_ad'), 'denied(42501:invoice_transition_not_allowed)');
select inv.val('IF7 a line of an issued invoice cannot change', format($$update public.invoice_lines set unit_price_minor = 1 where invoice_id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF8 ...nor be added', format($$insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor) values (%L, %L, 2, 'x', 1, 1, 'none', 1, 0) returning 'written'$$, :'org_a', :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF9 ...nor be deleted directly', format($$delete from public.invoice_lines where invoice_id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF10 ...nor be moved onto a draft', format($$update public.invoice_lines set invoice_id = %L where invoice_id = %L returning 'written'$$, :'inv_ad', :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF11 an issued invoice cannot be deleted directly', format($$delete from public.invoices where id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF12 its creator cannot be re-pointed at another person', format($$update public.invoices set created_by = %L where id = %L returning 'written'$$, :'own_a', :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF13 POSITIVE CONTROL: a DRAFT is still editable by its owner role', format($$update public.invoices set notes = 'edited' where id = %L returning 'written'$$, :'inv_ad'), 'written');
select inv.val('IF14 POSITIVE CONTROL: the erasure re-point (creator -> tombstone) is admitted on an issued invoice', format($$update public.invoices set created_by = private.erased_user_id() where id = %L returning 'written'$$, :'inv_pi'), 'written');
select inv.val('IF15 both freeze triggers are enabled', $$select string_agg(tgname || '=' || tgenabled::text, ',' order by tgname) from pg_trigger where tgname in ('invoices_freeze','invoice_lines_freeze') and not tgisinternal$$, 'invoice_lines_freeze=O,invoices_freeze=O');
select inv.val('IF16 THE PURGE STILL WORKS: erasing a workspace holding an issued, sent invoice cascades through the freeze', format($$select 'ok' from (select private.erase_organisation(%L, null, false)) s$$, :'org_p'), 'ok');
select inv.val('IF17 ...and leaves none of its invoice rows', format($$select (select count(*) from public.invoices where organisation_id = %1$L) || '/' || (select count(*) from public.invoice_lines where organisation_id = %1$L) || '/' || (select count(*) from public.invoice_sends where organisation_id = %1$L) || '/' || (select count(*) from public.invoice_settings where organisation_id = %1$L)$$, :'org_p'), '0/0/0/0');

-- IF18-IF20. A hard delete of an issued invoice or its lines is admitted only
-- once the parent workspace row is GONE (the purge's cascade, IF16/IF17) --
-- not for being nested in a trigger. This trigger, at depth 1, deletes at
-- depth 2 with the workspace still there, and reports how many rows went.
create table inv.nest (invoice_id uuid, target text, deleted integer);
create function inv.nest_delete() returns trigger
language plpgsql set search_path = '' as $$
declare n integer;
begin
  if new.target = 'invoice' then
    delete from public.invoices where id = new.invoice_id;
  else
    delete from public.invoice_lines where invoice_id = new.invoice_id;
  end if;
  get diagnostics n = row_count;
  new.deleted := n;
  return new;
end $$;
create trigger nest_delete before insert on inv.nest
  for each row execute function inv.nest_delete();
select inv.val('IF18 a delete NESTED in another trigger, workspace present, cannot remove an issued invoice', format($$insert into inv.nest (invoice_id, target) values (%L, 'invoice') returning 'deleted ' || deleted$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF19 ...nor its lines', format($$insert into inv.nest (invoice_id, target) values (%L, 'lines') returning 'deleted ' || deleted$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF20 POSITIVE CONTROL: the same nested path deletes a DRAFT''s line', format($$insert into inv.nest (invoice_id, target) values (%L, 'lines') returning 'deleted ' || deleted$$, :'inv_bd'), 'deleted 1');

-- IF21-IF28. The freeze's lookups cannot be blinded by RLS. A role with every
-- write grant and a FOR ALL policy on the lines, but NO policy on invoices or
-- organisations (every shipped policy is `to authenticated`), reads both as
-- empty. An invoker-rights lookup would read null and admit it; the freeze
-- functions are SECURITY DEFINER, so they read as the owner.
select inv.val('IF21 both freeze functions and their workspace lookup are SECURITY DEFINER, search_path pinned, executable by no client role', $$select count(*)::text from pg_proc p where p.oid in ('private.invoices_freeze()'::regprocedure, 'private.invoice_lines_freeze()'::regprocedure, 'private.invoice_workspace_is_gone(uuid)'::regprocedure) and p.prosecdef and p.proconfig @> array['search_path=""'] and not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('service_role', p.oid, 'EXECUTE')$$, '3');
insert into public.invoices (id, organisation_id, created_by) values (:'inv_x', :'org_a', :'fin_a');
\o /dev/null
do $ibw$ begin
  if not exists (select 1 from pg_roles where rolname = 'inv_blind_writer') then
    create role inv_blind_writer;
  end if;
end $ibw$;
-- postgres is not a superuser on Supabase: it may only `set role` into a role
-- it is a member of (rls_phase8_exports.sql XJ1e, measured).
grant inv_blind_writer to postgres;
grant usage on schema public, inv to inv_blind_writer;
grant execute on function inv.val(text,text,text), inv.record(text,text,text) to inv_blind_writer;
grant select on public.invoices, public.organisations to inv_blind_writer;
grant select, update on public.invoice_lines to inv_blind_writer;
drop policy if exists inv_blind_writer_probe on public.invoice_lines;
create policy inv_blind_writer_probe on public.invoice_lines
  for all to inv_blind_writer using (true) with check (true);
\o
set role inv_blind_writer;
select inv.val('IF22 DENOMINATOR: the probe role sees the issued invoice''s line but NOT the invoice', format($$select (select count(*) from public.invoice_lines where invoice_id = %1$L) || '/' || (select count(*) from public.invoices where id = %1$L)$$, :'inv_ai'), '1/0');
select inv.val('IF23 a writer that cannot SEE the issued invoice still cannot change its line', format($$update public.invoice_lines set unit_price_minor = 1 where invoice_id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF24 POSITIVE CONTROL: the same writer CAN change a draft''s line', format($$update public.invoice_lines set description = 'Probe edit' where invoice_id = %L returning 'written'$$, :'inv_ad'), 'written');
reset role;
\o /dev/null
grant delete on public.invoices to inv_blind_writer;
-- ...and the two private helpers invoices_freeze() calls, or an invoker-rights
-- freeze would refuse on the missing grant and IF26 would pass without ever
-- reaching the workspace lookup (measured on the mutant).
grant usage on schema private to inv_blind_writer;
grant execute on function private.erased_user_id(), private.invoice_workspace_is_gone(uuid) to inv_blind_writer;
drop policy if exists inv_blind_writer_probe on public.invoices;
create policy inv_blind_writer_probe on public.invoices
  for all to inv_blind_writer using (true) with check (true);
\o
set role inv_blind_writer;
select inv.val('IF25 DENOMINATOR: the probe role now sees the issued invoice but NOT its workspace', format($$select (select count(*) from public.invoices where id = %L) || '/' || (select count(*) from public.organisations where id = %L)$$, :'inv_ai', :'org_a'), '1/0');
select inv.val('IF26 a deleter that cannot SEE the workspace cannot pass it off as purged', format($$delete from public.invoices where id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');
select inv.val('IF27 POSITIVE CONTROL: the same deleter CAN hard-delete a draft', format($$delete from public.invoices where id = %L returning 'written'$$, :'inv_x'), 'written');
reset role;
\o /dev/null
drop policy inv_blind_writer_probe on public.invoices;
drop policy inv_blind_writer_probe on public.invoice_lines;
revoke all on public.invoices, public.invoice_lines, public.organisations from inv_blind_writer;
revoke execute on function inv.val(text,text,text), inv.record(text,text,text) from inv_blind_writer;
revoke execute on function private.erased_user_id(), private.invoice_workspace_is_gone(uuid) from inv_blind_writer;
revoke usage on schema public, inv, private from inv_blind_writer;
revoke inv_blind_writer from postgres;
drop role if exists inv_blind_writer;
\o
select inv.val('IF28 ...and the probe role and its two policies are gone', $$select (select count(*) from pg_roles where rolname = 'inv_blind_writer') || '|' || (select count(*) from pg_policies where schemaname = 'public' and policyname = 'inv_blind_writer_probe')$$, '0|0');

-- ===========================================================================
-- § IN THE NETWORK VIEWS NEVER READ AN INVOICE TABLE (the function closure
-- half is network_leakage_phase6.sql IN10)
-- ===========================================================================
select inv.val('IN1 neither masking view depends on an invoice table directly; the four exist', $$select (select count(*) from pg_class v join pg_rewrite rw on rw.ev_class = v.oid join pg_depend d on d.objid = rw.oid and d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass join pg_class t on t.oid = d.refobjid where v.relname in ('network_directory','network_connected_profiles') and t.relname in ('invoice_settings','invoices','invoice_lines','invoice_sends'))::text || '/' || (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('invoice_settings','invoices','invoice_lines','invoice_sends'))::text$$, '0/4');

-- ===========================================================================
-- § IC THE CATALOGUES
-- ===========================================================================
select inv.val('IC1 the retention roll classifies all four (decision 8, Q252)', $$select string_agg(table_name || '=' || treatment, ',' order by table_name) from private.retention_subjects() where table_name in ('invoice_settings','invoices','invoice_lines','invoice_sends')$$, 'invoice_lines=cascades,invoice_sends=cascades,invoice_settings=cascades,invoices=cascades');
select inv.val('IC2 private.assert_retention_roll() passes on the live schema', $$select 'ok' from (select private.assert_retention_roll()) s$$, 'ok');
select inv.val('IC3 the workspace export carries all four; the account export excuses the two that name a person', $$select string_agg(export_kind || ':' || table_name || '=' || disposition, ',' order by export_kind, table_name) from private.export_catalogue() where table_name in ('invoice_settings','invoices','invoice_lines','invoice_sends')$$, 'account:invoice_sends=excused,account:invoices=excused,workspace:invoice_lines=exported,workspace:invoice_sends=exported,workspace:invoice_settings=exported,workspace:invoices=exported');
select inv.val('IC4 the export catalogue is still sound', $$select private.export_catalogue_is_sound()::text$$, 'sound');
select inv.val('IC5 the audit catalogue names the seven invoice actions', $$select count(*)::text from private.audit_action_catalogue() a where a in ('invoice.issued','invoice.sent','invoice.marked_paid','invoice.voided','invoice.pdf_downloaded','invoice_settings.changed','invoice_settings.bank_details_changed')$$, '7');
select inv.val('IC6 no uuid column of an invoice table is an unclassified identifier', $$select count(*)::text from private.unclassified_fkless_identifiers() where table_name like 'public.invoice%'$$, '0');

-- ===========================================================================
-- § ID DRAFTS (Task 4, 20261107001000): save_invoice_draft / delete_invoice_draft
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as fe_ac \gset
select gen_random_uuid()::text as ev_b \gset
select gen_random_uuid()::text as fe_b \gset
select gen_random_uuid()::text as fe_ad \gset
select gen_random_uuid()::text as con_ad \gset
select gen_random_uuid()::text as com_ad \gset
\o
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description)
  values (:'fe_ac', :'org_a', :'ev_a', 'cost', 'budgeted', 1000, 'A cost, not invoiceable');
-- B's event is a literal id: a subquery run as A's caller would read it as null
-- under RLS and save a draft with no event (measured).
insert into public.events (id, organisation_id, name, starts_at)
  values (:'ev_b', :'org_b', 'Beta Night', now() + interval '10 days');
-- B's live income entry, and A's soft-deleted income entry, contact and company.
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description, deleted_at)
  values (:'fe_b',  :'org_b', :'ev_b', 'income', 'budgeted', 5000, 'B income', null),
         (:'fe_ad', :'org_a', :'ev_a', 'income', 'budgeted', 5000, 'A income, deleted', now());
insert into public.contacts (id, organisation_id, name, email, deleted_at)
  values (:'con_ad', :'org_a', 'Del Eted', null, now());
insert into public.companies (id, organisation_id, name, deleted_at)
  values (:'com_ad', :'org_a', 'Deleted Customer Ltd', now());
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select public.save_invoice_draft(:'org_a', null, null, :'con_a', :'ev_a', '9 Customer Road, London', null, 'Thank you',
  jsonb_build_array(
    jsonb_build_object('description', 'Box office guarantee', 'quantity', '1.00', 'unit_price_minor', 300000, 'vat_rate', 'standard_20', 'financial_entry_id', :'fe_a'),
    jsonb_build_object('description', 'Production', 'quantity', '2.50', 'unit_price_minor', 333, 'vat_rate', 'standard_20', 'financial_entry_id', null))) as id_new \gset
select inv.val('ID1 a Finance user saves a new draft; the database computes the totals', format($$select status || '|' || net_minor || '|' || vat_minor || '|' || gross_minor from public.invoices where id = %L$$, :'id_new'), 'draft|300833|60167|361000');
select inv.val('ID2 the lines keep their order, their amounts and the pulled entry', format($$select string_agg(position || ':' || (financial_entry_id is not null)::text || ':' || net_minor || ':' || vat_minor, ',' order by position) from public.invoice_lines where invoice_id = %L$$, :'id_new'), '1:true:300000:60000,2:false:833:167');
select inv.val('ID3 created_by is the caller, stamped by the database', format($$select (created_by = %L)::text from public.invoices where id = %L$$, :'fin_a', :'id_new'), 'true');
select inv.val('ID4 saving the draft again replaces its fields and lines', format($$select (public.save_invoice_draft(%L, %L, %L, null, null, '8 Customer Road, London', null, null, '[{"description":"Hire","quantity":"1.00","unit_price_minor":10000,"vat_rate":"reduced_5","financial_entry_id":null}]'::jsonb) = %L)::text$$, :'org_a', :'id_new', :'com_a', :'id_new'), 'true');
select inv.val('ID5 ...one line now, totals recomputed, recipient switched to the company', format($$select (select count(*) from public.invoice_lines where invoice_id = %1$L) || '|' || gross_minor || '|' || (recipient_company_id is not null and recipient_contact_id is null)::text from public.invoices where id = %1$L$$, :'id_new'), '1|10500|true');
select inv.val('ID6 POSITIVE CONTROL: the RPCs are executable by authenticated, and by nobody else', $$select count(*) filter (where has_function_privilege('authenticated', f, 'EXECUTE')) || '/' || count(*) filter (where has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('service_role', f, 'EXECUTE')) from unnest(array['public.save_invoice_draft(uuid,uuid,uuid,uuid,uuid,text,date,text,jsonb)','public.delete_invoice_draft(uuid)']) f$$, '2/0');
select inv.val('ID7 a line pulled from a COST entry is refused', format($$select public.save_invoice_draft(%L, null, null, null, %L, null, null, null, jsonb_build_array(jsonb_build_object('description','x','quantity','1.00','unit_price_minor',1000,'vat_rate','none','financial_entry_id',%L)))::text$$, :'org_a', :'ev_a', :'fe_ac'), 'denied(22023:invoice_entry_not_invoiceable)');
select inv.val('ID8 a pulled line on a draft with no event is refused', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, jsonb_build_array(jsonb_build_object('description','x','quantity','1.00','unit_price_minor',1000,'vat_rate','none','financial_entry_id',%L)))::text$$, :'org_a', :'fe_a'), 'denied(22023:invoice_entry_not_invoiceable)');
select inv.val('ID9 two recipients are refused', format($$select public.save_invoice_draft(%L, null, %L, %L, null, null, null, null, '[]'::jsonb)::text$$, :'org_a', :'com_a', :'con_a'), 'denied(22023:invoice_one_recipient)');
select inv.val('ID10 ANOTHER workspace''s contact as recipient is refused', format($$select public.save_invoice_draft(%L, null, null, %L, null, null, null, null, '[]'::jsonb)::text$$, :'org_a', :'con_b'), 'denied(22023:invoice_recipient_not_live)');
select inv.val('ID32 ANOTHER workspace''s company as recipient is refused (the controls are ID1/ID4: A''s own contact and company)', format($$select public.save_invoice_draft(%L, null, %L, null, null, null, null, null, '[]'::jsonb)::text$$, :'org_a', :'com_b'), 'denied(22023:invoice_recipient_not_live)');
select inv.val('ID11 more than 100 lines are refused', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, (select jsonb_agg(jsonb_build_object('description','x','quantity','1.00','unit_price_minor',1,'vat_rate','none','financial_entry_id',null)) from generate_series(1, 101)))::text$$, :'org_a'), 'denied(22023:invoice_lines_invalid)');
select inv.val('ID12 a three-decimal quantity is refused, not rounded', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[{"description":"x","quantity":"1.005","unit_price_minor":1,"vat_rate":"none","financial_entry_id":null}]'::jsonb)::text$$, :'org_a'), 'denied(22023:invoice_line_invalid)');
select inv.val('ID13 an unknown VAT rate is refused', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[{"description":"x","quantity":"1.00","unit_price_minor":1,"vat_rate":"standard","financial_entry_id":null}]'::jsonb)::text$$, :'org_a'), 'denied(22023:invoice_line_invalid)');
select inv.val('ID14 an empty description is refused', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[{"description":"","quantity":"1.00","unit_price_minor":1,"vat_rate":"none","financial_entry_id":null}]'::jsonb)::text$$, :'org_a'), 'denied(22023:invoice_line_invalid)');
select inv.val('ID15 the ISSUED invoice cannot be saved over', format($$select public.save_invoice_draft(%L, %L, %L, null, null, 'x', null, null, '[]'::jsonb)::text$$, :'org_a', :'inv_ai', :'com_a'), 'denied(22023:invoice_not_an_editable_draft)');
select inv.val('ID16 B''s draft cannot be saved over by naming A', format($$select public.save_invoice_draft(%L, %L, null, null, null, 'x', null, null, '[]'::jsonb)::text$$, :'org_a', :'inv_bd'), 'denied(22023:invoice_not_an_editable_draft)');
select inv.val('ID17 nor by naming B, where the caller holds nothing', format($$select public.save_invoice_draft(%L, %L, null, null, null, 'x', null, null, '[]'::jsonb)::text$$, :'org_b', :'inv_bd'), 'denied(42501:forbidden)');
select inv.val('ID18 B''s event is refused', format($$select public.save_invoice_draft(%L, null, null, null, %L, null, null, null, '[]'::jsonb)::text$$, :'org_a', :'ev_b'), 'denied(22023:invoice_event_not_live)');
select inv.val('ID33 a SOFT-DELETED contact of this workspace as recipient is refused', format($$select public.save_invoice_draft(%L, null, null, %L, null, null, null, null, '[]'::jsonb)::text$$, :'org_a', :'con_ad'), 'denied(22023:invoice_recipient_not_live)');
select inv.val('ID34 a SOFT-DELETED company of this workspace as recipient is refused', format($$select public.save_invoice_draft(%L, null, %L, null, null, null, null, null, '[]'::jsonb)::text$$, :'org_a', :'com_ad'), 'denied(22023:invoice_recipient_not_live)');
select inv.val('ID35 a SOFT-DELETED income entry on this event is refused (the control is ID1: fe_a, live)', format($$select public.save_invoice_draft(%L, null, null, null, %L, null, null, null, jsonb_build_array(jsonb_build_object('description','x','quantity','1.00','unit_price_minor',1000,'vat_rate','none','financial_entry_id',%L)))::text$$, :'org_a', :'ev_a', :'fe_ad'), 'denied(22023:invoice_entry_not_invoiceable)');
select inv.val('ID36 B''s income entry as a pulled line in A''s draft is refused', format($$select public.save_invoice_draft(%L, null, null, null, %L, null, null, null, jsonb_build_array(jsonb_build_object('description','x','quantity','1.00','unit_price_minor',1000,'vat_rate','none','financial_entry_id',%L)))::text$$, :'org_a', :'ev_a', :'fe_b'), 'denied(22023:invoice_entry_not_invoiceable)');
select inv.val('ID37 the same income entry pulled twice into one draft is refused (the control is ID1: once)', format($$select public.save_invoice_draft(%L, null, null, null, %L, null, null, null, jsonb_build_array(jsonb_build_object('description','x','quantity','1.00','unit_price_minor',1000,'vat_rate','none','financial_entry_id',%3$L), jsonb_build_object('description','y','quantity','1.00','unit_price_minor',1000,'vat_rate','none','financial_entry_id',%3$L)))::text$$, :'org_a', :'ev_a', :'fe_a'), 'denied(22023:invoice_entry_pulled_twice)');
select inv.val('ID38 a financial_entry_id that is not a uuid is refused with a hint, not a raw 22P02', format($$select public.save_invoice_draft(%L, null, null, null, %L, null, null, null, '[{"description":"x","quantity":"1.00","unit_price_minor":1,"vat_rate":"none","financial_entry_id":"not-a-uuid"}]'::jsonb)::text$$, :'org_a', :'ev_a'), 'denied(22023:invoice_line_invalid)');
select inv.val('ID39 a total past bigint is refused with a hint, not a raw 22003', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[{"description":"x","quantity":"1.00","unit_price_minor":9000000000000000000,"vat_rate":"none","financial_entry_id":null},{"description":"y","quantity":"1.00","unit_price_minor":9000000000000000000,"vat_rate":"none","financial_entry_id":null}]'::jsonb)::text$$, :'org_a'), 'denied(22023:invoice_line_invalid)');
select inv.val('ID40 an empty recipient address is refused with a hint, not a raw 23514 (the control is ID1)', format($$select public.save_invoice_draft(%L, null, null, null, null, '', null, null, '[]'::jsonb)::text$$, :'org_a'), 'denied(22023:invoice_address_invalid)');
select inv.val('ID41 notes over 2000 characters are refused with a hint, not a raw 23514 (the control is ID1)', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, repeat('n', 2001), '[]'::jsonb)::text$$, :'org_a'), 'denied(22023:invoice_notes_invalid)');
select inv.val('ID43 TENANT BREAKOUT: A''s Finance user cannot delete B''s draft', format($$select 'ok' from (select public.delete_invoice_draft(%L)) s$$, :'inv_bd'), 'denied(42501:forbidden)');
select inv.val('ID45 ...and a uuid that names nothing gets the identical refusal (no existence oracle)', $$select 'ok' from (select public.delete_invoice_draft(gen_random_uuid())) s$$, 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_a_c1';
select inv.val('ID19 MFA: the same Finance user at aal1 is refused', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[]'::jsonb)::text$$, :'org_a'), 'denied(42501:forbidden)');
set request.jwt.claims = :'mgr_a_c';
select inv.val('ID20 a Manager (no manage_finance) is refused', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[]'::jsonb)::text$$, :'org_a'), 'denied(42501:forbidden)');
select inv.val('ID21 ...and cannot delete a draft either', format($$select 'ok' from (select public.delete_invoice_draft(%L)) s$$, :'inv_ad'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_s_c';
select inv.val('ID22 a STARTER workspace''s Finance user is refused by the plan', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[]'::jsonb)::text$$, :'org_s'), 'denied(42501:plan_does_not_include_invoicing)');
select inv.val('ID23 ...and cannot delete its own draft (read-only after a downgrade)', format($$select 'ok' from (select public.delete_invoice_draft(%L)) s$$, :'inv_sd'), 'denied(42501:plan_does_not_include_invoicing)');
set request.jwt.claims = :'fin_f_c';
select inv.val('ID24 a FREE workspace''s Finance user is refused by the plan', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[]'::jsonb)::text$$, :'org_f'), 'denied(42501:plan_does_not_include_invoicing)');
set request.jwt.claims = :'fin_b_c';
select public.save_invoice_draft(:'org_b', null, null, :'con_b', null, '7 Buyer Street', null, null,
  '[{"description":"Hire","quantity":"1.00","unit_price_minor":10000,"vat_rate":"standard_20","financial_entry_id":null}]'::jsonb) as id_b \gset
select inv.val('ID25 NOT VAT REGISTERED: B''s 20% line is stored as no VAT, with no VAT charged', format($$select vat_rate || '|' || vat_minor from public.invoice_lines where invoice_id = %L$$, :'id_b'), 'none|0');
select inv.val('ID42 NOT VAT REGISTERED: an unknown VAT rate is still refused, not stored as no VAT (the control is ID25)', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[{"description":"x","quantity":"1.00","unit_price_minor":1,"vat_rate":"standard","financial_entry_id":null}]'::jsonb)::text$$, :'org_b'), 'denied(22023:invoice_line_invalid)');
set request.jwt.claims = :'fin_a_c';
select inv.val('ID26 the Finance user soft-deletes the draft', format($$select 'ok' from (select public.delete_invoice_draft(%L)) s$$, :'id_new'), 'ok');
select inv.val('ID27 ...it is soft-deleted, not gone', format($$select (deleted_at is not null)::text from public.invoices where id = %L$$, :'id_new'), 'true');
select inv.val('ID28 a soft-deleted draft cannot be saved over', format($$select public.save_invoice_draft(%L, %L, null, null, null, null, null, null, '[]'::jsonb)::text$$, :'org_a', :'id_new'), 'denied(22023:invoice_not_an_editable_draft)');
select inv.val('ID29 an issued invoice cannot be deleted as a draft', format($$select 'ok' from (select public.delete_invoice_draft(%L)) s$$, :'inv_ai'), 'denied(22023:invoice_not_an_editable_draft)');
-- No session at all (the controls are ID1 and ID26: the same calls, signed in).
reset request.jwt.claims;
select inv.val('ID30 with no session, save is refused as unauthenticated', format($$select public.save_invoice_draft(%L, null, null, null, null, null, null, null, '[]'::jsonb)::text$$, :'org_a'), 'denied(28000:not_authenticated)');
select inv.val('ID31 ...and so is delete', format($$select 'ok' from (select public.delete_invoice_draft(%L)) s$$, :'inv_ad'), 'denied(28000:not_authenticated)');
reset role;
select inv.val('ID44 ...B''s draft is untouched by ID43 (read as postgres; the control is ID26/ID27)', format($$select (deleted_at is null)::text from public.invoices where id = %L$$, :'inv_bd'), 'true');

-- ===========================================================================
-- § IS ISSUE (Task 5, 20261107002000): numbering, snapshot, refusals, and
-- one finance entry billed once (Q255 default (a)). The race is
-- invoice_issue_concurrency_probe.sh.
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as org_n \gset
select gen_random_uuid()::text as fin_n \gset
select gen_random_uuid()::text as con_n \gset
select gen_random_uuid()::text as inv_n1 \gset
select gen_random_uuid()::text as inv_n2 \gset
select gen_random_uuid()::text as inv_n3 \gset
select gen_random_uuid()::text as ev_n \gset
select gen_random_uuid()::text as fe_n \gset
select gen_random_uuid()::text as inv_q1 \gset
select gen_random_uuid()::text as inv_q2 \gset
select gen_random_uuid()::text as fe_n2 \gset
select gen_random_uuid()::text as inv_q3 \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_n') as fin_n_c \gset
\o
-- org_n: a Pro workspace with NO invoice_settings row yet.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values (:'fin_n', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inv-fin-n-' || :'fin_n' || '@test.local', now(), now(), now());
insert into public.organisations (id, name, slug) values (:'org_n', 'Invoices Numbering', 'inv-num-' || left(:'org_n', 8));
insert into public.organisation_subscriptions (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
  values (:'org_n', 'pro', 'monthly', 1, 'active', now() + interval '30 days')
  on conflict (organisation_id) do update set plan_id = 'pro', status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
  values (:'org_n', :'fin_n', 'finance', 'active', now());
insert into public.contacts (id, organisation_id, name, email) values (:'con_n', :'org_n', 'Nina Number', 'nina@example.test');
insert into public.invoices (id, organisation_id, recipient_contact_id, recipient_address, created_by) values
  (:'inv_n1', :'org_n', :'con_n', '1 Nina Way', :'fin_n'),
  (:'inv_n2', :'org_n', :'con_n', '1 Nina Way', :'fin_n'),
  (:'inv_n3', :'org_n', null,     null,         :'fin_n');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor) values
  (:'org_n', :'inv_n1', 1, 'Fee', 1, 10000, 'standard_20', 0, 0),
  (:'org_n', :'inv_n2', 1, 'Fee', 1, 20000, 'standard_20', 0, 0),
  (:'org_n', :'inv_n3', 1, 'Fee', 1, 30000, 'none', 0, 0);
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS1 no settings row: issuing is refused', format($$select public.issue_invoice(%L)$$, :'inv_n1'), 'denied(22023:invoice_settings_incomplete)');
reset role;
reset request.jwt.claims;
insert into public.invoice_settings (organisation_id, business_name, business_address, number_prefix, payment_terms_days)
  values (:'org_n', 'Numbering Ltd', '1 Number Street', 'NUM-', 14);
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS2 a draft with no recipient is refused', format($$select public.issue_invoice(%L)$$, :'inv_n3'), 'denied(22023:invoice_needs_a_recipient)');
select inv.val('IS3 THE FIRST ISSUE TAKES NUMBER 1, padded', format($$select public.issue_invoice(%L)$$, :'inv_n1'), 'NUM-0001');
select inv.val('IS4 ...the counter moved to 2', format($$select next_number::text from public.invoice_settings where organisation_id = %L$$, :'org_n'), '2');
select inv.val('IS5 ...the row is issued with UK dates, terms applied, VAT recomputed (not VAT registered: none)', format($$select concat_ws('|', status, number, (issue_date = (now() at time zone 'Europe/London')::date)::text, (supply_date = issue_date)::text, (due_date - issue_date)::text, net_minor, vat_minor, gross_minor) from public.invoices where id = %L$$, :'inv_n1'), 'issued|NUM-0001|true|true|14|10000|0|10000');
select inv.val('IS6 ...the line was recomputed to no VAT under an unregistered seller', format($$select vat_rate || '|' || net_minor || '|' || vat_minor from public.invoice_lines where invoice_id = %L$$, :'inv_n1'), 'none|10000|0');
select inv.val('IS7 ...the snapshot carries the number, no VAT number, the recipient and the totals', format($$select concat_ws('|', snapshot ->> 'number', coalesce(snapshot -> 'seller' ->> 'vat_number', 'null'), snapshot -> 'recipient' ->> 'name', snapshot -> 'recipient' ->> 'email', snapshot -> 'totals' ->> 'gross_minor', (snapshot ->> 'due_date' = due_date::text)::text) from public.invoices where id = %L$$, :'inv_n1'), 'NUM-0001|null|Nina Number|nina@example.test|10000|true');
select inv.val('IS9 issuing it again is refused', format($$select public.issue_invoice(%L)$$, :'inv_n1'), 'denied(22023:invoice_not_a_draft)');
reset role;
reset request.jwt.claims;
select inv.val('IS8 ...and one invoice.issued audit row, actor the caller, payload {number, status} and no amount (read as postgres: audit_events is superuser-read)', format($$select count(distinct a.id) || '|' || bool_and(a.actor_user_id = %L)::text || '|' || max(a.after ->> 'number') || '|' || string_agg(k, ',' order by k) from public.audit_events a cross join lateral jsonb_object_keys(a.after) k where a.action = 'invoice.issued' and a.target_id = %L$$, :'fin_n', :'inv_n1'), '1|true|NUM-0001|number,status');
-- A ROLLED-BACK ISSUE CONSUMES NO NUMBER: issue inside a transaction, roll it back.
begin;
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', :'fin_n_c', true) \gset
select public.issue_invoice(:'inv_n2') as rolled_back_number \gset
rollback;
select inv.val('IS10 a rolled-back issue took a number inside its transaction', format($$select %L$$, :'rolled_back_number'), 'NUM-0002');
select inv.val('IS11 ...and after the rollback the counter is still 2 and the draft still a draft', format($$select (select next_number from public.invoice_settings where organisation_id = %L) || '|' || (select status from public.invoices where id = %L)$$, :'org_n', :'inv_n2'), '2|draft');
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS12 the next real issue takes 2 -- no gap', format($$select public.issue_invoice(%L)$$, :'inv_n2'), 'NUM-0002');
set request.jwt.claims = :'fin_a_c';
select inv.val('IS13 A''s Finance user cannot issue org_n''s draft (no existence oracle)', format($$select public.issue_invoice(%L)$$, :'inv_n3'), 'denied(42501:forbidden)');
select inv.val('IS14 ...nor an id that does not exist, with the same refusal', $$select public.issue_invoice(gen_random_uuid())$$, 'denied(42501:forbidden)');
select inv.val('IS15 VAT REGISTERED: A''s draft issues at A''s counter with its 20% intact', format($$select public.issue_invoice(%L)$$, :'inv_ad'), 'INV-0001');
select inv.val('IS16 ...its totals and its snapshot''s seller VAT number', format($$select concat_ws('|', net_minor, vat_minor, gross_minor, snapshot -> 'seller' ->> 'vat_number', snapshot -> 'lines' -> 0 ->> 'vat_rate') from public.invoices where id = %L$$, :'inv_ad'), '50000|10000|60000|GB123456789|standard_20');
set request.jwt.claims = :'mgr_a_c';
select inv.val('IS17 a Manager cannot issue', format($$select public.issue_invoice(%L)$$, :'inv_ad'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_s_c';
select inv.val('IS18 a STARTER workspace cannot issue', format($$select public.issue_invoice(%L)$$, :'inv_sd'), 'denied(42501:plan_does_not_include_invoicing)');
reset role;
reset request.jwt.claims;
-- The recipient soft-deleted after drafting (plan decision 7, Q251).
update public.invoices set recipient_contact_id = :'con_n', recipient_address = '1 Nina Way' where id = :'inv_n3';
update public.contacts set deleted_at = now() where id = :'con_n';
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS19 a draft whose recipient was deleted is refused, not issued', format($$select public.issue_invoice(%L)$$, :'inv_n3'), 'denied(22023:invoice_recipient_deleted)');
select inv.val('IS20 ...and is still a live draft (not soft-deleted with its recipient, Q251)', format($$select status || '|' || (deleted_at is null)::text from public.invoices where id = %L$$, :'inv_n3'), 'draft|true');
reset role;
reset request.jwt.claims;
update public.contacts set deleted_at = null where id = :'con_n';
delete from public.invoice_lines where invoice_id = :'inv_n3';
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS21 a draft with no lines is refused', format($$select public.issue_invoice(%L)$$, :'inv_n3'), 'denied(22023:invoice_has_no_lines)');
select inv.val('IS22 only authenticated may execute issue_invoice', $$select has_function_privilege('authenticated', 'public.issue_invoice(uuid)', 'EXECUTE')::text || '/' || (has_function_privilege('anon', 'public.issue_invoice(uuid)', 'EXECUTE') or has_function_privilege('service_role', 'public.issue_invoice(uuid)', 'EXECUTE'))::text$$, 'true/false');
reset role;
reset request.jwt.claims;
-- Q255 default (a): two drafts may pull the same income entry; only one is issued.
insert into public.events (id, organisation_id, name, starts_at)
  values (:'ev_n', :'org_n', 'Numbering Night', now() + interval '10 days');
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description)
  values (:'fe_n', :'org_n', :'ev_n', 'income', 'budgeted', 7000, 'Door split');
insert into public.invoices (id, organisation_id, recipient_contact_id, recipient_address, event_id, created_by) values
  (:'inv_q1', :'org_n', :'con_n', '1 Nina Way', :'ev_n', :'fin_n'),
  (:'inv_q2', :'org_n', :'con_n', '1 Nina Way', :'ev_n', :'fin_n');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor, financial_entry_id) values
  (:'org_n', :'inv_q1', 1, 'Door split', 1, 7000, 'none', 7000, 0, :'fe_n'),
  (:'org_n', :'inv_q2', 1, 'Door split', 1, 7000, 'none', 7000, 0, :'fe_n');
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS23 POSITIVE CONTROL (Q255): a draft whose entry is also on another DRAFT issues', format($$select public.issue_invoice(%L)$$, :'inv_q1'), 'NUM-0003');
select inv.val('IS24 Q255: the other draft, its entry now on a live ISSUED invoice, is refused', format($$select public.issue_invoice(%L)$$, :'inv_q2'), 'denied(22023:invoice_entry_already_invoiced)');
select inv.val('IS25 ...and the refusal consumed no number and left a draft', format($$select (select next_number from public.invoice_settings where organisation_id = %L) || '|' || (select status from public.invoices where id = %L)$$, :'org_n', :'inv_q2'), '4|draft');
reset role;
reset request.jwt.claims;
update public.invoices set status = 'paid', paid_on = current_date, paid_by = :'fin_n' where id = :'inv_q1';
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS26 Q255: ...and still refused once that invoice is PAID', format($$select public.issue_invoice(%L)$$, :'inv_q2'), 'denied(22023:invoice_entry_already_invoiced)');
reset role;
reset request.jwt.claims;
update public.invoices set status = 'void', voided_at = now(), voided_by = :'fin_n', void_reason = 'Probe void' where id = :'inv_q1';
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS27 POSITIVE CONTROL (Q255): once that invoice is VOID, the draft issues', format($$select public.issue_invoice(%L)$$, :'inv_q2'), 'NUM-0004');
reset role;
reset request.jwt.claims;
-- Issue re-applies save's live-income rule: the pulled entry changed after the save.
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description)
  values (:'fe_n2', :'org_n', :'ev_n', 'income', 'budgeted', 5000, 'Bar split');
insert into public.invoices (id, organisation_id, recipient_contact_id, recipient_address, event_id, created_by)
  values (:'inv_q3', :'org_n', :'con_n', '1 Nina Way', :'ev_n', :'fin_n');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor, financial_entry_id)
  values (:'org_n', :'inv_q3', 1, 'Bar split', 1, 5000, 'none', 5000, 0, :'fe_n2');
update public.financial_entries set deleted_at = now() where id = :'fe_n2';
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS28 a draft whose pulled entry was DELETED after the save is refused', format($$select public.issue_invoice(%L)$$, :'inv_q3'), 'denied(22023:invoice_entry_not_invoiceable)');
select inv.val('IS29 ...and the refusal consumed no number and left a draft', format($$select (select next_number from public.invoice_settings where organisation_id = %L) || '|' || (select status from public.invoices where id = %L)$$, :'org_n', :'inv_q3'), '5|draft');
reset role;
reset request.jwt.claims;
update public.financial_entries set deleted_at = null, category = 'cost' where id = :'fe_n2';
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS30 ...nor once it is live again but RE-CATEGORISED as a cost', format($$select public.issue_invoice(%L)$$, :'inv_q3'), 'denied(22023:invoice_entry_not_invoiceable)');
reset role;
reset request.jwt.claims;
update public.financial_entries set category = 'income' where id = :'fe_n2';
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS31 POSITIVE CONTROL: live income on the event again, the draft issues', format($$select public.issue_invoice(%L)$$, :'inv_q3'), 'NUM-0005');
reset role;
reset request.jwt.claims;

-- ...and its event clause: the pulled entry MOVED to another event after the save.
\o /dev/null
select gen_random_uuid()::text as ev_n2 \gset
select gen_random_uuid()::text as fe_n3 \gset
select gen_random_uuid()::text as inv_q4 \gset
\o
insert into public.events (id, organisation_id, name, starts_at)
  values (:'ev_n2', :'org_n', 'Numbering Matinee', now() + interval '11 days');
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description)
  values (:'fe_n3', :'org_n', :'ev_n', 'income', 'budgeted', 4000, 'Cloakroom split');
insert into public.invoices (id, organisation_id, recipient_contact_id, recipient_address, event_id, created_by)
  values (:'inv_q4', :'org_n', :'con_n', '1 Nina Way', :'ev_n', :'fin_n');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor, financial_entry_id)
  values (:'org_n', :'inv_q4', 1, 'Cloakroom split', 1, 4000, 'none', 4000, 0, :'fe_n3');
update public.financial_entries set event_id = :'ev_n2' where id = :'fe_n3';
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS32 a draft whose pulled entry MOVED to another event after the save is refused', format($$select public.issue_invoice(%L)$$, :'inv_q4'), 'denied(22023:invoice_entry_not_invoiceable)');
reset role;
reset request.jwt.claims;
update public.financial_entries set event_id = :'ev_n' where id = :'fe_n3';
set role authenticated;
set request.jwt.claims = :'fin_n_c';
select inv.val('IS33 POSITIVE CONTROL: moved back onto the invoice''s event, the draft issues', format($$select public.issue_invoice(%L)$$, :'inv_q4'), 'NUM-0006');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § IP MARK PAID (Task 6, 20261107003000)
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as ev_d \gset
select gen_random_uuid()::text as fe_d \gset
\o
insert into public.events (id, organisation_id, name, starts_at)
  values (:'ev_d', :'org_a', 'Alpha Cancelled Night', now() + interval '20 days');
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description)
  values (:'fe_d', :'org_a', :'ev_d', 'income', 'budgeted', 5000, 'Deposit');
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select public.save_invoice_draft(:'org_a', null, null, :'con_a', :'ev_a', '9 Customer Road, London', null, null,
  jsonb_build_array(
    jsonb_build_object('description', 'Box office guarantee', 'quantity', '1.00', 'unit_price_minor', 300000, 'vat_rate', 'standard_20', 'financial_entry_id', :'fe_a'),
    jsonb_build_object('description', 'Production fee', 'quantity', '2.00', 'unit_price_minor', 15000, 'vat_rate', 'standard_20', 'financial_entry_id', null))) as id_p \gset
select public.issue_invoice(:'id_p') as num_p \gset
select public.save_invoice_draft(:'org_a', null, null, :'con_a', :'ev_d', '9 Customer Road, London', null, null,
  jsonb_build_array(jsonb_build_object('description', 'Deposit', 'quantity', '1.00', 'unit_price_minor', 5000, 'vat_rate', 'standard_20', 'financial_entry_id', :'fe_d'))) as id_pd \gset
select public.issue_invoice(:'id_pd') as num_pd \gset
select inv.val('IP1 FIXTURE: the pulled-line invoice issued at A''s next number', format($$select %L || '|' || gross_minor from public.invoices where id = %L$$, :'num_p', :'id_p'), 'INV-0002|396000');
select inv.val('IP2 a payment date in the future is refused', format($$select 'ok' from (select public.mark_invoice_paid(%L, ((now() at time zone 'Europe/London')::date + 1))) s$$, :'id_p'), 'denied(22023:invoice_paid_on_out_of_range)');
select inv.val('IP3 a payment date before the issue date is refused', format($$select 'ok' from (select public.mark_invoice_paid(%L, ((now() at time zone 'Europe/London')::date - 1))) s$$, :'id_p'), 'denied(22023:invoice_paid_on_out_of_range)');
select inv.val('IP4 a null payment date is refused', format($$select 'ok' from (select public.mark_invoice_paid(%L, null)) s$$, :'id_p'), 'denied(22023:invoice_paid_on_out_of_range)');
select inv.val('IP17 A''s Finance user cannot mark B''s invoice paid (no existence oracle)', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'inv_bd'), 'denied(42501:forbidden)');
select inv.val('IP18 ...nor an id that names nothing, with the same refusal', $$select 'ok' from (select public.mark_invoice_paid(gen_random_uuid(), (now() at time zone 'Europe/London')::date)) s$$, 'denied(42501:forbidden)');
select inv.val('IP5 THE PAYMENT: the Finance user marks it paid today', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'id_p'), 'ok');
select inv.val('IP6 ...it is paid, dated, by the caller', format($$select status || '|' || (paid_on = (now() at time zone 'Europe/London')::date)::text || '|' || (paid_by = %L)::text from public.invoices where id = %L$$, :'fin_a', :'id_p'), 'paid|true|true');
select inv.val('IP7 ...the pulled entry flipped budgeted -> actual, its amount left as it was', format($$select status || '|' || amount_minor from public.financial_entries where id = %L$$, :'fe_a'), 'actual|300000');
select inv.val('IP8 ...and its line records the flip', format($$select string_agg(position || ':' || entry_flipped::text, ',' order by position) from public.invoice_lines where invoice_id = %L$$, :'id_p'), '1:true,2:false');
select inv.val('IP9 ...the free line''s NET (not gross) became one actual income entry on the event, named for the invoice', format($$select concat_ws('|', fe.category, fe.status, fe.amount_minor, fe.description, (fe.occurred_on = i.paid_on)::text, (fe.event_id = %L)::text) from public.invoices i join public.financial_entries fe on fe.id = i.paid_entry_id where i.id = %L$$, :'ev_a', :'id_p'), 'income|actual|30000|Invoice INV-0002|true|true');
select paid_entry_id::text as pe_p from public.invoices where id = :'id_p' \gset
-- Q255 extended (Task 5 review I3): the income entry mark-paid booked belongs
-- to that paid invoice, so no other invoice may pull it and bill it again.
select inv.val('IP19 Q255: a draft cannot pull the income entry a PAID invoice booked', format($$select 'ok' from (select public.save_invoice_draft(%L, null, null, %L, %L, '9 Customer Road, London', null, null, jsonb_build_array(jsonb_build_object('description', 'Rebill', 'quantity', '1.00', 'unit_price_minor', 30000, 'vat_rate', 'standard_20', 'financial_entry_id', %L)))) s$$, :'org_a', :'con_a', :'ev_a', :'pe_p'), 'denied(22023:invoice_entry_already_invoiced)');
select inv.val('IP20 POSITIVE CONTROL: the same save pulling a live income entry that is no invoice''s booked payment is accepted', format($$select 'ok' from (select public.save_invoice_draft(%L, null, null, %L, %L, '9 Customer Road, London', null, null, jsonb_build_array(jsonb_build_object('description', 'Rebill', 'quantity', '1.00', 'unit_price_minor', 30000, 'vat_rate', 'standard_20', 'financial_entry_id', %L)))) s$$, :'org_a', :'con_a', :'ev_a', :'fe_a'), 'ok');
select inv.val('IP11 marking it paid twice is refused', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'id_p'), 'denied(22023:invoice_not_issued)');
reset role;
reset request.jwt.claims;
select inv.val('IP10 ...and one invoice.marked_paid audit row, actor the caller, saying one entry flipped and one created; payload keys exactly {entries_flipped, income_entry_created, number, status}: NO paid_on and no amount (read as postgres: audit_events is superuser-read)', format($$select count(distinct a.id) || '|' || bool_and(a.actor_user_id = %L)::text || '|' || max(a.after ->> 'entries_flipped') || '|' || max(a.after ->> 'income_entry_created') || '|' || string_agg(k, ',' order by k) from public.audit_events a cross join lateral jsonb_object_keys(a.after) k where a.action = 'invoice.marked_paid' and a.target_id = %L$$, :'fin_a', :'id_p'), '1|true|1|true|entries_flipped,income_entry_created,number,status');
\o /dev/null
select gen_random_uuid()::text as inv_pq \gset
\o
insert into public.invoices (id, organisation_id, recipient_contact_id, recipient_address, event_id, created_by)
  values (:'inv_pq', :'org_a', :'con_a', '9 Customer Road, London', :'ev_a', :'fin_a');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor, financial_entry_id)
  values (:'org_a', :'inv_pq', 1, 'Rebill', 1, 30000, 'standard_20', 30000, 6000, :'pe_p');
update public.events set deleted_at = now() where id = :'ev_d';
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select inv.val('IP12 an invoice whose event was deleted can still be marked paid', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'id_pd'), 'ok');
select inv.val('IP21 Q255: a draft written past the save that pulls a PAID invoice''s booked entry is refused at issue', format($$select public.issue_invoice(%L)$$, :'inv_pq'), 'denied(22023:invoice_entry_already_invoiced)');
reset role;
reset request.jwt.claims;
select inv.val('IP13 ...and touches no finance (plan decision 6): the entry stays budgeted, its line unflipped, nothing created (read as postgres)', format($$select (select status from public.financial_entries where id = %L) || '|' || coalesce((select paid_entry_id::text from public.invoices where id = %L), 'none') || '|' || (select string_agg(entry_flipped::text, ',') from public.invoice_lines where invoice_id = %L)$$, :'fe_d', :'id_pd', :'id_pd'), 'budgeted|none|false');
set role authenticated;
set request.jwt.claims = :'mgr_a_c';
select inv.val('IP14 a Manager cannot mark an invoice paid', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'inv_ad'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_s_c';
select inv.val('IP15 a STARTER workspace cannot mark an invoice paid', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'inv_sd'), 'denied(42501:plan_does_not_include_invoicing)');
set request.jwt.claims = :'fin_n_c';
select inv.val('IP16 a DRAFT cannot be marked paid', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'inv_n3'), 'denied(22023:invoice_not_issued)');

-- ===========================================================================
-- § IV VOID (Task 6, 20261107003000)
-- ===========================================================================
set request.jwt.claims = :'fin_a_c';
select inv.val('IV1 a blank reason is refused', format($$select 'ok' from (select public.void_invoice(%L, '   ')) s$$, :'id_p'), 'denied(22023:invoice_void_reason_required)');
select inv.val('IV2 a 501-character reason is refused', format($$select 'ok' from (select public.void_invoice(%L, repeat('x', 501))) s$$, :'id_p'), 'denied(22023:invoice_void_reason_required)');
select inv.val('IV14 A''s Finance user cannot void B''s invoice (no existence oracle)', format($$select 'ok' from (select public.void_invoice(%L, 'x')) s$$, :'inv_bd'), 'denied(42501:forbidden)');
select inv.val('IV15 ...nor an id that names nothing, with the same refusal', $$select 'ok' from (select public.void_invoice(gen_random_uuid(), 'x')) s$$, 'denied(42501:forbidden)');
select inv.val('IV3 THE VOID OF A PAID INVOICE', format($$select 'ok' from (select public.void_invoice(%L, 'Wrong recipient')) s$$, :'id_p'), 'ok');
select inv.val('IV4 ...the flipped entry is budgeted again', format($$select status from public.financial_entries where id = %L$$, :'fe_a'), 'budgeted');
select inv.val('IV5 ...the income entry mark-paid created is soft-deleted', format($$select (fe.deleted_at is not null)::text from public.invoices i join public.financial_entries fe on fe.id = i.paid_entry_id where i.id = %L$$, :'id_p'), 'true');
select inv.val('IV6 ...the invoice is void, KEEPS its number and its payment record, with the reason', format($$select concat_ws('|', status, number, (paid_on is not null)::text, void_reason, (voided_by = %L)::text) from public.invoices where id = %L$$, :'fin_a', :'id_p'), 'void|INV-0002|true|Wrong recipient|true');
select inv.val('IV8 voiding it again is refused', format($$select 'ok' from (select public.void_invoice(%L, 'again')) s$$, :'id_p'), 'denied(22023:invoice_not_voidable)');
select inv.val('IV9 an ISSUED (unpaid) invoice voids too, touching no finance', format($$select 'ok' from (select public.void_invoice(%L, 'Duplicate')) s$$, :'inv_ai'), 'ok');
select inv.val('IV10 ...it is void with its number', format($$select status || '|' || number from public.invoices where id = %L$$, :'inv_ai'), 'void|FIX-0001');
set request.jwt.claims = :'mgr_a_c';
select inv.val('IV11 a Manager cannot void', format($$select 'ok' from (select public.void_invoice(%L, 'x')) s$$, :'inv_ad'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_n_c';
select inv.val('IV12 a DRAFT cannot be voided (it is deleted instead)', format($$select 'ok' from (select public.void_invoice(%L, 'x')) s$$, :'inv_n3'), 'denied(22023:invoice_not_voidable)');
select inv.val('IV13 only authenticated may execute the two RPCs', $$select count(*) filter (where has_function_privilege('authenticated', f, 'EXECUTE')) || '/' || count(*) filter (where has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('service_role', f, 'EXECUTE')) from unnest(array['public.mark_invoice_paid(uuid,date)','public.void_invoice(uuid,text)']) f$$, '2/0');
reset role;
reset request.jwt.claims;
select inv.val('IV7 ...one invoice.voided audit row with the reversal counts, payload keys exactly {entries_reverted, income_entry_removed, number, previous_status, status}, the reason NOT in it (read as postgres)', format($$select count(distinct a.id) || '|' || max(a.after ->> 'previous_status') || '|' || max(a.after ->> 'entries_reverted') || '|' || max(a.after ->> 'income_entry_removed') || '|' || bool_and(coalesce(a.after::text, '') not like '%%Wrong recipient%%')::text || '|' || string_agg(k, ',' order by k) from public.audit_events a cross join lateral jsonb_object_keys(a.after) k where a.action = 'invoice.voided' and a.target_id = %L$$, :'id_p'), '1|paid|1|true|true|entries_reverted,income_entry_removed,number,previous_status,status');

-- A void invoice frees its booked entry; restored by hand, it can be billed.
update public.financial_entries set deleted_at = null where id = :'pe_p';
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select inv.val('IP22 POSITIVE CONTROL (Q255): once that invoice is VOID (and its entry live), the same draft issues', format($$select public.issue_invoice(%L)$$, :'inv_pq'), 'INV-0004');
reset role;
reset request.jwt.claims;

-- Task 6 review I1/m1: mark-paid flips only an entry that is still live
-- budgeted income on the invoice's event (Q257). Three pulled lines: one
-- re-categorised to a cost after the issue, one moved to another event, one
-- already actual. Each goes unflipped, and void leaves all three as they were.
\o /dev/null
select gen_random_uuid()::text as ev_m \gset
select gen_random_uuid()::text as fe_c \gset
select gen_random_uuid()::text as fe_m \gset
select gen_random_uuid()::text as fe_x \gset
\o
insert into public.events (id, organisation_id, name, starts_at)
  values (:'ev_m', :'org_a', 'Alpha Matinee', now() + interval '21 days');
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description) values
  (:'fe_c', :'org_a', :'ev_a', 'income', 'budgeted', 1000, 'Merch split'),
  (:'fe_m', :'org_a', :'ev_a', 'income', 'budgeted', 2000, 'Bar split'),
  (:'fe_x', :'org_a', :'ev_a', 'income', 'actual',   3000, 'Deposit received');
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select public.save_invoice_draft(:'org_a', null, null, :'con_a', :'ev_a', '9 Customer Road, London', null, null,
  jsonb_build_array(
    jsonb_build_object('description', 'Merch split', 'quantity', '1.00', 'unit_price_minor', 1000, 'vat_rate', 'standard_20', 'financial_entry_id', :'fe_c'),
    jsonb_build_object('description', 'Bar split', 'quantity', '1.00', 'unit_price_minor', 2000, 'vat_rate', 'standard_20', 'financial_entry_id', :'fe_m'),
    jsonb_build_object('description', 'Deposit', 'quantity', '1.00', 'unit_price_minor', 3000, 'vat_rate', 'standard_20', 'financial_entry_id', :'fe_x'))) as id_pm \gset
select public.issue_invoice(:'id_pm') as num_pm \gset
reset role;
reset request.jwt.claims;
update public.financial_entries set category = 'cost' where id = :'fe_c';
update public.financial_entries set event_id = :'ev_m' where id = :'fe_m';
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select inv.val('IP23 an invoice whose pulled entries are no longer flippable is still marked paid', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'id_pm'), 'ok');
select inv.val('IP24 Q257: the entry re-categorised as a cost and the one moved to another event stay budgeted, their lines unflipped', format($$select (select status from public.financial_entries where id = %L) || '|' || (select status from public.financial_entries where id = %L) || '|' || (select string_agg(position || ':' || entry_flipped::text, ',' order by position) from public.invoice_lines where invoice_id = %L and position in (1, 2))$$, :'fe_c', :'fe_m', :'id_pm'), 'budgeted|budgeted|1:false,2:false');
select inv.val('IP25 the entry already actual is not flipped, and nothing is booked (every line was pulled)', format($$select (select entry_flipped::text from public.invoice_lines where invoice_id = %1$L and position = 3) || '|' || (select coalesce(paid_entry_id::text, 'none') from public.invoices where id = %1$L)$$, :'id_pm'), 'false|none');
select inv.val('IV16 that paid invoice voids', format($$select 'ok' from (select public.void_invoice(%L, 'Reissue')) s$$, :'id_pm'), 'ok');
select inv.val('IV17 ...and the void reverts nothing mark-paid did not do: the already-actual entry is still actual, the other two still budgeted', format($$select (select status from public.financial_entries where id = %L) || '|' || (select status from public.financial_entries where id = %L) || '|' || (select status from public.financial_entries where id = %L)$$, :'fe_x', :'fe_c', :'fe_m'), 'actual|budgeted|budgeted');
select inv.val('IP26 STATIC PIN (m2): every RPC that locks pulled entries locks them in id order, so none deadlocks another', $$select count(*)::text from unnest(array['public.mark_invoice_paid(uuid,date)', 'public.void_invoice(uuid,text)', 'public.issue_invoice(uuid)']) f where pg_get_functiondef(f::regprocedure) ~ 'order by fe\.id\s+for (no key update|share)'$$, '3');
reset role;
reset request.jwt.claims;

-- Task 6 review m3: a SUSPENDED workspace is read-only (organisations.deleted_at,
-- the flag every gate reads): neither RPC changes an invoice there, and both
-- work again once it is reinstated.
set role authenticated;
set request.jwt.claims = :'fin_b_c';
select public.save_invoice_draft(:'org_b', null, null, :'con_b', null, '7 Buyer Street', null, null,
  '[{"description":"Hire","quantity":"1.00","unit_price_minor":5000,"vat_rate":"none","financial_entry_id":null}]'::jsonb) as id_sb \gset
select public.issue_invoice(:'id_sb') as num_sb \gset
reset role;
reset request.jwt.claims;
update public.organisations set deleted_at = now() where id = :'org_b';
set role authenticated;
set request.jwt.claims = :'fin_b_c';
select inv.val('IP27 a SUSPENDED workspace cannot mark an invoice paid', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'id_sb'), 'denied(42501:forbidden)');
select inv.val('IV18 ...nor void one', format($$select 'ok' from (select public.void_invoice(%L, 'x')) s$$, :'id_sb'), 'denied(42501:forbidden)');
reset role;
reset request.jwt.claims;
update public.organisations set deleted_at = null where id = :'org_b';
set role authenticated;
set request.jwt.claims = :'fin_b_c';
select inv.val('IP28 POSITIVE CONTROL: reinstated, the same invoice is marked paid', format($$select 'ok' from (select public.mark_invoice_paid(%L, (now() at time zone 'Europe/London')::date)) s$$, :'id_sb'), 'ok');
select inv.val('IV19 POSITIVE CONTROL: ...and voided', format($$select 'ok' from (select public.void_invoice(%L, 'x')) s$$, :'id_sb'), 'ok');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § IE AN ERASED ACCOUNT'S INVOICES (Task 6): private.erase_account()'s
-- derived re-point moves created_by / paid_by / voided_by / sent_by to the
-- tombstone, the freeze admits no other re-point of a payer or a voider, and
-- the issued snapshot is untouched (legal-obligation basis).
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as fin_e \gset
select gen_random_uuid()::text as own_e \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_e') as fin_e_c \gset
\o
-- org_b gains an Owner: erase_account refuses to leave a workspace with
-- members and data but no Owner (workspace_has_no_owner, Q131).
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values (:'fin_e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inv-fin-e-' || :'fin_e' || '@test.local', now(), now(), now()),
         (:'own_e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inv-own-e-' || :'own_e' || '@test.local', now(), now(), now());
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
  values (:'org_b', :'fin_e', 'finance', 'active', now()), (:'org_b', :'own_e', 'owner', 'active', now());
set role authenticated;
set request.jwt.claims = :'fin_e_c';
select public.save_invoice_draft(:'org_b', null, null, :'con_b', null, '7 Buyer Street', null, null,
  '[{"description":"Hire","quantity":"1.00","unit_price_minor":7000,"vat_rate":"none","financial_entry_id":null}]'::jsonb) as id_e \gset
select public.issue_invoice(:'id_e') as num_e \gset
select 'ok' as paid_e from (select public.mark_invoice_paid(:'id_e', (now() at time zone 'Europe/London')::date)) s \gset
select 'ok' as void_e from (select public.void_invoice(:'id_e', 'Erasure probe')) s \gset
reset role;
reset request.jwt.claims;
insert into public.invoice_sends (organisation_id, invoice_id, to_email, sent_by) values (:'org_b', :'id_e', 'bea@example.test', :'fin_e');
select md5(snapshot::text) as snap_e from public.invoices where id = :'id_e' \gset
select inv.val('IE1 a void invoice''s PAYER cannot be re-pointed at another person (as postgres)', format($$update public.invoices set paid_by = %L where id = %L returning 'written'$$, :'fin_b', :'id_e'), 'denied(42501:invoice_is_frozen)');
select inv.val('IE2 ...nor its VOIDER', format($$update public.invoices set voided_by = %L where id = %L returning 'written'$$, :'fin_b', :'id_e'), 'denied(42501:invoice_is_frozen)');
select inv.val('IE3 POSITIVE CONTROL: the payer -> tombstone re-point alone is admitted (rolled back)', format($$select inv.violated(%L)$$, format('update public.invoices set paid_by = private.erased_user_id() where id = %L', :'id_e')), 'written');
select inv.val('IE4 POSITIVE CONTROL: the voider -> tombstone re-point alone is admitted (rolled back)', format($$select inv.violated(%L)$$, format('update public.invoices set voided_by = private.erased_user_id() where id = %L', :'id_e')), 'written');
select inv.val('IE5 the account erasure runs over a person who created, paid, voided and sent an invoice', format($$select 'ok' from (select private.erase_account(%L, null)) s$$, :'fin_e'), 'ok');
select inv.val('IE6 ...creator, payer, voider and sender are all the tombstone now', format($$select concat_ws('|', (i.created_by = private.erased_user_id())::text, (i.paid_by = private.erased_user_id())::text, (i.voided_by = private.erased_user_id())::text, (select bool_and(s.sent_by = private.erased_user_id()) from public.invoice_sends s where s.invoice_id = i.id)::text) from public.invoices i where i.id = %L$$, :'id_e'), 'true|true|true|true');
select inv.val('IE7 ...and the issued snapshot is byte-identical', format($$select (md5(snapshot::text) = %L)::text || '|' || status from public.invoices where id = %L$$, :'snap_e', :'id_e'), 'true|void');
select inv.val('IE8 no invoice audit payload names the erased person', format($$select count(*)::text from public.audit_events where (action like 'invoice.%%' or action like 'invoice_settings.%%') and (coalesce(before::text, '') || coalesce(after::text, '')) like '%%' || %L || '%%'$$, :'fin_e'), '0');

-- ===========================================================================
-- § IX SETTINGS (Task 7, 20261107004000)
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select inv.val('IX1 changing the bank account returns true (the bank changed)', format($$select public.save_invoice_settings(%L, 'Alpha Promotions Ltd', '1 Alpha Street, London', 'GB123456789', 'Alpha Promotions Ltd', '654321', '87654321', 'INV-', 30)::text$$, :'org_a'), 'true');
select inv.val('IX2 ...stored, and next_number untouched by a save (Tasks 5-6 issued five)', format($$select bank_sort_code || '|' || bank_account_number || '|' || next_number from public.invoice_settings where organisation_id = %L$$, :'org_a'), '654321|87654321|6');
select inv.val('IX6 saving the business name alone returns false (no bank field changed)', format($$select public.save_invoice_settings(%L, 'Alpha Promotions Limited', '1 Alpha Street, London', 'GB123456789', 'Alpha Promotions Ltd', '654321', '87654321', 'INV-', 30)::text$$, :'org_a'), 'false');
select inv.val('IX7 saving nothing new returns false too', format($$select public.save_invoice_settings(%L, 'Alpha Promotions Limited', '1 Alpha Street, London', 'GB123456789', 'Alpha Promotions Ltd', '654321', '87654321', 'INV-', 30)::text$$, :'org_a'), 'false');
select inv.val('IX8 an invalid sort code is refused with the settings hint', format($$select public.save_invoice_settings(%L, 'A', 'B', null, 'N', '12-34', '12345678', 'INV-', 30)::text$$, :'org_a'), 'denied(22023:invoice_settings_invalid)');
select inv.val('IX9 B''s settings cannot be saved by A''s Finance user', format($$select public.save_invoice_settings(%L, 'A', 'B', null, null, null, null, 'INV-', 30)::text$$, :'org_b'), 'denied(42501:forbidden)');
set request.jwt.claims = :'mgr_a_c';
select inv.val('IX10 a Manager cannot save settings', format($$select public.save_invoice_settings(%L, 'A', 'B', null, null, null, null, 'INV-', 30)::text$$, :'org_a'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_s_c';
select inv.val('IX11 a STARTER workspace cannot save settings', format($$select public.save_invoice_settings(%L, 'A', 'B', null, null, null, null, 'INV-', 30)::text$$, :'org_s'), 'denied(42501:plan_does_not_include_invoicing)');
reset role;
reset request.jwt.claims;
-- The audit log is superuser-readable only, so it is read as postgres.
select inv.val('IX3 two invoice_settings.changed rows, naming columns only: the bank save, then the name save (the no-op save wrote none)', format($$select count(*) || '|' || string_agg(after ->> 'changed', ';' order by created_at, id) from public.audit_events where action = 'invoice_settings.changed' and organisation_id = %L$$, :'org_a'), '2|["bank_account_number", "bank_sort_code"];["business_name"]');
select inv.val('IX4 ONE bank_details_changed row (the name and no-op saves wrote none): exact key set {changed}, the bank column names, no digit anywhere', format($$select count(*) || '|' || string_agg((select string_agg(k, ',' order by k) from jsonb_object_keys(after) k), ';') || '|' || max(after ->> 'changed') || '|' || bool_and(before is null and after::text !~ '[0-9]')::text from public.audit_events where action = 'invoice_settings.bank_details_changed' and organisation_id = %L$$, :'org_a'), '1|changed|["bank_account_number", "bank_sort_code"]|true');
select inv.val('IX5 ...and no audit row anywhere carries the full account number', $$select count(*)::text from public.audit_events where (coalesce(before::text, '') || coalesce(after::text, '')) like '%87654321%'$$, '0');

-- ===========================================================================
-- § IQ THE BANK-CHANGE NOTICE QUEUE (Task 7). Read and stamped by the sender
-- (service_role, no person on the session), never by a person.
-- ===========================================================================
select id as bank_audit from public.audit_events where action = 'invoice_settings.bank_details_changed' and organisation_id = :'org_a' \gset
select id as issued_audit from public.audit_events where action = 'invoice.issued' and organisation_id = :'org_a' limit 1 \gset
set role service_role;
select inv.val('IQ1 the sender sees the change, addressed to A''s current Owner and Admin only, with the CURRENT account''s last four', format($$select count(*) || '|' || max(cardinality(emails)) || '|' || bool_and(emails @> array[%L, %L]::text[])::text || '|' || max(account_last4) from public.pending_invoice_bank_change_notifications(30) where audit_event_id = %L$$, 'inv-own-a-' || :'own_a' || '@test.local', 'inv-adm-a-' || :'adm_a' || '@test.local', :'bank_audit'), '1|2|true|4321');
select inv.val('IQ2 a stamp on a row of another action writes nothing', format($$select public.mark_notices_delivered('invoice_bank_details_changed', array[%L]::uuid[])::text$$, :'issued_audit'), '0');
select inv.val('IQ3 the stamp on the bank-change row writes one ledger row', format($$select public.mark_notices_delivered('invoice_bank_details_changed', array[%L]::uuid[])::text$$, :'bank_audit'), '1');
select inv.val('IQ4 ...and the row leaves the queue', format($$select count(*)::text from public.pending_invoice_bank_change_notifications(30) where audit_event_id = %L$$, :'bank_audit'), '0');
select inv.val('IQ5 the undeliverable branch accepts the notice too (idempotent on the same row)', format($$select public.mark_notices_undeliverable('invoice_bank_details_changed', array[%L]::uuid[], 'no_recipient')::text$$, :'bank_audit'), '0');
select inv.val('IQ6 REGRESSION: the existing notices are still accepted', $$select public.mark_notices_delivered('workspace_closed', array[gen_random_uuid()]::uuid[])::text$$, '0');
reset role;
-- As postgres (which may execute it) but WITH a person on the session: the
-- body's own guard must refuse. (authenticated holds no EXECUTE at all, IQ8.)
set request.jwt.claims = :'own_a_c';
select inv.val('IQ7 a person''s session cannot read the queue, not even the Owner''s', $$select count(*)::text from public.pending_invoice_bank_change_notifications(30)$$, 'denied(42501:notification_stamp_is_server_only)');
reset request.jwt.claims;
select inv.val('IQ8 the resolver is service_role-only, the settings RPC authenticated-only', $$select concat_ws('|', has_function_privilege('service_role', 'public.pending_invoice_bank_change_notifications(integer)', 'EXECUTE')::text, has_function_privilege('authenticated', 'public.pending_invoice_bank_change_notifications(integer)', 'EXECUTE')::text, has_function_privilege('authenticated', 'public.save_invoice_settings(uuid,text,text,text,text,text,text,text,integer)', 'EXECUTE')::text, has_function_privilege('anon', 'public.save_invoice_settings(uuid,text,text,text,text,text,text,text,integer)', 'EXECUTE')::text)$$, 'true|false|true|false');

-- ===========================================================================
-- § IY THE PDF DOWNLOAD AUDIT (Task 10, 20261107005000)
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select inv.val('IY1 a Finance user''s download of a (void) invoice is recorded', format($$select 'ok' from (select public.audit_invoice_download(%L)) s$$, :'id_p'), 'ok');
-- Read as postgres: audit_events is superuser-read, so the Finance user
-- would see no row at all (the same reason § IS/IP/IV/IX read it so).
reset role;
select inv.val('IY2 ...as one invoice.pdf_downloaded row naming the number (read as postgres)', format($$select count(*) || '|' || max(after ->> 'number') from public.audit_events where action = 'invoice.pdf_downloaded' and target_id = %L$$, :'id_p'), '1|INV-0002');
set role authenticated;
select inv.val('IY3 an id that does not exist is refused like one that is not yours', $$select 'ok' from (select public.audit_invoice_download(gen_random_uuid())) s$$, 'denied(42501:forbidden)');
set request.jwt.claims = :'mgr_a_c';
select inv.val('IY4 a Manager (no view_finance) cannot download', format($$select 'ok' from (select public.audit_invoice_download(%L)) s$$, :'id_p'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_n_c';
select inv.val('IY5 a draft has no PDF', format($$select 'ok' from (select public.audit_invoice_download(%L)) s$$, :'inv_n3'), 'denied(22023:invoice_not_issued)');
reset role;
reset request.jwt.claims;
update public.organisation_subscriptions set plan_id = 'starter' where organisation_id = :'org_b';
set role authenticated;
set request.jwt.claims = :'fin_b_c';
select inv.val('IY6 DOWNGRADE: a workspace moved to Starter still downloads its invoices', format($$select 'ok' from (select public.audit_invoice_download(%L)) s$$, :'id_e'), 'ok');
reset role;
reset request.jwt.claims;
update public.organisation_subscriptions set plan_id = 'pro' where organisation_id = :'org_b';
select inv.val('IY7 only authenticated may execute audit_invoice_download', $$select has_function_privilege('authenticated', 'public.audit_invoice_download(uuid)', 'EXECUTE')::text || '/' || (has_function_privilege('anon', 'public.audit_invoice_download(uuid)', 'EXECUTE') or has_function_privilege('service_role', 'public.audit_invoice_download(uuid)', 'EXECUTE'))::text$$, 'true/false');

-- ===========================================================================
-- § IW SEND (Task 11, 20261107006000)
-- ===========================================================================
select inv.val('IW1 the invoice_send budget is 30 an hour, per user', $$select max_requests || '/' || window_seconds || '/' || subject_scope from public.rate_limit_policies where category = 'invoice_send'$$, '30/3600/user');
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select inv.val('IW2 a Finance user records a send of an issued invoice', format($$select (public.record_invoice_send(%L, 'ap@customer.example', 'brevo-123') is not null)::text$$, :'inv_ad'), 'true');
select inv.val('IW3 ...the send row names the address, the provider id and the sender', format($$select count(*) || '|' || bool_and(to_email = 'ap@customer.example' and provider_message_id = 'brevo-123' and sent_by = %L)::text from public.invoice_sends where invoice_id = %L$$, :'fin_a', :'inv_ad'), '1|true');
-- Read as postgres: audit_events is superuser-read (as § IY's IY2).
reset role;
select inv.val('IW4 ...one invoice.sent audit row with the number, and NOT the address (read as postgres)', format($$select count(*) || '|' || max(after ->> 'number') || '|' || bool_and(coalesce(after::text, '') not like '%%customer.example%%')::text from public.audit_events where action = 'invoice.sent' and target_id = %L$$, :'inv_ad'), '1|INV-0001|true');
set role authenticated;
select inv.val('IW5 a VOID invoice cannot be sent', format($$select public.record_invoice_send(%L, 'x@example.test', null)::text$$, :'id_p'), 'denied(22023:invoice_not_sendable)');
select inv.val('IW6 an address that is not one is refused', format($$select public.record_invoice_send(%L, 'not an address', null)::text$$, :'inv_ad'), 'denied(22023:invoice_send_email_invalid)');
set request.jwt.claims = :'fin_n_c';
select inv.val('IW7 a DRAFT cannot be sent', format($$select public.record_invoice_send(%L, 'x@example.test', null)::text$$, :'inv_n3'), 'denied(22023:invoice_not_sendable)');
set request.jwt.claims = :'mgr_a_c';
select inv.val('IW8 a Manager cannot record a send', format($$select public.record_invoice_send(%L, 'x@example.test', null)::text$$, :'inv_ad'), 'denied(42501:forbidden)');
reset role;
reset request.jwt.claims;
update public.organisation_subscriptions set plan_id = 'starter' where organisation_id = :'org_b';
set role authenticated;
set request.jwt.claims = :'fin_b_c';
select inv.val('IW9 a STARTER workspace cannot send (downgrade: read and download only)', format($$select public.record_invoice_send(%L, 'x@example.test', null)::text$$, :'id_e'), 'denied(42501:plan_does_not_include_invoicing)');
reset role;
reset request.jwt.claims;
update public.organisation_subscriptions set plan_id = 'pro' where organisation_id = :'org_b';
select inv.val('IW10 only authenticated may execute record_invoice_send', $$select has_function_privilege('authenticated', 'public.record_invoice_send(uuid,text,text)', 'EXECUTE')::text || '/' || (has_function_privilege('anon', 'public.record_invoice_send(uuid,text,text)', 'EXECUTE') or has_function_privilege('service_role', 'public.record_invoice_send(uuid,text,text)', 'EXECUTE'))::text$$, 'true/false');

-- ===========================================================================
-- § IZ HOUSEKEEPING (later tasks insert their sections ABOVE this line)
-- ===========================================================================
reset role;
reset request.jwt.claims;
-- ORIGIN mode, so the cascades run (and the freeze triggers admit them).
delete from public.organisations where id in (:'org_a', :'org_b', :'org_s', :'org_f', :'org_p', :'org_n');
set session_replication_role = replica;
delete from public.audit_events
 where organisation_id in (:'org_a', :'org_b', :'org_s', :'org_f', :'org_p', :'org_n')
    or actor_user_id in (:'own_a', :'adm_a', :'fin_a', :'mgr_a', :'ro_a', :'fin_b', :'fin_s', :'fin_f', :'fin_p', :'fin_n', :'own_e');
set session_replication_role = origin;
delete from auth.users where id in (:'own_a', :'adm_a', :'fin_a', :'mgr_a', :'ro_a', :'fin_b', :'fin_s', :'fin_f', :'fin_p', :'fin_n', :'own_e');
select inv.val('IZ1 housekeeping left no invoice row behind', format($$select ((select count(*) from public.invoices where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.invoice_settings where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)))::text$$, :'org_a', :'org_b', :'org_s', :'org_f', :'org_p'), '0');

\echo
\echo ==================== INVOICES ====================
select seq, label, expected, actual, pass from inv.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from inv.results;

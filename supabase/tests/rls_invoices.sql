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
select inv.val('IT3 authenticated holds NO write privilege on any of the four (24 checks, 0 held)', $$select count(*)::text || ' checks, ' || count(*) filter (where has_table_privilege('authenticated', t, p))::text || ' held' from unnest(array['public.invoice_settings','public.invoices','public.invoice_lines','public.invoice_sends']) t, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p$$, '24 checks, 0 held');
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
select inv.val('IT23 an issued row without a recipient address is refused by the issued shape', format($$update public.invoices set recipient_address = null where id = %L returning 'written'$$, :'inv_ai'), 'denied(42501:invoice_is_frozen)');

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
-- § IZ HOUSEKEEPING (later tasks insert their sections ABOVE this line)
-- ===========================================================================
reset role;
reset request.jwt.claims;
-- ORIGIN mode, so the cascades run (and the freeze triggers admit them).
delete from public.organisations where id in (:'org_a', :'org_b', :'org_s', :'org_f', :'org_p');
set session_replication_role = replica;
delete from public.audit_events
 where organisation_id in (:'org_a', :'org_b', :'org_s', :'org_f', :'org_p')
    or actor_user_id in (:'own_a', :'adm_a', :'fin_a', :'mgr_a', :'ro_a', :'fin_b', :'fin_s', :'fin_f', :'fin_p');
set session_replication_role = origin;
delete from auth.users where id in (:'own_a', :'adm_a', :'fin_a', :'mgr_a', :'ro_a', :'fin_b', :'fin_s', :'fin_f', :'fin_p');
select inv.val('IZ1 housekeeping left no invoice row behind', format($$select ((select count(*) from public.invoices where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)) + (select count(*) from public.invoice_settings where organisation_id in (%1$L, %2$L, %3$L, %4$L, %5$L)))::text$$, :'org_a', :'org_b', :'org_s', :'org_f', :'org_p'), '0');

\echo
\echo ==================== INVOICES ====================
select seq, label, expected, actual, pass from inv.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from inv.results;

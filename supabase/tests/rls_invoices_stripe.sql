-- ===========================================================================
-- INVOICES, PART 2 OF 3 -- STRIPE CONNECT (spec docs/superpowers/specs/2026-11-05-invoices-stripe-design.md).
--
-- Task 2 (20261110000000_stripe_tables.sql):
--   ST  the five public tables and private.stripe_link_states: RLS, grants
--   SR  who reads an account row and a card payment
--   SB  breakout: no client role writes any of the five tables
--   SP  invoices.paid_via and the rebuilt invoices_paid_shape / freeze
--   SC  the table constraints Tasks 3 and 4 rely on
--   SH  private.book_invoice_payment(), the shared booking helper
--   SF  private.application_fee_minor(), bound to lib/stripe/fee.ts
--   SK  the catalogues the tables and the new actions joined
--   SE  an erased account's Stripe link (linked_by) is re-pointed, not blocking
-- Later tasks add their sections ABOVE § SZ.
--
-- EVERY ASSERTION IS ONE LINE BEGINNING `select ist.val(`: run-rls-tests.sh's
-- pin is `grep -c '^select ist.val(' supabase/tests/rls_invoices_stripe.sql`.
-- Re-runnable on one database: every fixture is a fresh uuid, § SZ removes them.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists ist cascade;
create schema ist;

create table ist.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function ist.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into ist.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- Runs p_sql and records its single text result, or `denied(<sqlstate>:<hint>)`
-- when it raises. A refusal is ALWAYS a recorded row, never a psql ERROR line
-- (psql exits 0 on ERROR; run_suite counts both, and ON_ERROR_STOP halts here).
create function ist.val(p_label text, p_sql text, p_expected text)
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
  perform ist.record(p_label, p_expected, v_actual);
end $$;

-- Runs p_sql in a subtransaction that is ALWAYS rolled back, and answers which
-- CHECK (or unique index) refused it (`violates <constraint>`, `unique <name>`),
-- or `written` when none did. The constraint NAME is the point: denied(23514)
-- cannot tell the shape CHECKs apart. Any other error reaches ist.val as
-- denied(...).
create function ist.violated(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_name text;
begin
  begin
    execute p_sql;
    raise exception 'undo the probe row' using errcode = 'ISTOK';
  exception
    when sqlstate 'ISTOK' then return 'written';
    when check_violation then
      get stacked diagnostics v_name = constraint_name;
      return 'violates ' || v_name;
    when unique_violation then
      get stacked diagnostics v_name = constraint_name;
      return 'unique ' || v_name;
  end;
end $$;

grant usage on schema ist to authenticated, service_role;
grant execute on function ist.record(text,text,text) to authenticated, service_role;
grant execute on function ist.val(text,text,text)    to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- FIXTURES (as postgres)
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as fin_a \gset
select gen_random_uuid()::text as ro_a  \gset
select gen_random_uuid()::text as fin_b \gset
select gen_random_uuid()::text as fin_s \gset
select gen_random_uuid()::text as org_a \gset
select gen_random_uuid()::text as org_b \gset
select gen_random_uuid()::text as org_s \gset
select gen_random_uuid()::text as com_a \gset
select gen_random_uuid()::text as com_b \gset
select gen_random_uuid()::text as ev_a  \gset
select gen_random_uuid()::text as inv_ai \gset
select gen_random_uuid()::text as inv_ae \gset
select gen_random_uuid()::text as inv_bi \gset
select gen_random_uuid()::text as inv_ap \gset
select gen_random_uuid()::text as inv_ad \gset
select 'acct_A' || replace(gen_random_uuid()::text, '-', '') as acct_a \gset
select 'acct_S' || replace(gen_random_uuid()::text, '-', '') as acct_s \gset
select 'pi_A' || replace(gen_random_uuid()::text, '-', '') as pi_a \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_a') as fin_a_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'ro_a')  as ro_a_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_b') as fin_b_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_s') as fin_s_c \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
  from (values (:'fin_a'::uuid, 'ist-fin-a-' || :'fin_a' || '@test.local'),
               (:'ro_a'::uuid,  'ist-ro-a-'  || :'ro_a'  || '@test.local'),
               (:'fin_b'::uuid, 'ist-fin-b-' || :'fin_b' || '@test.local'),
               (:'fin_s'::uuid, 'ist-fin-s-' || :'fin_s' || '@test.local')) v(u, e);

insert into public.organisations (id, name, slug) values
  (:'org_a', 'Stripe Alpha',   'ist-alpha-'   || left(:'org_a', 8)),
  (:'org_b', 'Stripe Beta',    'ist-beta-'    || left(:'org_b', 8)),
  (:'org_s', 'Stripe Starter', 'ist-starter-' || left(:'org_s', 8));
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
select o, p, 'monthly', 4, 'active', now() + interval '30 days'
  from (values (:'org_a'::uuid, 'pro'), (:'org_b'::uuid, 'pro'), (:'org_s'::uuid, 'starter')) v(o, p)
on conflict (organisation_id) do update set plan_id = excluded.plan_id, status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_a', :'fin_a', 'finance',   'active', now()),
  (:'org_a', :'ro_a',  'read_only', 'active', now()),
  (:'org_b', :'fin_b', 'finance',   'active', now()),
  (:'org_s', :'fin_s', 'finance',   'active', now());

insert into public.companies (id, organisation_id, name) values
  (:'com_a', :'org_a', 'Alpha Customer Ltd'), (:'com_b', :'org_b', 'Beta Customer Ltd');
insert into public.events (id, organisation_id, name, starts_at)
  values (:'ev_a', :'org_a', 'Alpha Night', now() + interval '10 days');
insert into public.invoice_settings (organisation_id, business_name, business_address) values
  (:'org_a', 'Alpha Promotions Ltd', '1 Alpha Street, London'),
  (:'org_b', 'Beta Events', '2 Beta Road, Leeds'),
  (:'org_s', 'Starter Shows', '3 Starter Lane, Bristol');

-- Drafts first, then their lines; the issued ones are flipped AFTER their
-- lines exist (the line freeze refuses a line on an issued invoice). Each is
-- gross 12000 (net 10000 + 20% VAT 2000). inv_ae carries an event and one
-- free line, the shape private.book_invoice_payment books income for;
-- inv_ad stays a draft.
insert into public.invoices (id, organisation_id, recipient_company_id, event_id, recipient_address, created_by) values
  (:'inv_ai', :'org_a', :'com_a', null,     '8 Customer Road, London', :'fin_a'),
  (:'inv_ae', :'org_a', :'com_a', :'ev_a',  '8 Customer Road, London', :'fin_a'),
  (:'inv_ap', :'org_a', :'com_a', null,     '8 Customer Road, London', :'fin_a'),
  (:'inv_ad', :'org_a', :'com_a', null,     '8 Customer Road, London', :'fin_a'),
  (:'inv_bi', :'org_b', :'com_b', null,     '7 Buyer Street, Leeds',   :'fin_b');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity,
                                  unit_price_minor, vat_rate, net_minor, vat_minor)
select i.organisation_id, i.id, 1, 'Fee', 1.00, 10000, 'standard_20', 10000, 2000
  from public.invoices i where i.id in (:'inv_ai', :'inv_ae', :'inv_ap', :'inv_ad', :'inv_bi');
update public.invoices set net_minor = 10000, vat_minor = 2000, gross_minor = 12000
 where id in (:'inv_ai', :'inv_ae', :'inv_ap', :'inv_ad', :'inv_bi');
update public.invoices i
   set status = 'issued', number = v.n, issue_date = current_date, supply_date = current_date,
       due_date = current_date + 30,
       snapshot = private.build_invoice_snapshot(i.id, v.n, current_date, current_date, current_date + 30)
  from (values (:'inv_ai'::uuid, 'IST-0001'), (:'inv_ae'::uuid, 'IST-0002'),
               (:'inv_ap'::uuid, 'IST-0003'), (:'inv_bi'::uuid, 'IST-0001')) v(id, n)
 where i.id = v.id;

-- The account rows the read sections look at: A and B live, S ENDED (so
-- SC12's control can link its id elsewhere). Written as postgres: no client
-- role writes these tables.
insert into public.invoice_stripe_accounts (organisation_id, stripe_account_id, charges_enabled, linked_by, ended_at, ended_reason) values
  (:'org_a', :'acct_a', true,  :'fin_a', null, null),
  (:'org_b', 'acct_B' || replace(gen_random_uuid()::text, '-', ''),  true,  :'fin_b', null, null),
  (:'org_s', :'acct_s', false, :'fin_s', now(), 'disconnected');

-- ===========================================================================
-- § ST THE TABLES, THEIR GRANTS AND POLICIES (as postgres)
-- ===========================================================================
select ist.val('ST1 the five public tables exist', $$select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname in ('invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events')$$, '5');
select ist.val('ST2 RLS is enabled on all five', $$select string_agg(relname || '=' || relrowsecurity, ',' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relname in ('invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events')$$, 'invoice_card_payments=true,invoice_pay_sessions=true,invoice_stripe_accounts=true,stripe_events=true,stripe_platform_settings=true');
select ist.val('ST3 authenticated holds SELECT on the two readable tables and NOTHING on the other three', $$select string_agg(t || '=' || coalesce((select string_agg(p, '/' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where case when p in ('INSERT','UPDATE','REFERENCES') then has_any_column_privilege('authenticated', 'public.' || t, p) else has_table_privilege('authenticated', 'public.' || t, p) end), 'none'), ',' order by t) from unnest(array['invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events']) t$$, 'invoice_card_payments=SELECT,invoice_pay_sessions=none,invoice_stripe_accounts=SELECT,stripe_events=none,stripe_platform_settings=none');
select ist.val('ST4 anon holds NOTHING on any of the five, table- or column-level', $$select (count(*) filter (where has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))::text || '/' || (select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name in ('invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events') and grantee in ('anon','PUBLIC'))::text from unnest(array['invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events']) t$$, '0/0');
select ist.val('ST5 service_role holds NO table privilege on any of the five (only RPCs write them), table- or column-level', $$select (count(*) filter (where has_table_privilege('service_role', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))::text || '/' || (select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name in ('invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events') and grantee = 'service_role')::text from unnest(array['invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events']) t$$, '0/0');
select ist.val('ST6 private.stripe_link_states exists and anon, authenticated and service_role hold nothing on it', $$select (to_regclass('private.stripe_link_states') is not null)::text || '/' || (select count(*) filter (where has_table_privilege(r, 'private.stripe_link_states', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))::text from unnest(array['anon','authenticated','service_role']) r)$$, 'true/0');
select ist.val('ST7 exactly two policies across the five, both SELECT (accounts and card payments)', $$select string_agg(c.relname || '=' || p.polcmd::text, ',' order by c.relname) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'public'::regnamespace and c.relname in ('invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events')$$, 'invoice_card_payments=r,invoice_stripe_accounts=r');
select ist.val('ST8 the platform fee is seeded at 100 bps (Q279: 1%), in the one row the id check allows', $$select count(*) || '/' || max(application_fee_bps) from public.stripe_platform_settings$$, '1/100');

-- ===========================================================================
-- § SR WHO READS WHAT. One string per persona: accounts and card payments,
-- each as A/B/S counts. A holds an account and a payment; B and S an account.
-- ===========================================================================
insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id, amount_minor, currency, outcome)
values (:'org_a', :'inv_ap', 'evt_a1', :'pi_a', 12000, 'GBP', 'applied');
select format($$select 'acct:' || (select count(*) from public.invoice_stripe_accounts where organisation_id = %1$L) || '/' || (select count(*) from public.invoice_stripe_accounts where organisation_id = %2$L) || '/' || (select count(*) from public.invoice_stripe_accounts where organisation_id = %3$L) || ' pay:' || (select count(*) from public.invoice_card_payments where organisation_id = %1$L) || '/' || (select count(*) from public.invoice_card_payments where organisation_id = %2$L) || '/' || (select count(*) from public.invoice_card_payments where organisation_id = %3$L)$$, :'org_a', :'org_b', :'org_s') as vis \gset
select ist.val('SR0 FIXTURE: as postgres every planted row is there', :'vis', 'acct:1/1/1 pay:1/0/0');
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select ist.val('SR1 A''s Finance user reads A''s account row and card payment, and nothing of B or S', :'vis', 'acct:1/0/0 pay:1/0/0');
set request.jwt.claims = :'ro_a_c';
select ist.val('SR2 A''s Read Only user (no view_finance, as IR5) reads nothing', :'vis', 'acct:0/0/0 pay:0/0/0');
set request.jwt.claims = :'fin_b_c';
select ist.val('SR3 BREAKOUT: B''s Finance user reads B''s own account (the positive control) and none of A''s', :'vis', 'acct:0/1/0 pay:0/0/0');
set request.jwt.claims = :'fin_s_c';
select ist.val('SR4 DOWNGRADE HIDES NOTHING (as IR8): a Starter workspace''s Finance user reads its own account and none of A''s', :'vis', 'acct:0/0/1 pay:0/0/0');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § SB BREAKOUT: A's Finance user (aal2, the strongest writer there is)
-- forges a write on every table.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select ist.val('SB1 a forged INSERT on invoice_stripe_accounts is refused by privilege', format($$insert into public.invoice_stripe_accounts (organisation_id, stripe_account_id) values (%L, 'acct_Forged1') returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB2 a forged UPDATE on invoice_stripe_accounts is refused by privilege', format($$update public.invoice_stripe_accounts set stripe_account_id = 'acct_Forged1' where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB3 a forged DELETE on invoice_stripe_accounts is refused by privilege', format($$delete from public.invoice_stripe_accounts where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB4 a forged INSERT on invoice_card_payments is refused by privilege', format($$insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id, amount_minor, currency, outcome) values (%L, %L, 'evt_f', 'pi_f', 1, 'GBP', 'applied') returning 'written'$$, :'org_a', :'inv_ai'), 'denied(42501:missing_grant)');
select ist.val('SB5 a forged UPDATE on invoice_card_payments is refused by privilege', format($$update public.invoice_card_payments set amount_minor = 1 where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB6 a forged DELETE on invoice_card_payments is refused by privilege', format($$delete from public.invoice_card_payments where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB7 a forged INSERT on invoice_pay_sessions is refused by privilege', format($$insert into public.invoice_pay_sessions (organisation_id, invoice_id) values (%L, %L) returning 'written'$$, :'org_a', :'inv_ai'), 'denied(42501:missing_grant)');
select ist.val('SB8 a forged UPDATE on invoice_pay_sessions is refused by privilege', format($$update public.invoice_pay_sessions set stripe_session_id = 'cs_forged' where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB9 a forged DELETE on invoice_pay_sessions is refused by privilege', format($$delete from public.invoice_pay_sessions where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB10 a forged INSERT on stripe_events is refused by privilege', format($$insert into public.stripe_events (id, organisation_id, type) values ('evt_forged', %L, 'x') returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB11 a forged UPDATE on stripe_events is refused by privilege', format($$update public.stripe_events set type = 'y' where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB12 a forged DELETE on stripe_events is refused by privilege', format($$delete from public.stripe_events where organisation_id = %L returning 'written'$$, :'org_a'), 'denied(42501:missing_grant)');
select ist.val('SB13 a forged INSERT on stripe_platform_settings is refused by privilege', $$insert into public.stripe_platform_settings (application_fee_bps) values (0) returning 'written'$$, 'denied(42501:missing_grant)');
select ist.val('SB14 a forged UPDATE of the platform fee is refused by privilege', $$update public.stripe_platform_settings set application_fee_bps = 0 returning 'written'$$, 'denied(42501:missing_grant)');
select ist.val('SB15 a forged DELETE on stripe_platform_settings is refused by privilege', $$delete from public.stripe_platform_settings returning 'written'$$, 'denied(42501:missing_grant)');
select ist.val('SB16 the platform fee cannot even be read by a signed-in user', $$select count(*)::text from public.stripe_platform_settings$$, 'denied(42501:missing_grant)');
select ist.val('SB17 private.stripe_link_states cannot be read by a signed-in user', $$select count(*)::text from private.stripe_link_states$$, 'denied(42501:missing_grant)');
reset role;
reset request.jwt.claims;

-- ===========================================================================
-- § SP invoices.paid_via AND THE REBUILT SHAPE AND FREEZE (as postgres, the
-- table owner, past RLS). inv_ap is paid by hand; inv_ai stays issued for
-- the probes (each a subtransaction that is rolled back).
-- ===========================================================================
update public.invoices set status = 'paid', paid_on = current_date, paid_by = :'fin_a', paid_via = 'manual' where id = :'inv_ap';
select ist.val('SP1 the freeze trigger is ENABLED after the migration''s backfill (tgenabled O)', $$select tgenabled::text from pg_trigger where tgrelid = 'public.invoices'::regclass and tgname = 'invoices_freeze'$$, 'O');
select ist.val('SP2 BACKFILL: no row has paid_on set without paid_via, and a manual payment reads manual', format($$select (select count(*) from public.invoices where paid_on is not null and paid_via is null)::text || '/' || (select paid_via from public.invoices where id = %L)$$, :'inv_ap'), '0/manual');
select ist.val('SP3 POSITIVE CONTROL: an issued->paid update with paid_via card and no paid_by is written', format($$select ist.violated(%L)$$, format($$update public.invoices set status = 'paid', paid_on = current_date, paid_via = 'card' where id = %L$$, :'inv_ai')), 'written');
select ist.val('SP4 paid_via card WITH a paid_by is refused by invoices_paid_shape', format($$select ist.violated(%L)$$, format($$update public.invoices set status = 'paid', paid_on = current_date, paid_via = 'card', paid_by = %L where id = %L$$, :'fin_a', :'inv_ai')), 'violates invoices_paid_shape');
select ist.val('SP5 paid_via manual WITHOUT a paid_by is refused by invoices_paid_shape', format($$select ist.violated(%L)$$, format($$update public.invoices set status = 'paid', paid_on = current_date, paid_via = 'manual' where id = %L$$, :'inv_ai')), 'violates invoices_paid_shape');
select ist.val('SP6 POSITIVE CONTROL: paid_via manual WITH a paid_by is written', format($$select ist.violated(%L)$$, format($$update public.invoices set status = 'paid', paid_on = current_date, paid_via = 'manual', paid_by = %L where id = %L$$, :'fin_a', :'inv_ai')), 'written');
select ist.val('SP7 paid_on set with no paid_via is refused by invoices_paid_shape', format($$select ist.violated(%L)$$, format($$update public.invoices set status = 'paid', paid_on = current_date where id = %L$$, :'inv_ai')), 'violates invoices_paid_shape');
select ist.val('SP8 paid_via set with no paid_on is refused by invoices_paid_shape', format($$select ist.violated(%L)$$, format($$update public.invoices set status = 'paid', paid_via = 'card' where id = %L$$, :'inv_ai')), 'violates invoices_paid_shape');
select ist.val('SP9 a paid_by with no paid_via is refused by invoices_paid_shape (a draft insert, which the freeze does not see)', format($$select ist.violated(%L)$$, format($$insert into public.invoices (organisation_id, created_by, paid_by) values (%L, %L, %L)$$, :'org_a', :'fin_a', :'fin_a')), 'violates invoices_paid_shape');
select ist.val('SP10 a paid_via outside manual and card is refused by its own CHECK', format($$select ist.violated(%L)$$, format($$update public.invoices set status = 'paid', paid_on = current_date, paid_via = 'cash', paid_by = %L where id = %L$$, :'fin_a', :'inv_ai')), 'violates invoices_paid_via_check');
select ist.val('SP11 a paid invoice''s paid_via cannot be changed (manual -> card)', format($$update public.invoices set paid_via = 'card' where id = %L returning 'written'$$, :'inv_ap'), 'denied(42501:invoice_is_frozen)');
select ist.val('SP12 ...nor cleared', format($$update public.invoices set paid_via = null where id = %L returning 'written'$$, :'inv_ap'), 'denied(42501:invoice_is_frozen)');
select ist.val('SP13 voiding a paid invoice cannot change paid_via in the same update', format($$update public.invoices set status = 'void', voided_at = now(), voided_by = %L, void_reason = 'Raised in error', paid_via = 'card' where id = %L returning 'written'$$, :'fin_a', :'inv_ap'), 'denied(42501:invoice_is_frozen)');
select ist.val('SP14 POSITIVE CONTROL: voiding the same invoice with paid_via left alone is written, and paid_via is kept', format($$update public.invoices set status = 'void', voided_at = now(), voided_by = %L, void_reason = 'Raised in error' where id = %L returning paid_via$$, :'fin_a', :'inv_ap'), 'manual');
select ist.val('SP15 an issued invoice cannot take a paid_via without becoming paid', format($$update public.invoices set paid_via = 'card' where id = %L returning 'written'$$, :'inv_ae'), 'denied(42501:invoice_is_frozen)');

-- ===========================================================================
-- § SC THE TABLE CONSTRAINTS Tasks 3 and 4 rely on (as postgres, each probe
-- rolled back), each beside a control that differs in ONE column.
-- ===========================================================================
select ist.val('SC1 a card payment of 0 is refused by its CHECK', format($$select ist.violated(%L)$$, format($$insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id, amount_minor, currency, outcome) values (%L, %L, 'evt_c1', 'pi_c1', 0, 'GBP', 'applied')$$, :'org_a', :'inv_ai')), 'violates invoice_card_payments_amount_minor_check');
select ist.val('SC2 POSITIVE CONTROL: the same card payment for 1 is written', format($$select ist.violated(%L)$$, format($$insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id, amount_minor, currency, outcome) values (%L, %L, 'evt_c1', 'pi_c1', 1, 'GBP', 'applied')$$, :'org_a', :'inv_ai')), 'written');
select ist.val('SC3 a card payment on ANOTHER workspace''s invoice is refused by the composite FK', format($$insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id, amount_minor, currency, outcome) values (%L, %L, 'evt_c1', 'pi_c1', 1, 'GBP', 'applied') returning 'written'$$, :'org_a', :'inv_bi'), 'denied(23503)');
select ist.val('SC4 one payment intent can be recorded once', format($$select ist.violated(%L)$$, format($$insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id, amount_minor, currency, outcome) values (%L, %L, 'evt_c2', %L, 1, 'GBP', 'applied')$$, :'org_a', :'inv_ai', :'pi_a')), 'unique invoice_card_payments_stripe_payment_intent_id_key');
select ist.val('SC5 a refund is recorded with its time, or neither', format($$select ist.violated(%L)$$, format($$update public.invoice_card_payments set refunded_minor = 100 where organisation_id = %L$$, :'org_a')), 'violates invoice_card_payments_refund_pair');
select ist.val('SC6 POSITIVE CONTROL: a refund with its time is written', format($$select ist.violated(%L)$$, format($$update public.invoice_card_payments set refunded_minor = 100, refunded_at = now() where organisation_id = %L$$, :'org_a')), 'written');
select ist.val('SC7 a refund beyond the amount paid is refused', format($$select ist.violated(%L)$$, format($$update public.invoice_card_payments set refunded_minor = 12001, refunded_at = now() where organisation_id = %L$$, :'org_a')), 'violates invoice_card_payments_check');
select ist.val('SC8 a payment in any currency but GBP is refused', format($$select ist.violated(%L)$$, format($$insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id, amount_minor, currency, outcome) values (%L, %L, 'evt_c3', 'pi_c3', 1, 'EUR', 'applied')$$, :'org_a', :'inv_ai')), 'violates invoice_card_payments_currency_check');
select ist.val('SC9 an account that has ended names why, or neither', format($$select ist.violated(%L)$$, format($$update public.invoice_stripe_accounts set ended_at = now() where organisation_id = %L$$, :'org_a')), 'violates invoice_stripe_accounts_end_pair');
select ist.val('SC10 a Stripe account id that is not acct_ + letters and digits is refused', format($$select ist.violated(%L)$$, format($$update public.invoice_stripe_accounts set stripe_account_id = 'acct_x; drop' where organisation_id = %L$$, :'org_a')), 'violates invoice_stripe_accounts_stripe_account_id_check');
select ist.val('SC11 two workspaces cannot hold the same LIVE Stripe account', format($$select ist.violated(%L)$$, format($$update public.invoice_stripe_accounts set stripe_account_id = %L where organisation_id = %L$$, :'acct_a', :'org_b')), 'unique invoice_stripe_accounts_live_account_idx');
select ist.val('SC12 POSITIVE CONTROL: an account whose link has ENDED can be linked by another workspace', format($$select ist.violated(%L)$$, format($$update public.invoice_stripe_accounts set stripe_account_id = %L where organisation_id = %L$$, :'acct_s', :'org_b')), 'written');
select ist.val('SC13 the platform fee is capped at 1000 bps', $$select ist.violated('update public.stripe_platform_settings set application_fee_bps = 1001')$$, 'violates stripe_platform_settings_application_fee_bps_check');
select ist.val('SC14 a webhook event id must look like evt_...', format($$select ist.violated(%L)$$, format($$insert into public.stripe_events (id, organisation_id, type) values ('not-an-event', %L, 'x')$$, :'org_a')), 'violates stripe_events_id_check');

-- ===========================================================================
-- § SH private.book_invoice_payment(): the finance block mark_invoice_paid
-- runs, shared with the sessionless card path (the actor may be null).
-- ===========================================================================
select ist.val('SH1 no client role can execute the helper', $$select count(*) filter (where has_function_privilege(r, 'private.book_invoice_payment(uuid,date,uuid)', 'EXECUTE'))::text from unnest(array['anon','authenticated','service_role']) r$$, '0');
select ist.val('SH2 a DRAFT is refused with invoice_not_issued', format($$select flipped::text from private.book_invoice_payment(%L, current_date, null)$$, :'inv_ad'), 'denied(22023:invoice_not_issued)');
select ist.val('SH3 an invoice that is not there is refused the same way', $$select flipped::text from private.book_invoice_payment(gen_random_uuid(), current_date, null)$$, 'denied(22023:invoice_not_issued)');
select ist.val('SH4 an issued invoice with no event books nothing: 0 flipped, no entry', format($$select flipped || '|' || coalesce(entry_id::text, 'none') from private.book_invoice_payment(%L, current_date, null)$$, :'inv_ai'), '0|none');
select ist.val('SH5 an issued invoice on a live event books its free line: 0 flipped, an entry', format($$select flipped || '|' || (entry_id is not null)::text from private.book_invoice_payment(%L, current_date, null)$$, :'inv_ae'), '0|true');
select ist.val('SH6 ...the entry is actual income on that event, NET of VAT, created by nobody (a sessionless payment)', format($$select category || '|' || status || '|' || amount_minor || '|' || coalesce(created_by::text, 'nobody') || '|' || description from public.financial_entries where organisation_id = %L and event_id = %L and deleted_at is null$$, :'org_a', :'ev_a'), 'income|actual|10000|nobody|Invoice IST-0002');
select ist.val('SH7 the helper changes nothing on the invoice itself (the caller does that)', format($$select status || '|' || coalesce(paid_via, 'none') from public.invoices where id = %L$$, :'inv_ae'), 'issued|none');

-- ===========================================================================
-- § SF THE APPLICATION FEE, bound to lib/stripe/fee.ts (tests/unit/stripe/fee.test.ts)
-- ===========================================================================
select ist.val('SF1 private.application_fee_minor matches the TS port on all seven rows', $$select string_agg(private.application_fee_minor(g, b)::text, ',' order by n) from (values (1, 200000::bigint, 100), (2, 12345, 100), (3, 12350, 100), (4, 1, 100), (5, 50, 100), (6, 99999, 0), (7, 100000, 1000)) v(n, g, b)$$, '2000,123,124,0,1,0,10000');
select ist.val('SF2 no client role can execute it', $$select count(*) filter (where has_function_privilege(r, 'private.application_fee_minor(bigint,integer)', 'EXECUTE'))::text from unnest(array['anon','authenticated','service_role']) r$$, '0');

-- ===========================================================================
-- § SK THE CATALOGUES
-- ===========================================================================
select ist.val('SK1 every public table is classified for retention', $$select count(*)::text from private.unclassified_retention_subjects()$$, '0');
select ist.val('SK2 the five new tables and private.stripe_link_states are in the retention roll with their treatments', $$select string_agg(table_name || '=' || treatment || '/' || coalesce(class, '-'), ',' order by table_name) from private.retention_subjects() where table_name in ('invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events','private.stripe_link_states')$$, 'invoice_card_payments=cascades/-,invoice_pay_sessions=cascades/-,invoice_stripe_accounts=cascades/-,private.stripe_link_states=cascades/-,stripe_events=cascades/-,stripe_platform_settings=platform_reference/-');
select ist.val('SK3 private.assert_retention_roll() still passes on the live schema', $$select 'ok' from (select private.assert_retention_roll()) s$$, 'ok');
select ist.val('SK4 none of the five is client-writable, so the audit coverage census does not name them', $$select count(*)::text from private.audit_coverage() where table_name in ('invoice_stripe_accounts','stripe_platform_settings','invoice_pay_sessions','invoice_card_payments','stripe_events')$$, '0');
select ist.val('SK5 the audit catalogue names the five new actions', $$select count(*)::text from private.audit_action_catalogue() a where a in ('invoice.paid_by_card','invoice.card_payment_conflict','invoice.card_refund_flagged','invoice_stripe_account.linked','invoice_stripe_account.ended')$$, '5');
select ist.val('SK6 the incident-alert allowlist names stripe_payment_mismatch', $$select (pg_get_constraintdef(oid) like '%stripe_payment_mismatch%')::text from pg_constraint where conname = 'incident_alerts_alert_type_known'$$, 'true');
select ist.val('SK7 the workspace export carries the account and card-payment tables; the pay-session counter and event ledger are excused', $$select string_agg(table_name || '=' || disposition, ',' order by table_name) from private.export_catalogue() where export_kind = 'workspace' and table_name in ('invoice_stripe_accounts','invoice_card_payments','invoice_pay_sessions','stripe_events')$$, 'invoice_card_payments=exported,invoice_pay_sessions=excused,invoice_stripe_accounts=exported,stripe_events=excused');
select ist.val('SK8 the export catalogue is still sound', $$select private.export_catalogue_is_sound()::text$$, 'sound');
select ist.val('SK9 no uuid column of the new tables is an unclassified identifier', $$select count(*)::text from private.unclassified_fkless_identifiers() where table_name in ('public.invoice_stripe_accounts','public.invoice_card_payments','public.invoice_pay_sessions','public.stripe_events','private.stripe_link_states')$$, '0');

-- ===========================================================================
-- § SE AN ERASED ACCOUNT'S STRIPE LINK: invoice_stripe_accounts.linked_by is a
-- NO ACTION foreign key to auth.users, the part-1 convention (invoices.paid_by
-- and friends), so private.erase_account()'s derived walk must re-point it to
-- the tombstone or the erasure would be blocked.
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as org_e \gset
select gen_random_uuid()::text as fin_e \gset
select gen_random_uuid()::text as own_e \gset
\o
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values (:'fin_e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ist-fin-e-' || :'fin_e' || '@test.local', now(), now(), now()),
         (:'own_e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ist-own-e-' || :'own_e' || '@test.local', now(), now(), now());
insert into public.organisations (id, name, slug) values (:'org_e', 'Stripe Erase', 'ist-erase-' || left(:'org_e', 8));
-- A workspace with members and data needs an Owner (workspace_has_no_owner, Q131).
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
  values (:'org_e', :'fin_e', 'finance', 'active', now()), (:'org_e', :'own_e', 'owner', 'active', now());
insert into public.invoice_stripe_accounts (organisation_id, stripe_account_id, charges_enabled, linked_by)
  values (:'org_e', 'acct_E' || replace(gen_random_uuid()::text, '-', ''), true, :'fin_e');
select ist.val('SE1 FIXTURE: the account row names the person who linked it', format($$select (linked_by = %L)::text from public.invoice_stripe_accounts where organisation_id = %L$$, :'fin_e', :'org_e'), 'true');
select ist.val('SE2 the account erasure runs over a person who linked a Stripe account', format($$select 'ok' from (select private.erase_account(%L, null)) s$$, :'fin_e'), 'ok');
select ist.val('SE3 ...the link survives, re-pointed to the tombstone, still live and charge-enabled', format($$select (linked_by = private.erased_user_id())::text || '|' || charges_enabled || '|' || (ended_at is null) from public.invoice_stripe_accounts where organisation_id = %L$$, :'org_e'), 'true|true|true');

-- ===========================================================================
-- § SZ HOUSEKEEPING (later tasks insert their sections ABOVE this line)
-- ===========================================================================
reset role;
reset request.jwt.claims;
-- ORIGIN mode, so the cascades run (and the freeze triggers admit them).
delete from public.organisations where id in (:'org_a', :'org_b', :'org_s', :'org_e');
set session_replication_role = replica;
delete from public.audit_events
 where organisation_id in (:'org_a', :'org_b', :'org_s', :'org_e')
    or actor_user_id in (:'fin_a', :'ro_a', :'fin_b', :'fin_s', :'fin_e', :'own_e');
set session_replication_role = origin;
delete from auth.users where id in (:'fin_a', :'ro_a', :'fin_b', :'fin_s', :'fin_e', :'own_e');
select ist.val('SZ1 housekeeping left no row behind in any table the suite wrote', format($$select ((select count(*) from public.invoices where organisation_id in (%1$L, %2$L, %3$L)) + (select count(*) from public.invoice_stripe_accounts where organisation_id in (%1$L, %2$L, %3$L)) + (select count(*) from public.invoice_card_payments where organisation_id in (%1$L, %2$L, %3$L)) + (select count(*) from public.financial_entries where organisation_id in (%1$L, %2$L, %3$L)))::text$$, :'org_a', :'org_b', :'org_s'), '0');

\echo
\echo ==================== INVOICES STRIPE ====================
select seq, label, expected, actual, pass from ist.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from ist.results;

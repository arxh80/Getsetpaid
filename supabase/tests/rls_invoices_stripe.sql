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
-- Task 3 (20261110001000_stripe_link_rpcs.sql):
--   SL  begin / complete / end, the webhook's two, the fee, the Owner/Admin notice
-- Task 4 (20261110002000_stripe_card_payment_rpcs.sql):
--   SY  the pay page, begin / attach (the gate, the fee, the hourly budget)
--   SW  the checkout and refund webhooks, and the two account events' event ids
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
-- The migration re-adding invoices_paid_shape (its constraint validation) is what guards the backfill; SP2 asserts the invariant it left.
select ist.val('SP2 SHAPE INVARIANT: no row has paid_on set without paid_via, and a manual payment reads manual', format($$select (select count(*) from public.invoices where paid_on is not null and paid_via is null)::text || '/' || (select paid_via from public.invoices where id = %L)$$, :'inv_ap'), '0/manual');
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
-- § SL LINKING AND ENDING (Task 3, 20261110001000): begin, claim, complete, end, the
-- webhook's two, the fee, and the Owner/Admin notice. Step-up is spent from a
-- stock the way the server would after a passed step-up (step_up_fixture.arm);
-- fin_a2 is a second A Finance user who is deliberately NOT armed.
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as fin_a2 \gset
select gen_random_uuid()::text as own_a  \gset
select gen_random_uuid()::text as adm_a  \gset
select 'acct_L1' || replace(gen_random_uuid()::text, '-', '') as acct_l1 \gset
select 'acct_L2' || replace(gen_random_uuid()::text, '-', '') as acct_l2 \gset
select 'acct_L3' || replace(gen_random_uuid()::text, '-', '') as acct_l3 \gset
select 'acct_L4' || replace(gen_random_uuid()::text, '-', '') as acct_l4 \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'fin_a2') as fin_a2_c \gset
\o
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
  from (values (:'fin_a2'::uuid, 'ist-fin-a2-' || :'fin_a2' || '@test.local'),
               (:'own_a'::uuid,  'ist-own-a-'  || :'own_a'  || '@test.local'),
               (:'adm_a'::uuid,  'ist-adm-a-'  || :'adm_a'  || '@test.local')) v(u, e);
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_a', :'fin_a2', 'finance', 'active', now()),
  (:'org_a', :'own_a',  'owner',   'active', now()),
  (:'org_a', :'adm_a',  'admin',   'active', now()),
  (:'org_b', :'fin_a',  'finance', 'active', now());
-- A's row starts empty so the first completion is an INSERT; B's account is the one SL19 collides with.
delete from public.invoice_stripe_accounts where organisation_id = :'org_a';
select stripe_account_id as acct_b from public.invoice_stripe_accounts where organisation_id = :'org_b' \gset
select step_up_fixture.arm(:'fin_a_c') \g /dev/null

select ist.val('SL0 who may EXECUTE the eight (anon, authenticated, service_role), and all are definers with an empty search_path (! marks one that is not)', $$select string_agg(p.proname || '=' || coalesce((select string_agg(r, '/' order by r) from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r, p.oid, 'EXECUTE')), '-') || (case when p.prosecdef and p.proconfig = array['search_path=""'] then '' else '!' end), ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('begin_stripe_link','claim_stripe_link_state','complete_stripe_link','end_stripe_account_link','stripe_account_deauthorized','stripe_account_updated','pending_invoice_stripe_account_notifications','stripe_application_fee_bps')$$, 'begin_stripe_link=authenticated,claim_stripe_link_state=authenticated,complete_stripe_link=authenticated,end_stripe_account_link=authenticated,pending_invoice_stripe_account_notifications=service_role,stripe_account_deauthorized=service_role,stripe_account_updated=service_role,stripe_application_fee_bps=authenticated');

-- ---- BEGIN -----------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select public.begin_stripe_link(:'org_a') as st1 \gset
select ist.val('SL1 begin returns 43 base64url characters', format($$select (%1$L ~ '^[A-Za-z0-9_-]{43}$')::text$$, :'st1'), 'true');
reset role;
select ist.val('SL2 ...and wrote one row: the HASH of that state (not the state), A, fin_a, unused, expiring in ten minutes', format($$select count(*) || '|' || bool_and(user_id = %2$L and used_at is null and expires_at between now() + interval '9 minutes 50 seconds' and now() + interval '10 minutes')::text || '|' || (select count(*) from private.stripe_link_states where state_hash = convert_to(%1$L, 'UTF8')) from private.stripe_link_states where organisation_id = %3$L and state_hash = extensions.digest(%1$L, 'sha256')$$, :'st1', :'fin_a', :'org_a'), '1|true|0');
set role authenticated;
set request.jwt.claims = :'fin_a2_c';
select ist.val('SL3 an A Finance user with NO step-up token is refused with step_up_required', format($$select public.begin_stripe_link(%L)$$, :'org_a'), 'denied(42501:step_up_required)');
set request.jwt.claims = :'ro_a_c';
select ist.val('SL4 A''s Read Only user is refused forbidden', format($$select public.begin_stripe_link(%L)$$, :'org_a'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_b_c';
select ist.val('SL5 B''s Finance user is refused forbidden for A', format($$select public.begin_stripe_link(%L)$$, :'org_a'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_s_c';
select ist.val('SL6 a Starter workspace is refused plan_does_not_include_invoicing (before any token is asked for: fin_s has none)', format($$select public.begin_stripe_link(%L)$$, :'org_s'), 'denied(42501:plan_does_not_include_invoicing)');
reset role;
reset request.jwt.claims;

-- ---- CLAIM, THEN COMPLETE --------------------------------------------------
-- The callback is one fixed URL, so the workspace comes ONLY from the state row.
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select ist.val('SL7 an UNCLAIMED state cannot be completed: stripe_link_state_invalid', format($$select public.complete_stripe_link(%L, %L, true)$$, :'st1', :'acct_l1'), 'denied(42501:stripe_link_state_invalid)');
set request.jwt.claims = :'fin_a2_c';
select ist.val('SL7a CLAIM BINDS TO THE USER: another A Finance user claiming fin_a''s state is refused stripe_link_state_invalid', format($$select organisation_id::text from public.claim_stripe_link_state(%L)$$, :'st1'), 'denied(42501:stripe_link_state_invalid)');
set request.jwt.claims = :'fin_a_c';
select ist.val('SL7b a made-up state cannot be claimed', $$select organisation_id::text from public.claim_stripe_link_state('not-a-state-anybody-minted')$$, 'denied(42501:stripe_link_state_invalid)');
select ist.val('SL7c POSITIVE CONTROL: fin_a claims the state (refused to the other user, untouched) and gets A and A''s slug back -- though fin_a also manages B, the workspace is the row''s', format($$select (organisation_id = %L)::text || '|' || slug from public.claim_stripe_link_state(%L)$$, :'org_a', :'st1'), 'true|ist-alpha-' || left(:'org_a', 8));
select ist.val('SL7d A SECOND CLAIM of the same state is refused stripe_link_state_invalid (a reload or replay never reaches Stripe)', format($$select organisation_id::text from public.claim_stripe_link_state(%L)$$, :'st1'), 'denied(42501:stripe_link_state_invalid)');
select ist.val('SL7e a claimed state completes: ok', format($$select 'ok' from (select public.complete_stripe_link(%L, %L, true)) s$$, :'st1', :'acct_l1'), 'ok');
reset role;
select ist.val('SL8 ...a live row: the account, charges enabled, linked by fin_a, not ended', format($$select (stripe_account_id = %2$L)::text || '|' || charges_enabled::text || '|' || (linked_by = %3$L)::text || '|' || (ended_at is null)::text from public.invoice_stripe_accounts where organisation_id = %1$L$$, :'org_a', :'acct_l1', :'fin_a'), 'true|true|true|true');
select ist.val('SL9 ...ONE invoice_stripe_account.linked audit row: after = {"changed":["stripe_account"]}, no before, and no acct_ anywhere in it', format($$select count(*) || '|' || max(after::text) || '|' || bool_and(before is null)::text || '|' || bool_and(coalesce(after::text, '') not like '%%acct\_%%')::text from public.audit_events where action = 'invoice_stripe_account.linked' and organisation_id = %L$$, :'org_a'), '1|{"changed": ["stripe_account"]}|true|true');
select ist.val('SL10 ...and the state is claimed and used', format($$select (claimed_at is not null)::text || '|' || (used_at is not null)::text from private.stripe_link_states where state_hash = extensions.digest(%L, 'sha256')$$, :'st1'), 'true|true');
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select ist.val('SL11 the same state completed again is refused stripe_link_state_invalid', format($$select public.complete_stripe_link(%L, %L, true)$$, :'st1', :'acct_l1'), 'denied(42501:stripe_link_state_invalid)');
select ist.val('SL12 a made-up state cannot be completed either', format($$select public.complete_stripe_link('not-a-state-anybody-minted', %L, true)$$, :'acct_l2'), 'denied(42501:stripe_link_state_invalid)');
select public.begin_stripe_link(:'org_a') as st2 \gset
select organisation_id as st2_org from public.claim_stripe_link_state(:'st2') \gset
set request.jwt.claims = :'fin_a2_c';
select ist.val('SL13 A CLAIMED STATE COMPLETED BY ANOTHER A FINANCE USER is refused stripe_link_state_invalid', format($$select public.complete_stripe_link(%L, %L, true)$$, :'st2', :'acct_l2'), 'denied(42501:stripe_link_state_invalid)');
set request.jwt.claims = :'fin_a_c';
select ist.val('SL15 POSITIVE CONTROL: that state, untouched by the refusal, completes for fin_a -- a RE-LINK over the live account', format($$select 'ok' from (select public.complete_stripe_link(%L, %L, false)) s$$, :'st2', :'acct_l2'), 'ok');
-- An expired state: unclaimed (cannot be claimed), and claimed-then-expired (cannot be completed).
select public.begin_stripe_link(:'org_a') as st3 \gset
select public.begin_stripe_link(:'org_a') as st3b \gset
select organisation_id as st3b_org from public.claim_stripe_link_state(:'st3b') \gset
reset role;
update private.stripe_link_states set expires_at = now() - interval '1 minute' where state_hash in (extensions.digest(:'st3', 'sha256'), extensions.digest(:'st3b', 'sha256'));
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select ist.val('SL16 AN EXPIRED STATE cannot be claimed', format($$select organisation_id::text from public.claim_stripe_link_state(%L)$$, :'st3'), 'denied(42501:stripe_link_state_invalid)');
select ist.val('SL16a ...and a state claimed before it expired cannot be completed', format($$select public.complete_stripe_link(%L, %L, true)$$, :'st3b', :'acct_l3'), 'denied(42501:stripe_link_state_invalid)');
select public.begin_stripe_link(:'org_a') as st4 \gset
reset role;
select ist.val('SL17 the next mint swept the expired states (the table is a scratchpad)', format($$select count(*)::text from private.stripe_link_states where state_hash in (extensions.digest(%L, 'sha256'), extensions.digest(%L, 'sha256'))$$, :'st3', :'st3b'), '0');
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select organisation_id as st4_org from public.claim_stripe_link_state(:'st4') \gset
select ist.val('SL18 an account id that is not acct_ + letters and digits is refused stripe_account_invalid', format($$select public.complete_stripe_link(%L, 'acct_x; drop table', true)$$, :'st4'), 'denied(22023:stripe_account_invalid)');
select ist.val('SL19 an account B holds live is refused stripe_account_in_use', format($$select public.complete_stripe_link(%L, %L, true)$$, :'st4', :'acct_b'), 'denied(22023:stripe_account_in_use)');
select ist.val('SL20 POSITIVE CONTROL: the same claimed state with a FRESH id succeeds (neither refusal spent it)', format($$select 'ok' from (select public.complete_stripe_link(%L, %L, true)) s$$, :'st4', :'acct_l3'), 'ok');
reset role;
reset request.jwt.claims;

-- Permission and plan are re-checked on the STATE'S workspace, at claim and at
-- complete, and a refusal rolls the claim (or the use) back. Rows are planted
-- directly: the refusals are about who holds them now, not who began them.
insert into private.stripe_link_states (state_hash, organisation_id, user_id, expires_at, claimed_at) values
  (extensions.digest('sl-ro-unclaimed', 'sha256'), :'org_a', :'ro_a',   now() + interval '5 minutes', null),
  (extensions.digest('sl-ok-unclaimed', 'sha256'), :'org_a', :'fin_a2', now() + interval '5 minutes', null),
  (extensions.digest('sl-st-unclaimed', 'sha256'), :'org_s', :'fin_s',  now() + interval '5 minutes', null),
  (extensions.digest('sl-ro-claimed',   'sha256'), :'org_a', :'ro_a',   now() + interval '5 minutes', now()),
  (extensions.digest('sl-st-claimed',   'sha256'), :'org_s', :'fin_s',  now() + interval '5 minutes', now());
set role authenticated;
set request.jwt.claims = :'ro_a_c';
select ist.val('SL21 a Read Only user cannot claim even a state held in their name: forbidden', $$select organisation_id::text from public.claim_stripe_link_state('sl-ro-unclaimed')$$, 'denied(42501:forbidden)');
select ist.val('SL21a A Read Only user cannot complete a claimed state either: forbidden', format($$select public.complete_stripe_link('sl-ro-claimed', %L, true)$$, :'acct_l4'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_s_c';
select ist.val('SL22 a Starter workspace cannot claim: plan_does_not_include_invoicing', $$select organisation_id::text from public.claim_stripe_link_state('sl-st-unclaimed')$$, 'denied(42501:plan_does_not_include_invoicing)');
select ist.val('SL22a ...nor complete: plan_does_not_include_invoicing', format($$select public.complete_stripe_link('sl-st-claimed', %L, true)$$, :'acct_l4'), 'denied(42501:plan_does_not_include_invoicing)');
set request.jwt.claims = :'fin_a2_c';
select ist.val('SL22b POSITIVE CONTROL: the same kind of planted row held by a Finance user of a Pro workspace claims fine', $$select (organisation_id is not null)::text from public.claim_stripe_link_state('sl-ok-unclaimed')$$, 'true');
reset role;
reset request.jwt.claims;
select ist.val('SL22c every refusal rolled back its claim or use: the four refused rows are as planted', $$select string_agg(s, ',' order by s) from (select case when state_hash = extensions.digest('sl-ro-unclaimed', 'sha256') then 'ro-un' when state_hash = extensions.digest('sl-st-unclaimed', 'sha256') then 'st-un' when state_hash = extensions.digest('sl-ro-claimed', 'sha256') then 'ro-cl' else 'st-cl' end || ':' || (claimed_at is not null)::text || ':' || (used_at is not null)::text as s from private.stripe_link_states where state_hash in (extensions.digest('sl-ro-unclaimed', 'sha256'), extensions.digest('sl-st-unclaimed', 'sha256'), extensions.digest('sl-ro-claimed', 'sha256'), extensions.digest('sl-st-claimed', 'sha256'))) x$$, 'ro-cl:true:false,ro-un:false:false,st-cl:true:false,st-un:false:false');
select ist.val('SL23 three links (a first, a re-link, one after refusals) left ONE row for A, on the last account, charges enabled', format($$select count(*) || '|' || bool_and(stripe_account_id = %2$L and charges_enabled and ended_at is null)::text from public.invoice_stripe_accounts where organisation_id = %1$L$$, :'org_a', :'acct_l3'), '1|true');
select ist.val('SL24 B''s account was not touched by the refusals', format($$select (stripe_account_id = %2$L)::text from public.invoice_stripe_accounts where organisation_id = %1$L$$, :'org_b', :'acct_b'), 'true');

-- ---- END -------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'fin_a2_c';
select ist.val('SL25 ending with NO step-up token is refused step_up_required', format($$select public.end_stripe_account_link(%L)$$, :'org_a'), 'denied(42501:step_up_required)');
set request.jwt.claims = :'ro_a_c';
select ist.val('SL26 A''s Read Only user cannot end: forbidden', format($$select public.end_stripe_account_link(%L)$$, :'org_a'), 'denied(42501:forbidden)');
set request.jwt.claims = :'fin_a_c';
select ist.val('SL27 POSITIVE CONTROL: with a token, end returns the account id it ended', format($$select public.end_stripe_account_link(%L)$$, :'org_a'), :'acct_l3');
select ist.val('SL28 ending again returns null (nothing live)', format($$select public.end_stripe_account_link(%L)$$, :'org_a'), '<null>');
reset role;
select ist.val('SL29 the row is ended with reason disconnected, and still ONE row', format($$select count(*) || '|' || bool_and(ended_at is not null and ended_reason = 'disconnected')::text from public.invoice_stripe_accounts where organisation_id = %L$$, :'org_a'), '1|true');
select ist.val('SL30 ONE invoice_stripe_account.ended audit row (the second end wrote none): {reason}, no acct_', format($$select count(*) || '|' || max(after::text) || '|' || bool_and(coalesce(after::text, '') not like '%%acct\_%%')::text from public.audit_events where action = 'invoice_stripe_account.ended' and organisation_id = %L$$, :'org_a'), '1|{"reason": "disconnected"}|true');
select ist.val('SL31 THREE linked audit rows, one per completion that succeeded (the refusals wrote none)', format($$select count(*)::text from public.audit_events where action = 'invoice_stripe_account.linked' and organisation_id = %L$$, :'org_a'), '3');

-- ---- THE WEBHOOK'S TWO (service_role; no person) ---------------------------
update public.invoice_stripe_accounts set stripe_account_id = :'acct_l4', charges_enabled = true, ended_at = null, ended_reason = null where organisation_id = :'org_a';
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select ist.val('SL32 as authenticated, stripe_account_deauthorized is refused by privilege', format($$select public.stripe_account_deauthorized('evt_sl32', %L)::text$$, :'acct_l4'), 'denied(42501)');
select ist.val('SL33 as authenticated, stripe_account_updated is refused by privilege', format($$select public.stripe_account_updated('evt_sl33', %L, false)::text$$, :'acct_l4'), 'denied(42501)');
reset role;
reset request.jwt.claims;
set role service_role;
select ist.val('SL34 service_role: updated flips charges_enabled off for a live link and says it found one', format($$select public.stripe_account_updated('evt_sl34', %L, false)::text$$, :'acct_l4'), 'true');
reset role;
select ist.val('SL35 ...the flip landed: charges_enabled is false in the table', format($$select charges_enabled::text from public.invoice_stripe_accounts where organisation_id = %L$$, :'org_a'), 'false');
set role service_role;
select ist.val('SL35a ...and updated flips it back on', format($$select public.stripe_account_updated('evt_sl35a', %L, true)::text$$, :'acct_l4'), 'true');
reset role;
select ist.val('SL35b ...which the table shows', format($$select charges_enabled::text from public.invoice_stripe_accounts where organisation_id = %L$$, :'org_a'), 'true');
set role service_role;
select ist.val('SL35c a REPEAT of the stored value is still found (true) and flips nothing', format($$select public.stripe_account_updated('evt_sl35c', %L, true)::text$$, :'acct_l4'), 'true');
reset role;
set role service_role;
select ist.val('SL36 an account nobody holds is false', $$select public.stripe_account_updated('evt_sl36', 'acct_Nobody1', true)::text$$, 'false');
select ist.val('SL37 service_role: deauthorized ends the live link and says it found one', format($$select public.stripe_account_deauthorized('evt_sl37', %L)::text$$, :'acct_l4'), 'true');
select ist.val('SL38 ...a second time finds nothing live: false', format($$select public.stripe_account_deauthorized('evt_sl38', %L)::text$$, :'acct_l4'), 'false');
select ist.val('SL39 an unknown account is false', $$select public.stripe_account_deauthorized('evt_sl39', 'acct_Nobody1')::text$$, 'false');
select ist.val('SL40 an ENDED account is not updated (false): its id is free for another workspace, not a live link', format($$select public.stripe_account_updated('evt_sl40', %L, true)::text$$, :'acct_l4'), 'false');
reset role;
select ist.val('SL41 the link is ended with reason deauthorized', format($$select ended_reason from public.invoice_stripe_accounts where organisation_id = %L$$, :'org_a'), 'deauthorized');
select ist.val('SL42 the deauthorize audit row is by the tombstone (no person), {reason: deauthorized}, no acct_', format($$select count(*) || '|' || bool_and(actor_user_id = private.erased_user_id())::text || '|' || max(after::text) || '|' || bool_and(coalesce(after::text, '') not like '%%acct\_%%')::text from public.audit_events where action = 'invoice_stripe_account.ended' and organisation_id = %L and after ->> 'reason' = 'deauthorized'$$, :'org_a'), '1|true|{"reason": "deauthorized"}|true');
select ist.val('SL43 the updated writes audited exactly the two real flips (off, on; the repeat wrote none): A has 3 linked, 2 ended, 2 charges_enabled_changed, nothing else on the account', format($$select count(*) filter (where action = 'invoice_stripe_account.linked') || '/' || count(*) filter (where action = 'invoice_stripe_account.ended') || '/' || count(*) filter (where action = 'invoice_stripe_account.charges_enabled_changed') || '/' || count(*) filter (where action like 'invoice_stripe_account.%%' and action not in ('invoice_stripe_account.linked', 'invoice_stripe_account.ended', 'invoice_stripe_account.charges_enabled_changed')) from public.audit_events where organisation_id = %L$$, :'org_a'), '3/2/2/0');
select ist.val('SL43a ...each by the tombstone, after = {"changed":["charges_enabled"]}, no before, no acct_', format($$select bool_and(actor_user_id = private.erased_user_id() and after = '{"changed": ["charges_enabled"]}'::jsonb and before is null and after::text not like '%%acct\_%%')::text from public.audit_events where organisation_id = %L and action = 'invoice_stripe_account.charges_enabled_changed'$$, :'org_a'), 'true');

-- ---- THE FEE -----------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select ist.val('SL44 a signed-in user reads the application fee through the RPC (the table itself is closed to them)', $$select public.stripe_application_fee_bps()::text$$, '100');
reset role;
reset request.jwt.claims;
select ist.val('SL45 anon cannot execute it', $$select has_function_privilege('anon', 'public.stripe_application_fee_bps()', 'EXECUTE')::text$$, 'false');

-- ---- THE NOTICE --------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select ist.val('SL46 the resolver as authenticated is refused by privilege', $$select count(*)::text from public.pending_invoice_stripe_account_notifications()$$, 'denied(42501)');
reset role;
reset request.jwt.claims;
set role service_role;
select ist.val('SL47 service_role: A''s three links and two ends are all pending, each as linked or ended', format($$select count(*) filter (where change = 'linked') || '/' || count(*) filter (where change = 'ended') from public.pending_invoice_stripe_account_notifications() where organisation_slug = %L$$, 'ist-alpha-' || left(:'org_a', 8)), '3/2');
select ist.val('SL47a ...and the charges_enabled flips produce NO notice: A''s pending rows are exactly those five', format($$select count(*)::text from public.pending_invoice_stripe_account_notifications() where organisation_slug = %L$$, 'ist-alpha-' || left(:'org_a', 8)), '5');
select ist.val('SL48 ...each addressed to A''s Owner and Admin and nobody else (a Finance user is not told)', format($$select max(cardinality(emails)) || '|' || bool_and(emails @> array[%L, %L]::text[])::text || '|' || bool_and(not (emails @> array[%L]::text[]))::text from public.pending_invoice_stripe_account_notifications() where organisation_slug = %L$$, 'ist-own-a-' || :'own_a' || '@test.local', 'ist-adm-a-' || :'adm_a' || '@test.local', 'ist-fin-a-' || :'fin_a' || '@test.local', 'ist-alpha-' || left(:'org_a', 8)), '2|true|true');
select ist.val('SL49 ...carrying the workspace name and a time, and no account id anywhere in the row', format($$select bool_and(organisation_name = 'Stripe Alpha' and changed_at is not null and to_jsonb(r)::text not like '%%acct\_%%')::text from public.pending_invoice_stripe_account_notifications() r where organisation_slug = %L$$, 'ist-alpha-' || left(:'org_a', 8)), 'true');
reset role;
select id as sl_linked from public.audit_events where action = 'invoice_stripe_account.linked' and organisation_id = :'org_a' order by created_at, id limit 1 \gset
select id as sl_ended from public.audit_events where action = 'invoice_stripe_account.ended' and organisation_id = :'org_a' order by created_at, id limit 1 \gset
set role service_role;
select ist.val('SL50 stamping a made-up id writes nothing', $$select public.mark_notices_delivered('invoice_stripe_account_changed', array[gen_random_uuid()])::text$$, '0');
select ist.val('SL51 stamping a linked row writes one ledger row', format($$select public.mark_notices_delivered('invoice_stripe_account_changed', array[%L]::uuid[])::text$$, :'sl_linked'), '1');
select ist.val('SL52 the undeliverable branch takes an ended row too', format($$select public.mark_notices_undeliverable('invoice_stripe_account_changed', array[%L]::uuid[], 'no_recipient')::text$$, :'sl_ended'), '1');
select ist.val('SL53 both are off the queue now: 2 linked and 1 ended remain', format($$select count(*) filter (where change = 'linked') || '/' || count(*) filter (where change = 'ended') from public.pending_invoice_stripe_account_notifications() where organisation_slug = %L$$, 'ist-alpha-' || left(:'org_a', 8)), '2/1');
select ist.val('SL54 the bank-change notice does not stamp a Stripe audit row (its own action map)', format($$select public.mark_notices_delivered('invoice_bank_details_changed', array[%L]::uuid[])::text$$, :'sl_linked'), '0');
reset role;
select ist.val('SL55 the ledger holds exactly the two Stripe stamps, keyed on their audit rows, one undeliverable', format($$select count(*) || '|' || count(*) filter (where outcome = 'undeliverable') from private.notification_deliveries where audit_event_id in (%L, %L)$$, :'sl_linked', :'sl_ended'), '2|1');

-- ===========================================================================
-- § SY PAYING: the pay page and the card-payment RPCs (Task 4, 20261110002000).
-- All five are service_role only. The pay page runs with NOBODY on the
-- session, so the tier gate reads private.effective_organisation_plan() for the
-- invoice's own workspace (private.finance_module_organisations() answers for
-- auth.uid() and would call every workspace unpayable). Fresh invoices of
-- workspace A, each gross 12000 (net 10000 + 20% VAT 2000), built like the
-- fixtures above; A's link is re-pointed at a fresh live account.
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as y_ok  \gset
select gen_random_uuid()::text as y_rl  \gset
select gen_random_uuid()::text as y_pd  \gset
select gen_random_uuid()::text as y_vd  \gset
select gen_random_uuid()::text as y_zero \gset
select gen_random_uuid()::text as w_ok  \gset
select gen_random_uuid()::text as w_mm  \gset
select gen_random_uuid()::text as w_pd  \gset
select gen_random_uuid()::text as w_vd  \gset
select gen_random_uuid()::text as ev_w  \gset
select gen_random_uuid()::text as fe_w  \gset
select 'acct_Y' || replace(gen_random_uuid()::text, '-', '') as acct_y \gset
select 'pi_W'  || replace(gen_random_uuid()::text, '-', '') as pi_w  \gset
select 'pi_M'  || replace(gen_random_uuid()::text, '-', '') as pi_m  \gset
select 'pi_P'  || replace(gen_random_uuid()::text, '-', '') as pi_p  \gset
select 'pi_V'  || replace(gen_random_uuid()::text, '-', '') as pi_v  \gset
\o
update public.invoice_stripe_accounts set stripe_account_id = :'acct_y', charges_enabled = true, ended_at = null, ended_reason = null where organisation_id = :'org_a';
insert into public.events (id, organisation_id, name, starts_at) values (:'ev_w', :'org_a', 'Alpha Card Night', now() + interval '12 days');
insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, description)
  values (:'fe_w', :'org_a', :'ev_w', 'income', 'budgeted', 8000, 'Guarantee');
insert into public.invoices (id, organisation_id, recipient_company_id, event_id, recipient_address, created_by) values
  (:'y_ok',   :'org_a', :'com_a', null,    '8 Customer Road, London', :'fin_a'),
  (:'y_rl',   :'org_a', :'com_a', null,    '8 Customer Road, London', :'fin_a'),
  (:'y_pd',   :'org_a', :'com_a', null,    '8 Customer Road, London', :'fin_a'),
  (:'y_vd',   :'org_a', :'com_a', null,    '8 Customer Road, London', :'fin_a'),
  (:'y_zero', :'org_a', :'com_a', null,    '8 Customer Road, London', :'fin_a'),
  (:'w_ok',   :'org_a', :'com_a', :'ev_w', '8 Customer Road, London', :'fin_a'),
  (:'w_mm',   :'org_a', :'com_a', null,    '8 Customer Road, London', :'fin_a'),
  (:'w_pd',   :'org_a', :'com_a', null,    '8 Customer Road, London', :'fin_a'),
  (:'w_vd',   :'org_a', :'com_a', null,    '8 Customer Road, London', :'fin_a');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor)
select i.organisation_id, i.id, 1, 'Fee', 1.00, 10000, 'standard_20', 10000, 2000
  from public.invoices i where i.id in (:'y_ok', :'y_rl', :'y_pd', :'y_vd', :'w_mm', :'w_pd', :'w_vd');
insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity, unit_price_minor, vat_rate, net_minor, vat_minor, financial_entry_id) values
  (:'org_a', :'w_ok', 1, 'Guarantee', 1.00, 8000, 'standard_20', 8000, 1600, :'fe_w'),
  (:'org_a', :'w_ok', 2, 'Production', 1.00, 2000, 'standard_20', 2000, 400, null),
  (:'org_a', :'y_zero', 1, 'Complimentary', 1.00, 0, 'none', 0, 0, null);
update public.invoices set net_minor = 10000, vat_minor = 2000, gross_minor = 12000
 where id in (:'y_ok', :'y_rl', :'y_pd', :'y_vd', :'w_ok', :'w_mm', :'w_pd', :'w_vd');
update public.invoices i
   set status = 'issued', number = v.n, issue_date = current_date, supply_date = current_date,
       due_date = current_date + 30,
       snapshot = private.build_invoice_snapshot(i.id, v.n, current_date, current_date, current_date + 30)
  from (values (:'y_ok'::uuid, 'IST-0101'), (:'y_rl'::uuid, 'IST-0102'), (:'y_pd'::uuid, 'IST-0103'),
               (:'y_vd'::uuid, 'IST-0104'), (:'y_zero'::uuid, 'IST-0105'), (:'w_ok'::uuid, 'IST-0201'),
               (:'w_mm'::uuid, 'IST-0202'), (:'w_pd'::uuid, 'IST-0203'), (:'w_vd'::uuid, 'IST-0204')) v(id, n)
 where i.id = v.id;
update public.invoices set status = 'paid', paid_on = current_date, paid_by = :'fin_a', paid_via = 'manual' where id in (:'y_pd', :'w_pd');
update public.invoices set status = 'void', voided_at = now(), voided_by = :'fin_a', void_reason = 'Raised in error' where id in (:'y_vd', :'w_vd');
grant usage on schema ist to anon;
grant execute on function ist.record(text,text,text) to anon;
grant execute on function ist.val(text,text,text) to anon;

-- ---- WHO MAY CALL (a missing grant: the function's own guard never runs) -----
set role authenticated;
set request.jwt.claims = :'fin_a_c';
select ist.val('SY1 as authenticated, invoice_pay_page is refused by privilege', format($$select payable::text from public.invoice_pay_page(%L)$$, :'y_ok'), 'denied(42501)');
select ist.val('SY2 as authenticated, begin_invoice_card_payment is refused by privilege', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_ok'), 'denied(42501)');
select ist.val('SY3 as authenticated, attach_invoice_pay_session is refused by privilege', $$select public.attach_invoice_pay_session(gen_random_uuid(), 'cs_test_x')::text$$, 'denied(42501)');
select ist.val('SY4 as authenticated, record_stripe_checkout_completed is refused by privilege', format($$select public.record_stripe_checkout_completed('evt_sy4', %L, %L, %L, 12000, 'GBP', now())$$, :'acct_y', :'w_mm', :'pi_m'), 'denied(42501)');
select ist.val('SY5 as authenticated, record_stripe_charge_refunded is refused by privilege', format($$select public.record_stripe_charge_refunded('evt_sy5', %L, %L, 100, now())$$, :'acct_y', :'pi_m'), 'denied(42501)');
reset role;
reset request.jwt.claims;
set role anon;
select ist.val('SY6 as anon, invoice_pay_page is refused by privilege', format($$select payable::text from public.invoice_pay_page(%L)$$, :'y_ok'), 'denied(42501)');
select ist.val('SY7 as anon, begin_invoice_card_payment is refused by privilege', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_ok'), 'denied(42501)');
select ist.val('SY8 as anon, attach_invoice_pay_session is refused by privilege', $$select public.attach_invoice_pay_session(gen_random_uuid(), 'cs_test_x')::text$$, 'denied(42501)');
select ist.val('SY9 as anon, record_stripe_checkout_completed is refused by privilege', format($$select public.record_stripe_checkout_completed('evt_sy9', %L, %L, %L, 12000, 'GBP', now())$$, :'acct_y', :'w_mm', :'pi_m'), 'denied(42501)');
select ist.val('SY10 as anon, record_stripe_charge_refunded is refused by privilege', format($$select public.record_stripe_charge_refunded('evt_sy10', %L, %L, 100, now())$$, :'acct_y', :'pi_m'), 'denied(42501)');
reset role;
select ist.val('SY11 the tier-and-link gate is private: no client role can execute it', $$select count(*) filter (where has_function_privilege(r, 'private.invoice_is_payable_online(public.invoices)', 'EXECUTE'))::text from unnest(array['anon','authenticated','service_role']) r$$, '0');

-- ---- THE PAY PAGE: payable, then every refusal ------------------------------
set role service_role;
select ist.val('SY12 POSITIVE CONTROL: A linked and charging, an issued invoice is payable, with the seller, number and gross', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'y_ok'), 'true|Alpha Promotions Ltd|IST-0101|12000');
select ist.val('SY13 an unknown id: every column false or null', $$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(gen_random_uuid())$$, 'false|-|-|-');
select ist.val('SY14 a draft: every column false or null (it differs from a known-but-unpayable link only by the seller)', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'inv_ad'), 'false|-|-|-');
select ist.val('SY15 a PAID invoice: not payable, the seller present, number and gross null', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'y_pd'), 'false|Alpha Promotions Ltd|-|-');
select ist.val('SY16 a VOID invoice: the same', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'y_vd'), 'false|Alpha Promotions Ltd|-|-');
select ist.val('SY17 an issued invoice for nothing (gross 0) is not payable: Stripe cannot charge it', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'y_zero'), 'false|Alpha Promotions Ltd|-|-');
select ist.val('SY18 begin on an unknown id raises invoice_not_payable_online', $$select account from public.begin_invoice_card_payment(gen_random_uuid())$$, 'denied(22023:invoice_not_payable_online)');
select ist.val('SY19 begin on a draft raises invoice_not_payable_online', format($$select account from public.begin_invoice_card_payment(%L)$$, :'inv_ad'), 'denied(22023:invoice_not_payable_online)');
select ist.val('SY20 begin on a paid invoice raises invoice_not_payable_online', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_pd'), 'denied(22023:invoice_not_payable_online)');
select ist.val('SY21 begin on a void invoice raises invoice_not_payable_online', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_vd'), 'denied(22023:invoice_not_payable_online)');
select ist.val('SY22 begin on a zero-gross invoice raises invoice_not_payable_online', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_zero'), 'denied(22023:invoice_not_payable_online)');
reset role;
-- charges_enabled false
update public.invoice_stripe_accounts set charges_enabled = false where organisation_id = :'org_a';
set role service_role;
select ist.val('SY23 charges_enabled false: not payable, the seller present', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'y_ok'), 'false|Alpha Promotions Ltd|-|-');
select ist.val('SY24 ...and begin raises invoice_not_payable_online', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_ok'), 'denied(22023:invoice_not_payable_online)');
reset role;
update public.invoice_stripe_accounts set charges_enabled = true where organisation_id = :'org_a';
-- an ended link
update public.invoice_stripe_accounts set ended_at = now(), ended_reason = 'disconnected' where organisation_id = :'org_a';
set role service_role;
select ist.val('SY25 an ENDED link: not payable, the seller present', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'y_ok'), 'false|Alpha Promotions Ltd|-|-');
select ist.val('SY26 ...and begin raises invoice_not_payable_online', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_ok'), 'denied(22023:invoice_not_payable_online)');
reset role;
update public.invoice_stripe_accounts set ended_at = null, ended_reason = null where organisation_id = :'org_a';
-- no link at all
delete from public.invoice_stripe_accounts where organisation_id = :'org_a';
set role service_role;
select ist.val('SY27 NO link row: not payable, the seller present', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'y_ok'), 'false|Alpha Promotions Ltd|-|-');
select ist.val('SY28 ...and begin raises invoice_not_payable_online', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_ok'), 'denied(22023:invoice_not_payable_online)');
reset role;
insert into public.invoice_stripe_accounts (organisation_id, stripe_account_id, charges_enabled, linked_by) values (:'org_a', :'acct_y', true, :'fin_a');
-- A workspace that left Pro cannot disconnect Stripe in the app (the end RPC needs Pro), so THIS refusal is what stops it being charged.
update public.organisation_subscriptions set plan_id = 'starter' where organisation_id = :'org_a';
set role service_role;
select ist.val('SY29 LOAD-BEARING: workspace A DOWNGRADED to Starter, its link still live: not payable, the seller present', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'y_ok'), 'false|Alpha Promotions Ltd|-|-');
select ist.val('SY30 LOAD-BEARING: ...and begin raises invoice_not_payable_online', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_ok'), 'denied(22023:invoice_not_payable_online)');
reset role;
update public.organisation_subscriptions set plan_id = 'pro' where organisation_id = :'org_a';
set role service_role;
select ist.val('SY31 POSITIVE CONTROL: back on Pro the same invoice is payable again', format($$select payable::text from public.invoice_pay_page(%L)$$, :'y_ok'), 'true');
reset role;
update public.organisations set deleted_at = now() where id = :'org_a';
set role service_role;
select ist.val('SY31a LOAD-BEARING: workspace A SUSPENDED (deleted_at set), Pro and its link still live: not payable, the seller present', format($$select concat_ws('|', payable::text, coalesce(seller_name, '-'), coalesce(number, '-'), coalesce(gross_minor::text, '-')) from public.invoice_pay_page(%L)$$, :'y_ok'), 'false|Alpha Promotions Ltd|-|-');
select ist.val('SY31b LOAD-BEARING: ...and begin raises invoice_not_payable_online', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_ok'), 'denied(22023:invoice_not_payable_online)');
reset role;
update public.organisations set deleted_at = null where id = :'org_a';
set role service_role;
select ist.val('SY31c POSITIVE CONTROL: the workspace reopened, the same invoice is payable again', format($$select payable::text from public.invoice_pay_page(%L)$$, :'y_ok'), 'true');
select ist.val('SY32 service_role holds no table privilege on the pay-session counter: only the RPCs write it', format($$select count(*)::text from public.invoice_pay_sessions where organisation_id = %L$$, :'org_a'), 'denied(42501:missing_grant)');
reset role;
select ist.val('SY33 no refused call wrote a pay-session row (read as postgres)', format($$select count(*)::text from public.invoice_pay_sessions where organisation_id = %L$$, :'org_a'), '0');

-- ---- BEGIN: the fee, the session row, the hourly budget ---------------------
set role service_role;
select ist.val('SY34 begin returns A''s live account, the number, the gross, a 1% fee of 120 on 12000, and a session id', format($$select concat_ws('|', (account = %L)::text, number, gross_minor, fee_minor, (pay_session_id is not null)::text) from public.begin_invoice_card_payment(%L)$$, :'acct_y', :'y_ok'), 'true|IST-0101|12000|120|true');
reset role;
select ist.val('SY35 ...and wrote exactly ONE pay-session row, for A and that invoice, with no Stripe session yet', format($$select count(*) || '|' || bool_and(organisation_id = %L and invoice_id = %L and stripe_session_id is null)::text from public.invoice_pay_sessions where invoice_id = %L$$, :'org_a', :'y_ok', :'y_ok'), '1|true');
select id as y_sess from public.invoice_pay_sessions where invoice_id = :'y_ok' \gset
set role service_role;
select ist.val('SY36 attach stores the Stripe session id on the row', format($$select coalesce(public.attach_invoice_pay_session(%L, 'cs_test_sy36')::text, 'void')$$, :'y_sess'), 'void');
select ist.val('SY37 ...a second attach does not overwrite it', format($$select coalesce(public.attach_invoice_pay_session(%L, 'cs_test_other')::text, 'void')$$, :'y_sess'), 'void');
reset role;
select ist.val('SY38 ...the row still carries the first', format($$select stripe_session_id from public.invoice_pay_sessions where id = %L$$, :'y_sess'), 'cs_test_sy36');
-- 5 rows from two hours ago (outside the window) and 19 from the last five minutes.
insert into public.invoice_pay_sessions (organisation_id, invoice_id, created_at)
select :'org_a', :'y_rl', now() - interval '2 hours' from generate_series(1, 5);
insert into public.invoice_pay_sessions (organisation_id, invoice_id, created_at)
select :'org_a', :'y_rl', now() - interval '5 minutes' from generate_series(1, 19);
set role service_role;
select ist.val('SY39 POSITIVE CONTROL: with 19 sessions in the hour (and 5 stale ones, which do not count) the next call succeeds', format($$select (pay_session_id is not null)::text from public.begin_invoice_card_payment(%L)$$, :'y_rl'), 'true');
select ist.val('SY40 the next is the 21st in the hour: invoice_pay_rate_limited', format($$select account from public.begin_invoice_card_payment(%L)$$, :'y_rl'), 'denied(54000:invoice_pay_rate_limited)');
select ist.val('SY41 the budget is per invoice: another invoice is unaffected', format($$select (pay_session_id is not null)::text from public.begin_invoice_card_payment(%L)$$, :'y_ok'), 'true');
reset role;
select ist.val('SY42 the refused call wrote no row: the rate-limited invoice holds 20 in the hour', format($$select count(*)::text from public.invoice_pay_sessions where invoice_id = %L and created_at > now() - interval '1 hour'$$, :'y_rl'), '20');

-- ===========================================================================
-- § SW THE WEBHOOK'S WRITES (Task 4): a paid checkout, a refund, and the two
-- account events now taking an event id. Nobody is on any session.
-- ===========================================================================
select ist.val('SW1 the Task 3 events that found a live link are on the ledger and the others are not (made-up account, ended link, denied calls)', $$select string_agg(id, ',' order by id) from public.stripe_events where id like 'evt\_sl%'$$, 'evt_sl34,evt_sl35a,evt_sl35c,evt_sl37');
select count(*) as sw_fin_before from public.financial_entries where organisation_id = :'org_a' \gset
set role service_role;
select ist.val('SW2 a WRONG ACCOUNT (B''s live one) naming A''s invoice is a mismatch', format($$select public.record_stripe_checkout_completed('evt_sw2', %L, %L, %L, 12000, 'GBP', now())$$, :'acct_b', :'w_mm', :'pi_m'), 'mismatch');
reset role;
select ist.val('SW3 ...nothing changed (still issued, no card payment) and ONE stripe_payment_mismatch alert for A carries only {invoice_id, event_id}', format($$select (select status from public.invoices where id = %1$L) || '|' || (select count(*) from public.invoice_card_payments where invoice_id = %1$L) || '|' || count(*) || '|' || coalesce(bool_and(a.organisation_id = %2$L)::text, '-') || '|' || coalesce(bool_and(a.details = jsonb_build_object('invoice_id', %1$L::text, 'event_id', 'evt_sw2'))::text, '-') from public.incident_alerts a where a.alert_type = 'stripe_payment_mismatch' and a.details ->> 'invoice_id' = %1$L$$, :'w_mm', :'org_a'), 'issued|0|1|true|true');
set role service_role;
select ist.val('SW4 a WRONG AMOUNT is a mismatch', format($$select public.record_stripe_checkout_completed('evt_sw4', %L, %L, %L, 11999, 'GBP', now())$$, :'acct_y', :'w_mm', :'pi_m'), 'mismatch');
select ist.val('SW5 a WRONG CURRENCY (EUR) is a mismatch', format($$select public.record_stripe_checkout_completed('evt_sw5', %L, %L, %L, 12000, 'EUR', now())$$, :'acct_y', :'w_mm', :'pi_m'), 'mismatch');
select ist.val('SW6 an invoice id that names nothing is a mismatch too', format($$select public.record_stripe_checkout_completed('evt_sw6', %L, gen_random_uuid(), %L, 12000, 'GBP', now())$$, :'acct_y', :'pi_m'), 'mismatch');
select ist.val('SW7 an account no workspace has is unknown_account', format($$select public.record_stripe_checkout_completed('evt_sw7', 'acct_NobodyHasThis', %L, %L, 12000, 'GBP', now())$$, :'w_mm', :'pi_m'), 'unknown_account');
reset role;
select ist.val('SW8 ...unknown_account wrote no event row and no alert; the four mismatches wrote four alerts', $$select (select count(*) from public.stripe_events where id = 'evt_sw7') || '|' || (select count(*) from public.incident_alerts where alert_type = 'stripe_payment_mismatch' and details ->> 'event_id' = 'evt_sw7') || '|' || (select count(*) from public.incident_alerts where alert_type = 'stripe_payment_mismatch' and details ->> 'event_id' in ('evt_sw2','evt_sw4','evt_sw5','evt_sw6'))$$, '0|0|4');
select ist.val('SW9 the four mismatched events are on the ledger (a retry of one is a duplicate), the unknown account''s is not', $$select string_agg(id, ',' order by id) from public.stripe_events where id in ('evt_sw2','evt_sw4','evt_sw5','evt_sw6','evt_sw7')$$, 'evt_sw2,evt_sw4,evt_sw5,evt_sw6');
select ist.val('SW10 a mismatch left the invoice issued, with no card payment and no finance written', format($$select status || '|' || (select count(*) from public.invoice_card_payments where invoice_id = %1$L) || '|' || ((select count(*) from public.financial_entries where organisation_id = %2$L) - %3$s) from public.invoices where id = %1$L$$, :'w_mm', :'org_a', :'sw_fin_before'), 'issued|0|0');
set role service_role;
select ist.val('SW11 POSITIVE CONTROL: the right account, amount and currency APPLIES the same invoice; a Stripe clock before the issue date is clamped to it', format($$select public.record_stripe_checkout_completed('evt_sw11', %L, %L, %L, 12000, 'GBP', now() - interval '5 days')$$, :'acct_y', :'w_mm', :'pi_m'), 'applied');
select ist.val('SW12 a lower-case currency from Stripe is accepted as GBP (the invoice on the event, applied)', format($$select public.record_stripe_checkout_completed('evt_sw12', %L, %L, %L, 12000, 'gbp', timestamptz '2099-07-01 23:30:00+00')$$, :'acct_y', :'w_ok', :'pi_w'), 'applied');
reset role;
select ist.val('SW13 w_mm is paid by card, nobody paid it, and paid_on is the issue date (the clamp)', format($$select status || '|' || paid_via || '|' || coalesce(paid_by::text, 'nobody') || '|' || (paid_on = issue_date)::text || '|' || coalesce(paid_entry_id::text, 'no entry') from public.invoices where id = %L$$, :'w_mm'), 'paid|card|nobody|true|no entry');
select ist.val('SW14 w_ok is paid by card, nobody paid it, and paid_on is the UK date of 23:30 UTC in July: the next day', format($$select status || '|' || paid_via || '|' || coalesce(paid_by::text, 'nobody') || '|' || paid_on::text from public.invoices where id = %L$$, :'w_ok'), 'paid|card|nobody|2099-07-02');
select ist.val('SW15 ONE card payment each, outcome applied, for the amount and A', format($$select string_agg(invoice_id::text || ':' || outcome || ':' || amount_minor || ':' || currency || ':' || (organisation_id = %3$L)::text || ':' || refunded_minor, ',' order by stripe_event_id) from public.invoice_card_payments where invoice_id in (%1$L, %2$L)$$, :'w_mm', :'w_ok', :'org_a'), :'w_mm' || ':applied:12000:GBP:true:0,' || :'w_ok' || ':applied:12000:GBP:true:0');
select ist.val('SW16 NULL-ACTOR FLIP: the pulled budgeted entry is now actual (amount untouched), its line records the flip', format($$select (select status || '|' || amount_minor from public.financial_entries where id = %L) || '|' || (select string_agg(position || ':' || entry_flipped::text, ',' order by position) from public.invoice_lines where invoice_id = %L)$$, :'fe_w', :'w_ok'), 'actual|8000|1:true,2:false');
select ist.val('SW17 ...and the free line''s NET (not gross) became one actual income entry on the event, dated the payment, named for the invoice, created by nobody: what mark_invoice_paid books', format($$select concat_ws('|', fe.category, fe.status, fe.amount_minor, fe.description, (fe.occurred_on = i.paid_on)::text, (fe.event_id = %L)::text, coalesce(fe.created_by::text, 'nobody')) from public.invoices i join public.financial_entries fe on fe.id = i.paid_entry_id where i.id = %L$$, :'ev_w', :'w_ok'), 'income|actual|2000|Invoice IST-0201|true|true|nobody');
select ist.val('SW18 A''s two payments wrote exactly one new financial entry between them (the free line); the flip created none', format($$select ((select count(*) from public.financial_entries where organisation_id = %L) - %s)::text$$, :'org_a', :'sw_fin_before'), '1');
select ist.val('SW19 TWO invoice.paid_by_card audit rows, one per invoice, by the tombstone, for A, before = {status: issued}, the same four keys mark_invoice_paid audits (status, number, entries_flipped, income_entry_created)', format($$select count(*) || '|' || bool_and(a.actor_user_id = private.erased_user_id() and a.before = jsonb_build_object('status', 'issued') and a.after ->> 'status' = 'paid' and a.after ->> 'number' = i.number and (select string_agg(k, ',' order by k) from jsonb_object_keys(a.after) k) = 'entries_flipped,income_entry_created,number,status' and a.organisation_id = %L and a.target_type = 'invoice')::text from public.audit_events a join public.invoices i on i.id = a.target_id where a.action = 'invoice.paid_by_card' and a.target_id in (%L, %L)$$, :'org_a', :'w_mm', :'w_ok'), '2|true');
select ist.val('SW19a ...w_ok flipped its ONE pulled budgeted entry and created income for the free line; w_mm (no event) flipped none and created none: a count and a boolean', format($$select string_agg(case a.target_id when %L then 'ok' else 'mm' end || ':' || (a.after ->> 'entries_flipped') || ':' || (a.after ->> 'income_entry_created'), ',' order by a.after ->> 'entries_flipped') from public.audit_events a where a.action = 'invoice.paid_by_card' and a.target_id in (%L, %L)$$, :'w_ok', :'w_mm', :'w_ok'), 'mm:0:false,ok:1:true');
select ist.val('SW20 ...and the audit payloads hold no account, payment intent, amount or email', format($$select bool_and(after::text !~* '(acct_|pi_|@|12000|8000|2000)')::text from public.audit_events where action = 'invoice.paid_by_card' and target_id in (%L, %L)$$, :'w_mm', :'w_ok'), 'true');
select ist.val('SW21 the ledger holds both checkout events, typed', $$select string_agg(id || ':' || type, ',' order by id) from public.stripe_events where id in ('evt_sw11','evt_sw12')$$, 'evt_sw11:checkout.session.completed,evt_sw12:checkout.session.completed');
set role service_role;
select ist.val('SW22 THE SAME EVENT AGAIN is a duplicate', format($$select public.record_stripe_checkout_completed('evt_sw12', %L, %L, %L, 12000, 'GBP', now())$$, :'acct_y', :'w_ok', :'pi_w'), 'duplicate');
select ist.val('SW23 THE SAME PAYMENT INTENT under a new event id is a duplicate (the unique payment intent)', format($$select public.record_stripe_checkout_completed('evt_sw23', %L, %L, %L, 12000, 'GBP', now())$$, :'acct_y', :'w_ok', :'pi_w'), 'duplicate');
reset role;
select ist.val('SW24 ...the duplicates wrote no second card payment, audit row or income entry for w_ok (the new event id is on the ledger, as a retry of it should be)', format($$select (select count(*) from public.invoice_card_payments where invoice_id = %1$L) || '|' || (select count(*) from public.audit_events where target_id = %1$L and action like 'invoice.%%') || '|' || (select count(*) from public.financial_entries where event_id = %2$L) || '|' || (select count(*) from public.stripe_events where id in ('evt_sw12','evt_sw23'))$$, :'w_ok', :'ev_w'), '1|1|2|2');
set role service_role;
select ist.val('SW25 A PAID (by hand) invoice receiving a card payment is after_paid', format($$select public.record_stripe_checkout_completed('evt_sw25', %L, %L, %L, 12000, 'GBP', now())$$, :'acct_y', :'w_pd', :'pi_p'), 'after_paid');
select ist.val('SW26 A VOID invoice receiving a card payment is after_void', format($$select public.record_stripe_checkout_completed('evt_sw26', %L, %L, %L, 12000, 'GBP', now())$$, :'acct_y', :'w_vd', :'pi_v'), 'after_void');
reset role;
select ist.val('SW27 ...the paid invoice is as it was (paid by hand, by Finance), the void one still void, and no finance was written beyond the one income entry', format($$select (select status || '|' || paid_via || '|' || (paid_by = %3$L)::text from public.invoices where id = %1$L) || '|' || (select status from public.invoices where id = %2$L) || '|' || ((select count(*) from public.financial_entries where organisation_id = %4$L) - %5$s - 1)$$, :'w_pd', :'w_vd', :'fin_a', :'org_a', :'sw_fin_before'), 'paid|manual|true|void|0');
select ist.val('SW28 ...each kept as a card-payment row with its outcome (money to refund by hand)', format($$select string_agg(invoice_id::text || ':' || outcome || ':' || amount_minor, ',' order by outcome) from public.invoice_card_payments where invoice_id in (%L, %L)$$, :'w_pd', :'w_vd'), :'w_pd' || ':after_paid:12000,' || :'w_vd' || ':after_void:12000');
select ist.val('SW29 ...and each audited invoice.card_payment_conflict by the tombstone, name-only', format($$select count(*) || '|' || bool_and(a.actor_user_id = private.erased_user_id() and a.after = jsonb_build_object('status', i.status, 'number', i.number) and a.after::text !~* '(acct_|pi_|@|12000)')::text from public.audit_events a join public.invoices i on i.id = a.target_id where a.action = 'invoice.card_payment_conflict' and a.target_id in (%L, %L)$$, :'w_pd', :'w_vd'), '2|true');
select ist.val('SW30 ...and no invoice.paid_by_card row for either', format($$select count(*)::text from public.audit_events where action = 'invoice.paid_by_card' and target_id in (%L, %L)$$, :'w_pd', :'w_vd'), '0');

-- ---- REFUNDS ----------------------------------------------------------------
set role service_role;
select ist.val('SW31 a refund of 5000 on the applied payment is flagged', format($$select public.record_stripe_charge_refunded('evt_sw31', %L, %L, 5000, timestamptz '2099-08-01 10:00:00+00')$$, :'acct_y', :'pi_w'), 'flagged');
reset role;
select ist.val('SW32 ...refunded_minor 5000 and refunded_at set; the invoice is STILL paid, by card', format($$select p.refunded_minor || '|' || p.refunded_at || '|' || i.status || '|' || i.paid_via from public.invoice_card_payments p join public.invoices i on i.id = p.invoice_id where p.stripe_payment_intent_id = %L$$, :'pi_w'), '5000|2099-08-01 10:00:00+00|paid|card');
set role service_role;
select ist.val('SW33 a later event with a CUMULATIVE 12000 sets 12000', format($$select public.record_stripe_charge_refunded('evt_sw33', %L, %L, 12000, timestamptz '2099-08-02 10:00:00+00')$$, :'acct_y', :'pi_w'), 'flagged');
select ist.val('SW34 a refund greater than the payment clamps to the payment', format($$select public.record_stripe_charge_refunded('evt_sw34', %L, %L, 20000, timestamptz '2099-08-03 10:00:00+00')$$, :'acct_y', :'pi_w'), 'flagged');
select ist.val('SW35 an unknown payment intent is unknown_payment', format($$select public.record_stripe_charge_refunded('evt_sw35', %L, 'pi_NoSuchPayment', 100, now())$$, :'acct_y'), 'unknown_payment');
select ist.val('SW36 B''s live account cannot flag a refund on A''s payment: unknown_payment (breakout)', format($$select public.record_stripe_charge_refunded('evt_sw36', %L, %L, 100, now())$$, :'acct_b', :'pi_w'), 'unknown_payment');
select ist.val('SW37 an account no workspace has is unknown_account', format($$select public.record_stripe_charge_refunded('evt_sw37', 'acct_NobodyHasThis', %L, 100, now())$$, :'pi_w'), 'unknown_account');
select ist.val('SW38 the same refund event again is a duplicate', format($$select public.record_stripe_charge_refunded('evt_sw34', %L, %L, 100, now())$$, :'acct_y', :'pi_w'), 'duplicate');
select ist.val('SW38a OUT OF ORDER: an older, smaller cumulative event (5000, after the 12000 one) is still answered flagged', format($$select public.record_stripe_charge_refunded('evt_sw38a', %L, %L, 5000, timestamptz '2099-08-04 10:00:00+00')$$, :'acct_y', :'pi_w'), 'flagged');
reset role;
select ist.val('SW39 ...refunded_minor stays 12000 and refunded_at the 12000 event''s (the clamp to the payment and the out-of-order 5000 moved neither; the duplicate and the breakout changed nothing), the invoice is still paid', format($$select p.refunded_minor || '|' || p.refunded_at || '|' || i.status from public.invoice_card_payments p join public.invoices i on i.id = p.invoice_id where p.stripe_payment_intent_id = %L$$, :'pi_w'), '12000|2099-08-02 10:00:00+00|paid');
select ist.val('SW40 TWO invoice.card_refund_flagged audit rows, the two that RAISED the refund (5000, 12000): the clamp, the out-of-order 5000, the duplicate, the unknowns and the breakout changed nothing and audited nothing, the tombstone, name-only', format($$select count(*) || '|' || bool_and(actor_user_id = private.erased_user_id() and after = jsonb_build_object('status', 'paid', 'number', 'IST-0201') and after::text !~* '(acct_|pi_|@|12000|5000)')::text from public.audit_events where action = 'invoice.card_refund_flagged' and target_id = %L$$, :'w_ok'), '2|true');
select ist.val('SW41 the ledger holds the refund events that resolved a workspace (not the unknown_account one), typed charge.refunded', $$select string_agg(id || ':' || type, ',' order by id) from public.stripe_events where id in ('evt_sw31','evt_sw33','evt_sw34','evt_sw35','evt_sw36','evt_sw37','evt_sw38a')$$, 'evt_sw31:charge.refunded,evt_sw33:charge.refunded,evt_sw34:charge.refunded,evt_sw35:charge.refunded,evt_sw36:charge.refunded,evt_sw38a:charge.refunded');

-- ---- THE ACCOUNT EVENTS NOW CARRY AN EVENT ID --------------------------------
set role service_role;
select ist.val('SW42 account.updated flips charges_enabled off for a live link', format($$select public.stripe_account_updated('evt_sw42', %L, false)::text$$, :'acct_y'), 'true');
select ist.val('SW43 THE SAME EVENT ID again with the other value is a duplicate (false) and applies nothing', format($$select public.stripe_account_updated('evt_sw42', %L, true)::text$$, :'acct_y'), 'false');
reset role;
select ist.val('SW44 ...charges_enabled is still false and the event is on the ledger once, typed account.updated', format($$select (select charges_enabled::text from public.invoice_stripe_accounts where organisation_id = %L) || '|' || (select count(*) || max(type) from public.stripe_events where id = 'evt_sw42')$$, :'org_a'), 'false|1account.updated');
set role service_role;
select ist.val('SW45 a NEW event id flips it back on', format($$select public.stripe_account_updated('evt_sw45', %L, true)::text$$, :'acct_y'), 'true');
select ist.val('SW46 deauthorized ends the live link', format($$select public.stripe_account_deauthorized('evt_sw46', %L)::text$$, :'acct_y'), 'true');
reset role;
select ist.val('SW47 ...the event is on the ledger for A, typed account.application.deauthorized', format($$select (organisation_id = %L)::text || '|' || type from public.stripe_events where id = 'evt_sw46'$$, :'org_a'), 'true|account.application.deauthorized');
update public.invoice_stripe_accounts set ended_at = null, ended_reason = null where organisation_id = :'org_a';
set role service_role;
select ist.val('SW48 the SAME deauthorized event id replayed after a re-link is a duplicate (false) and does not end the new link', format($$select public.stripe_account_deauthorized('evt_sw46', %L)::text$$, :'acct_y'), 'false');
reset role;
select ist.val('SW49 ...the link is still live', format($$select (ended_at is null)::text from public.invoice_stripe_accounts where organisation_id = %L$$, :'org_a'), 'true');

-- ===========================================================================
-- § SZ HOUSEKEEPING (later tasks insert their sections ABOVE this line)
-- ===========================================================================
reset role;
reset request.jwt.claims;
-- ORIGIN mode, so the cascades run (and the freeze triggers admit them).
-- Ledger stamps first: the org delete sets audit_events.organisation_id to null, and the replica-mode audit delete below fires no cascade.
delete from private.notification_deliveries where audit_event_id in (select id from public.audit_events where organisation_id in (:'org_a', :'org_b', :'org_s', :'org_e'));
delete from public.organisations where id in (:'org_a', :'org_b', :'org_s', :'org_e');
set session_replication_role = replica;
delete from public.audit_events
 where organisation_id in (:'org_a', :'org_b', :'org_s', :'org_e')
    or actor_user_id in (:'fin_a', :'ro_a', :'fin_b', :'fin_s', :'fin_e', :'own_e', :'fin_a2', :'own_a', :'adm_a');
set session_replication_role = origin;
delete from auth.users where id in (:'fin_a', :'ro_a', :'fin_b', :'fin_s', :'fin_e', :'own_e', :'fin_a2', :'own_a', :'adm_a');
select ist.val('SZ1 housekeeping left no row behind in any table the suite wrote', format($$select ((select count(*) from public.invoices where organisation_id in (%1$L, %2$L, %3$L)) + (select count(*) from public.invoice_stripe_accounts where organisation_id in (%1$L, %2$L, %3$L)) + (select count(*) from public.invoice_card_payments where organisation_id in (%1$L, %2$L, %3$L)) + (select count(*) from public.financial_entries where organisation_id in (%1$L, %2$L, %3$L)) + (select count(*) from private.stripe_link_states where organisation_id in (%1$L, %2$L, %3$L)) + (select count(*) from auth.users where id in (%4$L, %5$L, %6$L)))::text$$, :'org_a', :'org_b', :'org_s', :'fin_a2', :'own_a', :'adm_a'), '0');

\echo
\echo ==================== INVOICES STRIPE ====================
select seq, label, expected, actual, pass from ist.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from ist.results;

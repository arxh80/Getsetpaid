-- ===========================================================================
-- Phase 5 (Finance) RLS suite -- THE THREE-GATE BREAKOUT PROOF.
--
-- Covers
--   20260903000000  public.financial_entries + its three composite FKs
--   20260903001000  private.finance_module_organisations()  (the TIER gate)
--   20260903002000  view_finance / manage_finance           (the ROLE gate)
--   20260903003000  the three policies                      (where they land)
--   20260903020000  the `financial_entry` custom-field arm  (Task 3)
--
-- RUN IT WITH:  supabase/tests/run-rls-tests.sh
--   It runs AFTER file_access_phase4.sql and reuses the SAME fixtures whole --
--   the twelve users and orgs ALPHA and BETA. Only finance rows and the events
--   they hang off are created here, plus one contact and one artist that exist
--   ONLY to be deleted in section FJ (so the contact and artist censuses the
--   HTTP block below relies on are net-unchanged when this file finishes).
--
-- IT USES ITS OWN `fin` SCHEMA. Each suite counts its own results table in
-- run-rls-tests.sh, so a Phase 5 failure is not reported under a Phase 4
-- heading. The helpers below are rls_phase4_operations.sql's, verbatim, with
-- the schema renamed.
--
-- ===========================================================================
-- WHAT THIS FILE IS FOR
-- ===========================================================================
-- Finance is the most restricted surface in the product. A finance write is
-- refused unless ALL THREE of these permit it, independently, in the database:
--
--   ROLE  manage_finance / view_finance -- owner, admin, finance and nobody else
--   TIER  finance_module (Pro) -- private.finance_module_organisations()
--   MFA   aal2 -- folded INTO permitted_organisations() because
--         private.role_requires_mfa('finance') is true; there is no separate
--         term in any finance policy, which is precisely why it needs a test
--
-- CLAUDE.md section Testing gates calls tenant-breakout and leakage tests the
-- ones that "matter most". This is that suite for finance, written against the
-- feature in the same phase. The CI note in the phase Global Constraints is why
-- every gate here ALSO gets a structural (source-shape) assertion: CI runs no
-- stack suite, so a control with only a behavioural test has no CI-visible
-- guard at all, and one with a structural test at least fails a source review
-- that reads this file.
--
-- SECTIONS (each negative paired with a positive control -- Constraint 14):
--   FA  the permission catalogue + role_requires_mfa, read out of the database
--   FB  policy SHAPE guards over all three policies, with a denominator
--   FC  the three composite FKs, by column name and delete action
--   FD  THE ROLE GATE (brief assertion 1) -- the headline
--   FE  THE TIER GATE (brief assertion 2) -- the inert-machinery proof
--   FF  THE MFA GATE  (brief assertion 3) -- aal1 vs aal2, the same user
--   FG  cross-tenant  (brief assertion 4) -- both directions + constraint layer
--   FH  entity_org_unchanged (brief assertion 5) -- the two-org admin
--   FI  the custom-field VALUE path (brief assertion 7) at the policy layer
--   FJ  ON DELETE behaviour (brief assertion 6) -- LAST, it destroys fixtures
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a WITH CHECK / INSERT policy fail.
--   denied(23503)  rejected by a FOREIGN KEY -- constraint layer, every writer.
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
--
-- ONE DEVIATION FROM THE BRIEF'S LETTER, STATED HERE BECAUSE IT IS A FACT ABOUT
-- THE SHIPPED POLICIES AND NOT A WEAKENING (Constraint 13): the brief says a
-- non-Finance role's "INSERT/UPDATE raise 42501". INSERT does. UPDATE does NOT,
-- and cannot: financial_entries_update_manage_finance carries manage_finance in
-- its USING clause, so a caller without the key SEES NO ROW, the statement
-- matches nothing, and Postgres reports success over zero rows -- `ok(0)`. That
-- is the same distinction rls_phase2_crm.sql B17 records ("you cannot see it"
-- vs "you can see it and may not do that to it"). Asserting 42501 there would
-- be asserting a policy shape that does not exist. Both are refusals; this
-- suite asserts the one that happens, and section FE proves the OTHER refusal
-- (a caller who CAN see the row and is stopped by WITH CHECK) really does
-- raise 42501.
--
-- psql vars required (supplied by run-rls-tests.sh's P2VARS): the twelve
--   fixture users' claims as `<user>_c` (realistic aal) and `<user>_c1` (aal1).
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists fin cascade;
create schema fin;

create table fin.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function fin.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into fin.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function fin.try(p_label text, p_sql text, p_expected text)
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
  perform fin.record(p_label, p_expected, v_actual);
end $$;

create function fin.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform fin.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema fin to authenticated, anon, service_role;
grant execute on function fin.record(text,text,text) to authenticated, anon, service_role;
grant execute on function fin.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function fin.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null

-- ===========================================================================
-- Fixtures -- FINANCE ROWS AND THE EVENTS THEY HANG OFF, planted as postgres
-- ===========================================================================
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset

-- FIVE LIVE EVENTS, and the OWNERSHIP is load-bearing.
--
-- events_select_view_crm is RECORD-SCOPED (`full_scope_organisations() OR
-- owner_user_id = auth.uid()`), and two of the six roles section FD points at
-- -- standard_user and read_only -- are record-scoped. So a single shared
-- parent event would give those two roles a positive control that reads ZERO,
-- and the section would then be "a user who can see nothing sees no finance",
-- which proves nothing at all. Each record-scoped role therefore gets an event
-- IT OWNS, with a finance line on it: the positive control is that they read
-- their own event, and the finding is that they still read none of its money.
insert into public.events (id, organisation_id, owner_user_id, name, starts_at)
select v.id::uuid, o.id, v.owner::uuid, v.nm, v.st::timestamptz
from public.organisations o, (values
  ('ef110000-0000-0000-0000-000000000001', :'pmanager', 'Finance Event A',
   '2026-11-01 20:00+00'),
  ('ef110000-0000-0000-0000-000000000002', :'pmanager', 'Finance Event B',
   '2026-11-02 20:00+00'),
  ('ef110000-0000-0000-0000-000000000004', :'pstd1',    'Finance Std1 Event',
   '2026-11-04 20:00+00'),
  ('ef110000-0000-0000-0000-000000000005', :'pro',      'Finance ReadOnly Event',
   '2026-11-05 20:00+00')
) as v(id, owner, nm, st) where o.slug='org-alpha';

insert into public.events (id, organisation_id, owner_user_id, name, starts_at)
select 'ef11000b-0000-0000-0000-00000000000b', o.id, :'pbowner',
       'Beta Finance Event', timestamptz '2026-11-06 20:00+00'
from public.organisations o where o.slug='org-beta';

-- A SOFT-DELETED ALPHA event, so the live-parent `exists` in both write
-- policies has something to refuse (FD9).
insert into public.events (id, organisation_id, owner_user_id, name, starts_at, deleted_at)
select 'ef110000-0000-0000-0000-000000000003', o.id, :'pmanager',
       'Finance Deleted Event', timestamptz '2026-11-03 20:00+00', now()
from public.organisations o where o.slug='org-alpha';

-- ONE CONTACT AND ONE ARTIST THAT EXIST ONLY TO BE DELETED (section FJ).
--
-- They are created here and destroyed there, so this file leaves the ALPHA
-- contact and artist censuses exactly as it found them. That matters: the HTTP
-- block in run-rls-tests.sh PATCHes every ALPHA contact and asserts the row
-- count it wrote, so a contact left behind by this file would redden an
-- assertion in another suite for a reason nothing in its text mentions.
insert into public.contacts (id, organisation_id, owner_user_id, name, email)
select '2222f000-0000-0000-0000-00000000000f', o.id, :'pmanager',
       'Finance Supplier Contact', 'finsupplier@example.test'
from public.organisations o where o.slug='org-alpha';

insert into public.artists (id, organisation_id, owner_user_id, name)
select '4444f000-0000-0000-0000-00000000000f', o.id, :'pmanager',
       'Finance Fee Artist'
from public.organisations o where o.slug='org-alpha';

-- THE MONEY. FOUR lines on Finance Event A -- that 4 is the denominator every
-- "reads 0 of N" assertion in section FD is measured against, and it is
-- asserted as a fact (FD0) rather than assumed.
--
-- No positive-control INSERT anywhere in this file targets Finance Event A, so
-- its count of 4 is stable from FD0 to the end of the file. Every write lands
-- on Finance Event B, which section FJ deletes.
insert into public.financial_entries
  (id, organisation_id, event_id, category, status, amount_minor, occurred_on,
   description, supplier_contact_id, artist_id)
select v.id::uuid, o.id, v.ev::uuid, v.cat, v.st, v.amt::bigint, v.d::date,
       v.descr, nullif(v.sup,'')::uuid, nullif(v.art,'')::uuid
from public.organisations o, (values
  ('fa110000-0000-0000-0000-000000000001','ef110000-0000-0000-0000-000000000001',
   'fee',   'budgeted', '100000','2026-11-01','Headliner fee','',''),
  ('fa110000-0000-0000-0000-000000000002','ef110000-0000-0000-0000-000000000001',
   'cost',  'actual',   '50000', '2026-11-01','Production','',''),
  ('fa110000-0000-0000-0000-000000000003','ef110000-0000-0000-0000-000000000001',
   'income','budgeted', '250000','2026-11-01','Ticket income','',''),
  -- THE LINKED LINE. Section FJ deletes the contact and the artist it names and
  -- asserts this row survives with only those two columns nulled.
  ('fa110000-0000-0000-0000-000000000004','ef110000-0000-0000-0000-000000000001',
   'fee',   'budgeted', '75000', '2026-11-01','Support fee',
   '2222f000-0000-0000-0000-00000000000f','4444f000-0000-0000-0000-00000000000f'),
  -- Finance Event B: the write target for every positive control, and the
  -- cascade victim in section FJ.
  ('fa110000-0000-0000-0000-000000000005','ef110000-0000-0000-0000-000000000002',
   'cost',  'budgeted', '1000',  '2026-11-02','B cost','',''),
  ('fa110000-0000-0000-0000-000000000006','ef110000-0000-0000-0000-000000000002',
   'income','actual',   '2000',  '2026-11-02','B income','',''),
  -- One line on each record-scoped role's OWN event (see the events note).
  ('fa110000-0000-0000-0000-000000000007','ef110000-0000-0000-0000-000000000004',
   'fee',   'budgeted', '500',   '2026-11-04','Std1 event fee','',''),
  ('fa110000-0000-0000-0000-000000000008','ef110000-0000-0000-0000-000000000005',
   'fee',   'budgeted', '600',   '2026-11-05','ReadOnly event fee','','')
) as v(id, ev, cat, st, amt, d, descr, sup, art) where o.slug='org-alpha';

insert into public.financial_entries
  (id, organisation_id, event_id, category, status, amount_minor, occurred_on, description)
select 'fa11000b-0000-0000-0000-00000000000b', o.id,
       'ef11000b-0000-0000-0000-00000000000b', 'fee', 'budgeted', 900,
       date '2026-11-06', 'Beta secret fee'
from public.organisations o where o.slug='org-beta';

-- ===========================================================================
-- FA. The permission catalogue and the MFA rule, read out of the database
-- ===========================================================================
-- A matrix seeded wrong makes every behavioural assertion below green against
-- the wrong rows. The mutations this section catches directly: granting a
-- finance key to a seventh role in 20260903002000, and removing 'finance' from
-- private.role_requires_mfa (the brief's mutation 3 -- FA7 reddens immediately,
-- before section FF's behavioural half is even reached).
select fin.val('FA1 both finance permission keys exist',
  $$select count(*)::text from public.permissions
     where key in ('view_finance','manage_finance')$$, '2');
select fin.val('FA2 ...and NEITHER survives suspension (Q65: view_crm stays the only one)',
  $$select count(*)::text from public.permissions
     where key in ('view_finance','manage_finance') and survives_suspension$$, '0');
select fin.val('FA3 owner, admin and finance hold both keys -- 6 grants',
  $$select count(*)::text from public.role_permissions
     where permission_key in ('view_finance','manage_finance')
       and role_key in ('owner','admin','finance')$$, '6');
select fin.val('FA4 ...and that is the WHOLE grant set for these keys -- no fourth role',
  $$select count(*)::text from public.role_permissions
     where permission_key in ('view_finance','manage_finance')$$, '6');
select fin.val('FA5 the other six roles hold the finance keys ZERO times',
  $$select count(*)::text from public.role_permissions
     where permission_key in ('view_finance','manage_finance')
       and role_key in ('manager','booker','venue_manager','marketing',
                        'standard_user','read_only')$$, '0');
select fin.val('FA6 CONTROL: those same six roles DO hold view_crm (FA5 is the key, not an empty matrix)',
  $$select count(*)::text from public.role_permissions
     where permission_key='view_crm'
       and role_key in ('manager','booker','venue_manager','marketing',
                        'standard_user','read_only')$$, '6');
-- THE MFA GATE'S SOURCE. There is no aal term in any finance policy; the whole
-- gate is this one boolean, consumed inside permitted_organisations().
select fin.val('FA7 private.role_requires_mfa(''finance'') is TRUE -- the entire MFA gate',
  $$select private.role_requires_mfa('finance')::text$$, 'true');
select fin.val('FA8 CONTROL: it is FALSE for booker, so FA7 is not a constant',
  $$select private.role_requires_mfa('booker')::text$$, 'false');
-- THE TIER GATE'S SOURCE, same idea: the plan flags the gate reads.
select fin.val('FA9 subscription_plans: pro is the ONLY plan with finance_module',
  $$select string_agg(key,',' order by key) from public.subscription_plans
     where finance_module$$, 'pro');
select fin.val('FA10 CONTROL: ...out of three plans, TWO of which do carry crm_writes',
  $$select (select count(*)::text from public.subscription_plans where crm_writes)
           || '/' || (select count(*)::text from public.subscription_plans)$$, '2/3');

-- ===========================================================================
-- FB. POLICY SHAPE GUARDS -- three policies, with a denominator
-- ===========================================================================
-- No behavioural test can tell the set form from the per-row form (Constraint
-- 2, measured 200x), and no behavioural test in a suite CI DOES NOT RUN can
-- tell anything at all. These are the source-shape assertions every finance
-- control owes, and FB5-FB8 are the structural halves of the brief's mutations
-- 1 and 2 -- they redden on the mutation before a policy is ever exercised.
select fin.val('FB1 no financial_entries policy calls has_permission per row',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries'
       and (coalesce(qual,'') like '%has_permission(%'
         or coalesce(with_check,'') like '%has_permission(%')$$, '0');
select fin.val('FB2 every financial_entries policy is built on the hoistable set form',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries'
       and coalesce(qual,'') || coalesce(with_check,'')
           not like '%permitted_organisations%'$$, '0');
select fin.val('FB3 CONTROL: FB1/FB2 inspected THREE policies, not zero',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries'$$, '3');
select fin.val('FB4 CONTROL: those three are SELECT, INSERT and UPDATE -- no DELETE policy',
  $$select string_agg(cmd,',' order by cmd) from pg_policies
     where schemaname='public' and tablename='financial_entries'$$, 'INSERT,SELECT,UPDATE');
-- MUTATION 1, STRUCTURALLY: swapping view_finance -> view_crm on the SELECT
-- policy reddens FB5 and FB6 together.
select fin.val('FB5 the SELECT policy asks for view_finance',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries' and cmd='SELECT'
       and qual like '%permitted_organisations(''view_finance''%'$$, '1');
select fin.val('FB6 ...and NOT for view_crm (the read key is finance''s own, not the CRM''s)',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries' and cmd='SELECT'
       and qual like '%view_crm%'$$, '0');
-- MUTATION 2, STRUCTURALLY: dropping the finance_module conjunct reddens FB7.
select fin.val('FB7 BOTH write policies carry the finance_module (tier) conjunct',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries'
       and cmd in ('INSERT','UPDATE')
       and coalesce(with_check,'') like '%finance_module_organisations%'$$, '2');
-- Q67, STRUCTURALLY: the SELECT policy must NOT carry it, or a downgrade hides
-- the customer's existing finance history instead of freezing it.
select fin.val('FB8 the SELECT policy does NOT carry it (Q67: reads survive a downgrade)',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries' and cmd='SELECT'
       and qual like '%finance_module_organisations%'$$, '0');
select fin.val('FB9 the tier conjunct is in WITH CHECK only, never in the UPDATE''s USING',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries' and cmd='UPDATE'
       and coalesce(qual,'') like '%finance_module_organisations%'$$, '0');
select fin.val('FB10 the UPDATE policy pins (id, organisation_id) via entity_org_unchanged',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries' and cmd='UPDATE'
       and with_check like '%entity_org_unchanged(''financial_entry''%'$$, '1');
select fin.val('FB11 both write policies correlate the parent event on organisation_id',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='financial_entries'
       and cmd in ('INSERT','UPDATE')
       and with_check like '%e.organisation_id = financial_entries.organisation_id%'$$, '2');
select fin.val('FB12 RLS is ENABLED on the table',
  $$select relrowsecurity::text from pg_class
     where oid='public.financial_entries'::regclass$$, 'true');
select fin.val('FB13 authenticated holds SELECT/INSERT/UPDATE and NO DELETE (soft delete is the only delete)',
  $$select string_agg(distinct privilege_type,',' order by privilege_type)
     from information_schema.role_table_grants
     where table_schema='public' and table_name='financial_entries'
       and grantee='authenticated'$$, 'INSERT,SELECT,UPDATE');

-- ===========================================================================
-- FC. THE THREE COMPOSITE FOREIGN KEYS, by column name and delete action
-- ===========================================================================
-- Constraint 4 and Constraint 5. This is the brief's MUTATION 4 catcher, and it
-- has to be structural: single-column-ising the event FK changes NOTHING a
-- behavioural test can see through RLS (the INSERT policy's inline `exists`
-- already refuses a cross-tenant event, and a single-column FK still cascades on
-- delete). The one behavioural consequence is at the constraint layer, with RLS
-- out of the way -- that is FG10, run as postgres.
select fin.val('FC1 the event FK is COMPOSITE, (event_id, organisation_id)',
  $$select string_agg(a.attname, ',' order by k.ord)
     from pg_constraint c
     cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
     where c.conname='financial_entries_event_fkey'$$, 'event_id,organisation_id');
select fin.val('FC2 ...pointing at events (id, organisation_id)',
  $$select c.confrelid::regclass::text || '(' ||
           (select string_agg(a.attname, ',' order by k.ord)
              from unnest(c.confkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum)
           || ')'
     from pg_constraint c where c.conname='financial_entries_event_fkey'$$,
  'public.events(id,organisation_id)');
select fin.val('FC3 ...ON DELETE CASCADE (a line cannot outlive the event it prices)',
  $$select confdeltype from pg_constraint
     where conname='financial_entries_event_fkey'$$, 'c');
select fin.val('FC4 the supplier-contact FK: composite, SET NULL, COLUMN LIST = the link column only',
  $$select (select string_agg(a.attname, ',' order by k.ord)
              from unnest(c.conkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)
           || '|' || c.confdeltype::text || '|' ||
           coalesce((select string_agg(a.attname, ',' order by a.attname)
              from unnest(c.confdelsetcols) as s(attnum)
              join pg_attribute a on a.attrelid=c.conrelid and a.attnum=s.attnum),'<none>')
     from pg_constraint c where c.conname='financial_entries_supplier_contact_fkey'$$,
  'supplier_contact_id,organisation_id|n|supplier_contact_id');
select fin.val('FC5 the artist FK, the same shape on the artist side',
  $$select (select string_agg(a.attname, ',' order by k.ord)
              from unnest(c.conkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)
           || '|' || c.confdeltype::text || '|' ||
           coalesce((select string_agg(a.attname, ',' order by a.attname)
              from unnest(c.confdelsetcols) as s(attnum)
              join pg_attribute a on a.attrelid=c.conrelid and a.attnum=s.attnum),'<none>')
     from pg_constraint c where c.conname='financial_entries_artist_fkey'$$,
  'artist_id,organisation_id|n|artist_id');
select fin.val('FC6 CONTROL: FC1-FC5 inspected FIVE foreign keys in total, not three',
  $$select count(*)::text from pg_constraint
     where conrelid='public.financial_entries'::regclass and contype='f'$$, '5');

-- ===========================================================================
-- FD. THE ROLE GATE -- brief assertion 1, the headline
-- ===========================================================================
-- The mutation: swap view_finance -> view_crm on the SELECT policy. Every
-- "reads 0 of 4" below flips to "reads 4 of 4" and this section goes red six
-- times over.
--
-- N, THE DENOMINATOR, ASSERTED AS POSTGRES (RLS does not apply to the table
-- owner), so every "0 of N" underneath is measured against a number this file
-- proved rather than one it hoped for.
select fin.val('FD0 DENOMINATOR: Finance Event A carries FOUR finance lines',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '4');
select fin.val('FD0b DENOMINATOR: org ALPHA carries EIGHT in total, org BETA one',
  $$select (select count(*)::text from public.financial_entries fe
              join public.organisations o on o.id=fe.organisation_id
             where o.slug='org-alpha') || '/' ||
           (select count(*)::text from public.financial_entries fe
              join public.organisations o on o.id=fe.organisation_id
             where o.slug='org-beta')$$, '8/1');

-- ---- THE POSITIVE HALF: a Finance user at aal2 ----------------------------
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.val('FD1 POSITIVE: a FINANCE user reads all FOUR of Finance Event A''s lines',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '4');
select fin.val('FD2 POSITIVE: ...and all EIGHT of ALPHA''s, and none of BETA''s',
  $$select count(*)::text from public.financial_entries$$, '8');
select fin.val('FD3 POSITIVE: ...and reads the MONEY, not just the row count',
  $$select sum(amount_minor)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '475000');
select fin.try('FD4 POSITIVE: a FINANCE user INSERTs a finance line',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 1234)$$,
         :'alpha_org'), 'ok(1)');
select fin.try('FD5 POSITIVE: ...and UPDATEs one',
  $$update public.financial_entries set description='edited by finance'
     where id='fa110000-0000-0000-0000-000000000005'$$, 'ok(1)');
select fin.try('FD6 POSITIVE: ...and soft-deletes one, which is an UPDATE',
  $$update public.financial_entries set deleted_at=now()
     where id='fa110000-0000-0000-0000-000000000006'$$, 'ok(1)');
select fin.try('FD7 POSITIVE: ...and restores it, which is the same UPDATE in reverse',
  $$update public.financial_entries set deleted_at=null
     where id='fa110000-0000-0000-0000-000000000006'$$, 'ok(1)');
select fin.try('FD8 ...but NOT a hard DELETE -- there is no grant and no policy',
  $$delete from public.financial_entries
     where id='fa110000-0000-0000-0000-000000000006'$$, 'denied(42501)');
-- The live-parent `exists`: a line may not be filed against a soft-deleted event.
select fin.try('FD9 a FINANCE user cannot file a line against a SOFT-DELETED event',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000003','cost', 10)$$,
         :'alpha_org'), 'denied(42501)');
select fin.val('FD10 CONTROL: that event IS readable by the same caller (FD9 is the deleted_at term)',
  $$select count(*)::text from public.events
     where id='ef110000-0000-0000-0000-000000000003'$$, '1');
reset role; reset request.jwt.claims;

-- ---- THE NEGATIVE HALF: six roles, each holding view_crm, each blind -------
--
-- The PAIRING is the whole point. For every role: it reads the PARENT EVENT (so
-- the session, the membership and view_crm all demonstrably work), and it reads
-- ZERO of that event's finance lines. A "reads 0" on its own is satisfied by a
-- broken token.

-- MANAGER -- full scope, holds every CRM key except manage_custom_fields.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select fin.val('FD11 CONTROL: a MANAGER reads the parent event (view_crm works)',
  $$select count(*)::text from public.events
     where id='ef110000-0000-0000-0000-000000000001'$$, '1');
select fin.val('FD12 a MANAGER reads 0 of the 4 finance lines on it',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '0');
select fin.val('FD13 ...and 0 of ALPHA''s 8 in total',
  $$select count(*)::text from public.financial_entries$$, '0');
select fin.try('FD14 a MANAGER''s INSERT is REFUSED',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000001','fee', 1)$$,
         :'alpha_org'), 'denied(42501)');
-- ok(0), not denied -- see the header's stated deviation. The USING clause hides
-- the row, so there is nothing to refuse.
select fin.try('FD15 a MANAGER''s UPDATE matches NOTHING -- ok(0), the USING clause',
  $$update public.financial_entries set amount_minor=1
     where id='fa110000-0000-0000-0000-000000000001'$$, 'ok(0)');
select fin.try('FD16 CONTROL: the same caller''s UPDATE of the parent EVENT writes a row',
  $$update public.events set name='Finance Event A'
     where id='ef110000-0000-0000-0000-000000000001'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- BOOKER -- full scope, manage_events, no finance key.
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select fin.val('FD17 CONTROL: a BOOKER reads the parent event',
  $$select count(*)::text from public.events
     where id='ef110000-0000-0000-0000-000000000001'$$, '1');
select fin.val('FD18 a BOOKER reads 0 of the 4 finance lines on it',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '0');
select fin.try('FD19 a BOOKER''s INSERT is REFUSED',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000001','fee', 1)$$,
         :'alpha_org'), 'denied(42501)');
select fin.try('FD20 a BOOKER''s UPDATE matches NOTHING -- ok(0)',
  $$update public.financial_entries set amount_minor=1
     where id='fa110000-0000-0000-0000-000000000001'$$, 'ok(0)');
select fin.val('FD21 ...and event_finance_summary is empty for them too (security_invoker)',
  $$select count(*)::text from public.event_finance_summary
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '0');
reset role; reset request.jwt.claims;

-- VENUE MANAGER -- full scope.
set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
select fin.val('FD22 CONTROL: a VENUE MANAGER reads the parent event',
  $$select count(*)::text from public.events
     where id='ef110000-0000-0000-0000-000000000001'$$, '1');
select fin.val('FD23 a VENUE MANAGER reads 0 of the 4 finance lines on it',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '0');
select fin.try('FD24 a VENUE MANAGER''s INSERT is REFUSED',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000001','fee', 1)$$,
         :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- MARKETING -- full scope, contacts only.
set role authenticated;
set request.jwt.claims = :'pmarketing_c';
select fin.val('FD25 CONTROL: MARKETING reads the parent event',
  $$select count(*)::text from public.events
     where id='ef110000-0000-0000-0000-000000000001'$$, '1');
select fin.val('FD26 MARKETING reads 0 of the 4 finance lines on it',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '0');
select fin.try('FD27 MARKETING''s INSERT is REFUSED',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000001','fee', 1)$$,
         :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- STANDARD USER -- RECORD-SCOPED, so it is pointed at the event IT OWNS, which
-- carries one finance line of its own. It sees the event and none of the money.
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select fin.val('FD28 CONTROL: a STANDARD USER reads the event THEY OWN',
  $$select count(*)::text from public.events
     where id='ef110000-0000-0000-0000-000000000004'$$, '1');
select fin.val('FD29 a STANDARD USER reads 0 of the 1 finance line on their OWN event',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000004'$$, '0');
select fin.try('FD30 ...and cannot add one to their own event either',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000004','fee', 1)$$,
         :'alpha_org'), 'denied(42501)');
select fin.try('FD31 CONTROL: ...while they CAN edit that same event''s own columns',
  $$update public.events set name='Finance Std1 Event'
     where id='ef110000-0000-0000-0000-000000000004'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- READ ONLY -- record-scoped, view_crm and nothing else. Same construction.
set role authenticated;
set request.jwt.claims = :'pro_c';
select fin.val('FD32 CONTROL: a READ ONLY user reads the event THEY OWN',
  $$select count(*)::text from public.events
     where id='ef110000-0000-0000-0000-000000000005'$$, '1');
select fin.val('FD33 a READ ONLY user reads 0 of the 1 finance line on it',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000005'$$, '0');
select fin.try('FD34 ...and their INSERT is REFUSED',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000005','fee', 1)$$,
         :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- THE OTHER TWO KEY-HOLDERS, so "only finance" is not misread as "only the
-- Finance role": an Owner and an Admin at aal2 hold both keys too.
set role authenticated;
set request.jwt.claims = :'powner_c';
select fin.val('FD35 CONTROL: an OWNER reads all four lines (owner holds view_finance)',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '4');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'padmin_c';
select fin.val('FD36 CONTROL: an ADMIN reads all four too',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '4');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- FE. THE TIER GATE -- brief assertion 2, the inert-machinery proof
-- ===========================================================================
-- private.finance_module_organisations() ships with the `s.organisation_id is
-- null` escape, and public.create_organisation() writes no subscription row, so
-- in normal operation this control does nothing and NOTHING ELSE IN THE PRODUCT
-- WOULD NOTICE IF IT WERE DELETED. This section is the only thing that will. It
-- is rls_phase2_crm.sql section N, aimed at finance_module instead of
-- crm_writes.
--
-- It is also where the OTHER refusal shape lives: a Finance user CAN see the
-- row (SELECT is not tier-gated), so a Starter-tier UPDATE reaches WITH CHECK
-- and raises 42501 rather than quietly matching nothing. That distinction is
-- the whole reason the tier conjunct is in WITH CHECK and not in USING
-- (20260903003000), and FB9 asserts the shape that produces it.
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.try('FE1 BASELINE: no subscription row, a finance write is allowed',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 11)$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- PRO. finance_module = true.
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'alpha_org'::uuid, 'pro', 'monthly', 1, 'active', now() + interval '30 days')
on conflict (organisation_id) do update set plan_id='pro', status='active';

set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.try('FE2 PRO: the INSERT still succeeds',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 22)$$,
         :'alpha_org'), 'ok(1)');
select fin.try('FE3 PRO: and so does the UPDATE',
  $$update public.financial_entries set description='pro edit'
     where id='fa110000-0000-0000-0000-000000000005'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- STARTER. finance_module = false, crm_writes still TRUE -- which is what makes
-- FE7 below a real control rather than a restatement.
update public.organisation_subscriptions set plan_id='starter'
 where organisation_id = :'alpha_org'::uuid;

set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.try('FE4 STARTER: the INSERT is REFUSED -- a loud 42501, not a silent 0',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 33)$$,
         :'alpha_org'), 'denied(42501)');
select fin.try('FE5 STARTER: the UPDATE is REFUSED the same way (WITH CHECK, not USING)',
  $$update public.financial_entries set description='starter edit'
     where id='fa110000-0000-0000-0000-000000000005'$$, 'denied(42501)');
select fin.try('FE5b STARTER: even the soft-delete is refused (it is the same UPDATE)',
  $$update public.financial_entries set deleted_at=now()
     where id='fa110000-0000-0000-0000-000000000005'$$, 'denied(42501)');
-- Q67, BEHAVIOURALLY: the four pre-existing lines are still all four there.
select fin.val('FE6 STARTER: SELECT still returns all FOUR pre-existing lines (Q67, read-only survival)',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '4');
select fin.val('FE6b STARTER: ...with their amounts intact, so nothing was hidden or zeroed',
  $$select sum(amount_minor)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '475000');
reset role; reset request.jwt.claims;
-- THE CONTROL THAT MAKES FE4/FE5 ABOUT FINANCE. Starter carries crm_writes, so
-- a NON-finance write by a different role succeeds in the same instant. Without
-- this, "Starter refuses" is satisfied by a subscription row that refuses
-- everything.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select fin.try('FE7 CONTROL: on the SAME Starter row a MANAGER''s CRM write succeeds (crm_writes=true)',
  $$update public.contacts set title='starter-era title'
     where id='22220000-0000-0000-0000-000000000002'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- Back to PRO.
update public.organisation_subscriptions set plan_id='pro'
 where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.try('FE8 PRO AGAIN: writes come back (the gate is the plan, not a one-way door)',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 44)$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- FREE, for completeness: the third plan, finance_module = false.
update public.organisation_subscriptions set plan_id='free'
 where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.try('FE9 FREE: refused, like Starter',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 55)$$,
         :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- past_due INSIDE the grace window, on Pro. private.past_due_grace_days() is 3,
-- and finance_module_organisations() carries the same branch
-- crm_write_organisations() does -- asserted from BOTH sides, because a window
-- that never opens and one that never closes both pass a single-sided test.
update public.organisation_subscriptions
   set plan_id='pro', status='past_due', current_period_end = now() - interval '1 day'
 where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.try('FE10 PAST_DUE on Pro, INSIDE the 3-day grace window: the finance write is KEPT',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 66)$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;
update public.organisation_subscriptions
   set current_period_end = now() - interval '4 days'
 where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.try('FE11 PAST_DUE on Pro, PAST the window: closed',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 77)$$,
         :'alpha_org'), 'denied(42501)');
select fin.val('FE11b ...and the READS are still open across all of it (Q67 again)',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '4');
reset role; reset request.jwt.claims;

-- Restore the shipped state: NO subscription row anywhere, exactly as section N
-- does for the CRM gate.
delete from public.organisation_subscriptions where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.try('FE12 RESTORED: back to the inert state, finance writes allowed again',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 88)$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;
select fin.val('FE13 CONTROL: and no subscription row survives this section',
  format($$select count(*)::text from public.organisation_subscriptions
            where organisation_id=%L$$, :'alpha_org'), '0');

-- ===========================================================================
-- FF. THE MFA GATE -- brief assertion 3, the SAME user at aal1 and aal2
-- ===========================================================================
-- There is no aal term in any finance policy. The gate is entirely
-- private.role_requires_mfa('finance') = true (FA7) being consumed inside
-- private.permitted_organisations(), which is why the two halves below are
-- asked of the FUNCTION as well as of the table: a key that is not held is a
-- different failure from a policy that refuses, and only the first is shipped.
--
-- The two claim sets are the SAME fixture user. Nothing but `aal` differs.
set role authenticated;
set request.jwt.claims = :'pfinance_c1';
select fin.val('FF1 aal1: permitted_organisations(''view_finance'') returns NO row for ALPHA',
  format($$select count(*)::text from private.permitted_organisations('view_finance') p
            where p = %L$$, :'alpha_org'), '0');
select fin.val('FF2 aal1: ...nor for ''manage_finance''',
  format($$select count(*)::text from private.permitted_organisations('manage_finance') p
            where p = %L$$, :'alpha_org'), '0');
select fin.val('FF3 aal1: ...nor, in fact, for view_crm -- the gate is per ROLE, not per key',
  format($$select count(*)::text from private.permitted_organisations('view_crm') p
            where p = %L$$, :'alpha_org'), '0');
select fin.val('FF4 aal1: the finance SELECT therefore returns 0 of 4',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '0');
select fin.try('FF5 aal1: the INSERT is REFUSED',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000001','fee', 1)$$,
         :'alpha_org'), 'denied(42501)');
select fin.try('FF6 aal1: the UPDATE matches nothing -- ok(0), the USING clause again',
  $$update public.financial_entries set amount_minor=1
     where id='fa110000-0000-0000-0000-000000000001'$$, 'ok(0)');
select fin.val('FF7 aal1 CONTROL: the session is real and reaches non-gated data',
  $$select count(*)::text from public.subscription_plans$$, '3');
reset role; reset request.jwt.claims;

-- THE SAME USER, aal2. Every FF above must invert, or the zeros are a broken
-- claim set rather than the MFA gate.
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.val('FF8 aal2 POSITIVE: the SAME user''s permitted_organisations(''view_finance'') returns ALPHA',
  format($$select count(*)::text from private.permitted_organisations('view_finance') p
            where p = %L$$, :'alpha_org'), '1');
select fin.val('FF9 aal2 POSITIVE: ...and ''manage_finance'' likewise',
  format($$select count(*)::text from private.permitted_organisations('manage_finance') p
            where p = %L$$, :'alpha_org'), '1');
select fin.val('FF10 aal2 POSITIVE: the SELECT returns all FOUR',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '4');
select fin.try('FF11 aal2 POSITIVE: the INSERT succeeds',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','cost', 99)$$,
         :'alpha_org'), 'ok(1)');
select fin.try('FF12 aal2 POSITIVE: the UPDATE writes a row',
  $$update public.financial_entries set description='aal2 edit'
     where id='fa110000-0000-0000-0000-000000000005'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- A NON-MFA ROLE IS UNAFFECTED, which is what proves the gate is role-scoped
-- rather than a blanket "aal2 to touch anything" that would lock out most of
-- the product. pbooker's fixture claims are aal1 and always were.
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select fin.val('FF13 CONTROL: an aal1 BOOKER still reads the CRM perfectly well',
  $$select count(*)::text from public.events
     where id='ef110000-0000-0000-0000-000000000001'$$, '1');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- FG. CROSS-TENANT -- brief assertion 4, both directions + the constraint layer
-- ===========================================================================
-- pbowner is the BETA OWNER, so they hold view_finance and manage_finance in
-- BETA at aal2 -- a finance key-holder of the other tenant, which is the
-- attacker this section is about.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select fin.val('FG1 a BETA finance key-holder reads ZERO of ALPHA''s lines',
  format($$select count(*)::text from public.financial_entries
            where organisation_id=%L$$, :'alpha_org'), '0');
select fin.val('FG2 ...including by naming an ALPHA line''s id directly',
  $$select count(*)::text from public.financial_entries
     where id='fa110000-0000-0000-0000-000000000001'$$, '0');
select fin.try('FG3 ...their INSERT into ALPHA is REFUSED',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000001','fee', 1)$$,
         :'alpha_org'), 'denied(42501)');
select fin.try('FG4 ...and their UPDATE of an ALPHA line matches nothing -- ok(0)',
  $$update public.financial_entries set amount_minor=1
     where id='fa110000-0000-0000-0000-000000000001'$$, 'ok(0)');
select fin.val('FG5 CONTROL: the same caller reads their OWN BETA line',
  $$select count(*)::text from public.financial_entries
     where id='fa11000b-0000-0000-0000-00000000000b'$$, '1');
select fin.try('FG6 CONTROL: ...and writes one in their own tenant',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef11000b-0000-0000-0000-00000000000b','fee', 5)$$,
         :'beta_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- THE MIRROR. Without it FG1-FG4 pass against a policy that shows ALPHA to
-- everyone and BETA was simply never asked.
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.val('FG7 the ALPHA FINANCE user reads ZERO of BETA''s lines',
  format($$select count(*)::text from public.financial_entries
            where organisation_id=%L$$, :'beta_org'), '0');
select fin.try('FG8 ...their INSERT into BETA is REFUSED',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef11000b-0000-0000-0000-00000000000b','fee', 1)$$,
         :'beta_org'), 'denied(42501)');
-- THE FORGED-TENANT VARIANT: tag the row ALPHA (which the caller may write) but
-- point event_id at BETA's event. The INSERT policy's inline `exists`
-- correlates the two, so this is 42501 before the FK is ever consulted.
select fin.try('FG9 ...and tagging the row ALPHA while naming a BETA event is refused too',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef11000b-0000-0000-0000-00000000000b','fee', 1)$$,
         :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- THE CONSTRAINT LAYER, AS POSTGRES, WHERE NO POLICY IS IN THE WAY.
--
-- This is the brief's MUTATION 4 behavioural catcher, and the reason FC1-FC3
-- exist. RLS covers `authenticated`; the composite FK is what covers every
-- writer RLS does not apply to (postgres, a future SECURITY DEFINER function, a
-- DBA repair script). Single-column-ising financial_entries_event_fkey makes
-- FG10 succeed -- an ALPHA-tagged finance line filed against a BETA event, which
-- is a cross-tenant write.
select fin.try('FG10 CONSTRAINT LAYER: even as POSTGRES, an ALPHA line on a BETA event is refused (23503)',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef11000b-0000-0000-0000-00000000000b','fee', 1)$$,
         :'alpha_org'), 'denied(23503)');
select fin.try('FG11 CONTROL: the SAME statement with the ALPHA event succeeds as postgres',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000002','fee', 1)$$,
         :'alpha_org'), 'ok(1)');
select fin.try('FG12 CONSTRAINT LAYER: a cross-tenant supplier_contact_id is refused too',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor, supplier_contact_id)
           values (%L,'ef110000-0000-0000-0000-000000000002','fee', 1,
                   '2222000b-0000-0000-0000-00000000000b')$$,
         :'alpha_org'), 'denied(23503)');
select fin.try('FG13 CONTROL: ...and the same line with an ALPHA contact is accepted',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor, supplier_contact_id)
           values (%L,'ef110000-0000-0000-0000-000000000002','fee', 1,
                   '22220000-0000-0000-0000-000000000002')$$,
         :'alpha_org'), 'ok(1)');

-- ===========================================================================
-- FH. entity_org_unchanged -- brief assertion 5, the two-org admin
-- ===========================================================================
-- pmulti is an ADMIN OF BOTH organisations at aal2, so they hold manage_finance
-- in each. Multi-org membership ships at MVP (CLAUDE.md section Tenancy model),
-- so this is an ordinary user, not a contrived one. financial_entries has no
-- owner column, which makes private.entity_org_unchanged('financial_entry', ...)
-- the ONLY thing standing between them and moving a money line between tenants.
set role authenticated;
set request.jwt.claims = :'pmulti_c';
select fin.val('FH1 CONTROL: pmulti really does hold manage_finance in BOTH organisations',
  $$select count(*)::text from private.permitted_organisations('manage_finance')$$, '2');
-- (a) organisation_id alone: WITH CHECK is evaluated before the FK, so this is
-- 42501 rather than the 23503 the composite FK would otherwise give.
select fin.try('FH2 moving a line to the OTHER tenant (organisation_id alone) is REFUSED',
  format($$update public.financial_entries set organisation_id=%L
            where id='fa110000-0000-0000-0000-000000000001'$$, :'beta_org'),
  'denied(42501)');
-- (b) organisation_id AND event_id together, so the composite FK is SATISFIED
-- and only entity_org_unchanged can refuse it. This is the sharp version: the
-- statement a two-org admin would actually write.
select fin.try('FH3 ...and so is moving organisation_id AND event_id together (FK satisfied, guard refuses)',
  format($$update public.financial_entries
              set organisation_id=%L,
                  event_id='ef11000b-0000-0000-0000-00000000000b'
            where id='fa110000-0000-0000-0000-000000000001'$$, :'beta_org'),
  'denied(42501)');
select fin.try('FH4 CONTROL: an ordinary in-tenant edit by the SAME caller succeeds',
  $$update public.financial_entries set description='multi-org admin edit'
     where id='fa110000-0000-0000-0000-000000000001'$$, 'ok(1)');
select fin.val('FH5 ...and the line is still in ALPHA afterwards',
  format($$select (organisation_id = %L)::text from public.financial_entries
            where id='fa110000-0000-0000-0000-000000000001'$$, :'alpha_org'), 'true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- FI. THE CUSTOM-FIELD VALUE PATH -- brief assertion 7, at the POLICY layer
-- ===========================================================================
-- tests/integration/crm/finance-custom-field-values-rls.test.ts already proves
-- this through public.set_custom_field_values (the RPC the application calls).
-- This section is deliberately the OTHER layer: a direct INSERT/SELECT against
-- public.custom_field_values, so the three dispatch arms
-- (entity_is_visible/manageable/live for 'financial_entry') are exercised by the
-- POLICIES rather than by the RPC that wraps them, and the finance keys they
-- name are proven to be what actually gates the value.
insert into public.custom_field_definitions
  (id, organisation_id, entity_type, key, label, field_type)
select 'aaaaf000-0000-0000-0000-00000000000f', o.id, 'financial_entry',
       'cost_centre', 'Cost centre', 'text'
from public.organisations o where o.slug='org-alpha';

set role authenticated;
set request.jwt.claims = :'pfinance_c';
select fin.try('FI1 POSITIVE: a FINANCE user writes a financial_entry custom-field VALUE',
  format($$insert into public.custom_field_values
             (organisation_id, field_id, entity_type, entity_id, value)
           values (%L,'aaaaf000-0000-0000-0000-00000000000f','financial_entry',
                   'fa110000-0000-0000-0000-000000000001','"CC-100"'::jsonb)$$,
         :'alpha_org'), 'ok(1)');
select fin.val('FI2 POSITIVE: ...and reads it back',
  $$select value #>> '{}' from public.custom_field_values
     where entity_type='financial_entry'
       and entity_id='fa110000-0000-0000-0000-000000000001'$$, 'CC-100');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbooker_c';
select fin.val('FI3 a BOOKER reads 0 of the 1 financial_entry custom-field value',
  $$select count(*)::text from public.custom_field_values
     where entity_type='financial_entry'$$, '0');
select fin.try('FI4 ...and their write of one is REFUSED',
  format($$insert into public.custom_field_values
             (organisation_id, field_id, entity_type, entity_id, value)
           values (%L,'aaaaf000-0000-0000-0000-00000000000f','financial_entry',
                   'fa110000-0000-0000-0000-000000000002','"CC-BOOKER"'::jsonb)$$,
         :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;
-- THE NON-VACUITY CONTROL: the same Booker session WRITES an ARTIST
-- custom-field value and READS IT BACK in the same instant, so FI3/FI4 are the
-- finance arm talking and not a dead session or a missing grant.
--
-- IT WRITES ITS OWN SUBJECT RATHER THAN READING A PHASE 2 FIXTURE. The first
-- draft read bbbb0000-...0002 and got 0: an earlier suite in this same run
-- DELETES that row (rls_phase2_crm.sql exercises the custom_field_values DELETE
-- policy on it), so the control was measuring another file's leftovers. A
-- control that depends on a row four suites away is a control that reddens for
-- reasons its own text cannot explain.
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select fin.try('FI5 CONTROL: the same BOOKER writes an ARTIST custom-field value',
  format($$insert into public.custom_field_values
             (organisation_id, field_id, entity_type, entity_id, value)
           values (%L,'aaaa0000-0000-0000-0000-000000000001','artist',
                   '44440000-0000-0000-0000-000000000001','"booker rider"'::jsonb)$$,
         :'alpha_org'), 'ok(1)');
select fin.val('FI6 CONTROL: ...and reads that same value back',
  $$select value #>> '{}' from public.custom_field_values
     where field_id='aaaa0000-0000-0000-0000-000000000001'
       and entity_id='44440000-0000-0000-0000-000000000001'$$, 'booker rider');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- FJ. ON DELETE BEHAVIOUR -- brief assertion 6. LAST: it destroys fixtures.
-- ===========================================================================
-- Two opposite behaviours on one table, and each is a deliberate choice:
--   event           ON DELETE CASCADE -- a finance line cannot outlive the event
--                   it prices (Q68: event_id is NOT NULL).
--   contact/artist  SET NULL (column list) -- the line survives, unlinked. The
--                   COLUMN LIST is load-bearing (Constraint 5): a bare SET NULL
--                   on a composite key nulls organisation_id too, which is NOT
--                   NULL, so the parent delete would raise 23502 instead of
--                   succeeding. FJ2/FJ3 are the assertions that catch that.

-- ---- the SET NULL half, FIRST (it leaves the line counts alone) -----------
select fin.val('FJ1 BEFORE: the linked line names both a supplier contact and an artist',
  $$select (supplier_contact_id is not null)::text || '/' ||
           (artist_id is not null)::text
     from public.financial_entries
     where id='fa110000-0000-0000-0000-000000000004'$$, 'true/true');
select fin.try('FJ2 deleting the referenced CONTACT succeeds (a bare SET NULL would raise 23502)',
  $$delete from public.contacts
     where id='2222f000-0000-0000-0000-00000000000f'$$, 'ok(1)');
select fin.try('FJ3 deleting the referenced ARTIST likewise',
  $$delete from public.artists
     where id='4444f000-0000-0000-0000-00000000000f'$$, 'ok(1)');
select fin.val('FJ4 the finance line SURVIVES both deletions',
  $$select count(*)::text from public.financial_entries
     where id='fa110000-0000-0000-0000-000000000004'$$, '1');
select fin.val('FJ5 ...with ONLY the two link columns nulled -- organisation_id and the money intact',
  format($$select (supplier_contact_id is null)::text || '/' ||
                  (artist_id is null)::text || '/' ||
                  (organisation_id = %L)::text || '/' ||
                  amount_minor::text
            from public.financial_entries
            where id='fa110000-0000-0000-0000-000000000004'$$, :'alpha_org'),
  'true/true/true/75000');
select fin.val('FJ6 CONTROL: Finance Event A still carries all FOUR of its lines',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '4');

-- ---- the CASCADE half. Its denominator is READ, not assumed ---------------
-- Finance Event B has absorbed every positive-control INSERT in this file, so
-- its line count is whatever the run produced. It is captured here and used as
-- the expected value below, which is what makes "the count drops by the event's
-- line count" an assertion rather than a hope.
select count(*)::text as feb_before from public.financial_entries
 where event_id='ef110000-0000-0000-0000-000000000002' \gset
select count(*)::text as alpha_before from public.financial_entries fe
  join public.organisations o on o.id = fe.organisation_id
 where o.slug='org-alpha' \gset

select fin.val('FJ7 DENOMINATOR: Finance Event B carries a non-zero number of lines',
  format($$select (%L::int > 0)::text$$, :'feb_before'), 'true');
select fin.try('FJ8 deleting the parent EVENT succeeds',
  $$delete from public.events where id='ef110000-0000-0000-0000-000000000002'$$, 'ok(1)');
select fin.val('FJ9 ...and every one of its finance lines CASCADED away',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000002'$$, '0');
select fin.val('FJ10 ...so ALPHA''s total dropped by EXACTLY that event''s line count',
  format($$select (%L::int - (select count(*) from public.financial_entries fe
                                join public.organisations o on o.id = fe.organisation_id
                               where o.slug='org-alpha'))::text$$, :'alpha_before'),
  :'feb_before');
select fin.val('FJ11 CONTROL: Finance Event A and its four lines are untouched',
  $$select count(*)::text from public.financial_entries
     where event_id='ef110000-0000-0000-0000-000000000001'$$, '4');

-- ---- LEAVE THE FIXTURE AS WE FOUND IT ------------------------------------
-- The HTTP block in run-rls-tests.sh PATCHes every ALPHA contact and asserts the
-- number of rows written, so the one contact this file added had to leave again
-- -- FJ2 did that. Asserted rather than assumed, because a silent fixture leak
-- surfaces as a red assertion in a different suite whose text says nothing
-- about finance.
select fin.val('FJ12 HOUSEKEEPING: the contact and the artist this file added are gone',
  $$select count(*)::text from (
      select 1 from public.contacts where id='2222f000-0000-0000-0000-00000000000f'
      union all
      select 1 from public.artists  where id='4444f000-0000-0000-0000-00000000000f'
    ) s$$, '0');

-- ===========================================================================
-- Results
-- ===========================================================================
\o
\echo ''
\echo '========== PHASE 5 FINANCE RLS SUITE =========='
select seq, case when pass then 'PASS' else '**FAIL**' end as result,
       label, expected, actual
from fin.results order by seq;

\echo ''
select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from fin.results;

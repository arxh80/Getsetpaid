-- ===========================================================================
-- Phase 6 (Network) RLS suite -- THE PRIVATE/NETWORK BOUNDARY PROOF.
--
-- Covers
--   20260904000000  the three tables, the N3 CHECK, the closed vocabulary
--   20260904001000  private.network_publish_organisations()  (the TIER gate)
--   20260904002000  view_network / manage_network_profile /
--                   manage_network_connections               (the ROLE gate)
--   20260904003000  the eleven policies + the transition guard
--   20260904004000  the TWO MASKING VIEWS -- the security control of the phase
--   20260904005000  private.audit_network_row()
--
-- RUN IT WITH:  supabase/tests/run-rls-tests.sh
--   It runs AFTER rls_phase5_finance.sql and reuses the SAME fixtures whole --
--   the twelve users and orgs ALPHA and BETA, and the Phase 2 companies and
--   venues the profiles speak for. Only network_* rows are created, so the
--   contact/artist/event censuses the HTTP block relies on are untouched.
--
-- IT USES ITS OWN `net` SCHEMA, so a Phase 6 failure is not reported under a
-- Phase 5 heading. The helpers below are rls_phase5_finance.sql's, verbatim,
-- with the schema renamed.
--
-- ===========================================================================
-- WHAT THIS FILE IS FOR
-- ===========================================================================
-- CLAUDE.md calls the private/network split "the highest-risk boundary" and
-- § Testing gates calls network-leakage tests the ones that "matter most".
-- This is that suite, written alongside the feature rather than after it.
--
-- The boundary has FOUR independent controls and this file drives each of them
-- both ways round:
--
--   ROWS    the base table's RLS -- which profiles exist for this caller.
--   COLUMNS the two masking views -- which fields of them are legible.
--   VALUES  network_profiles_hidden_fields_are_null -- a hidden field is not
--           merely masked at read time, it is NULL in the base column (N3).
--   REACH   pg_depend over the views -- no private table is in a discovery
--           path, structurally, so no future edit can put one there quietly
--           (N2).
--
-- SECTIONS (every negative paired with a positive control, every count with a
-- denominator -- Constraint 14):
--   NA  the constraint layer: the closed vocabulary and N3, as `authenticated`
--   NB  the permission catalogue, read out of the database
--   ND  THE DEPENDENCY ASSERTION (N2) -- the headline structural guard
--   NC  the column-list assertion, against the measured base-table width
--   NM  the masking assertion, BEHAVIOURALLY, across the tenant boundary
--   NG  `anon` holds nothing (N6), five objects inspected
--   NT  THE FREE-TIER GATE (Q76) -- the inert-machinery proof
--   NR  the self-request and live-pair lifecycle guards (Q79 as changed)
--   NU  the TWO update policies, and the transition trigger behind them
--   NL  network_links has no counterparty path (Q82)
--   NS  SOURCE-SHAPE guards, with denominators
--   NF  the FORWARD ratings guard (Q85/N5)
--   NX  the audit rows (Q84)
--   NZ  housekeeping: this file leaves no subscription row behind
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a WITH CHECK / INSERT policy fail.
--   denied(23514)  rejected by a CHECK -- constraint layer, every writer.
--   denied(23505)  rejected by a UNIQUE index -- constraint layer.
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
--
-- psql vars required (supplied by run-rls-tests.sh's P2VARS): the twelve
--   fixture users' claims as `<user>_c` (realistic aal) and `<user>_c1` (aal1).
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists net cascade;
create schema net;

create table net.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function net.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into net.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function net.try(p_label text, p_sql text, p_expected text)
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
  perform net.record(p_label, p_expected, v_actual);
end $$;

create function net.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform net.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema net to authenticated, anon, service_role;
grant execute on function net.record(text,text,text) to authenticated, anon, service_role;
grant execute on function net.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function net.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null

select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset

-- ===========================================================================
-- Fixtures -- FOUR PROFILES, planted as postgres.
--
-- THE FIELD VISIBILITY IS THE FIXTURE. Every masking assertion in § NM is a
-- statement about the ALPHA published profile below, whose seven publishable
-- fields are deliberately spread across all three levels:
--
--   city          network      -> visible to any logged-in member       (NM)
--   headline      network      -> a second `network` field, so "city works"
--                                 is not a single-column coincidence
--   contact_email connections  -> INVISIBLE in the directory, visible in the
--                                 connected view once accepted             (NM)
--   bio           connections  -> the second connections field, same reason
--   region/country/website_url  absent from the map entirely, i.e. HIDDEN,
--                                 and therefore NULL in the base columns --
--                                 which the N3 half of § NM reads AS POSTGRES.
--
-- BETA gets a published profile too (the request target and the symmetry
-- control) and ALPHA gets a DRAFT (the "a draft is not discoverable" control).
-- ===========================================================================
insert into public.network_profiles
  (id, organisation_id, entity_kind, entity_id, status, field_visibility,
   display_name, headline, bio, city, contact_email, published_at)
select 'e0110000-0000-0000-0000-00000000000a', :'alpha_org'::uuid,
       'company', '11110000-0000-0000-0000-000000000002', 'published',
       '{"headline":"network","city":"network","bio":"connections","contact_email":"connections"}'::jsonb,
       'Alpha Promotions', 'Independent promoter', 'Twenty years of shows',
       'Bristol', 'bookings@alpha.test', now();

insert into public.network_profiles
  (id, organisation_id, entity_kind, entity_id, status, field_visibility,
   display_name, city, published_at)
select 'e0110000-0000-0000-0000-00000000000b', :'beta_org'::uuid,
       'company', '1111000b-0000-0000-0000-00000000000b', 'published',
       '{"city":"network"}'::jsonb,
       'Beta Bookings', 'Leeds', now();

-- ALPHA's DRAFT. Not discoverable by anyone but ALPHA.
insert into public.network_profiles
  (id, organisation_id, entity_kind, entity_id, status, field_visibility,
   display_name)
select 'e0110000-0000-0000-0000-00000000000d', :'alpha_org'::uuid,
       'venue', '55550000-0000-0000-0000-000000000002', 'draft',
       '{"city":"network"}'::jsonb,
       'Alpha Draft Venue';

-- BETA's SOFT-DELETED published profile. The `deleted_at is null` control.
insert into public.network_profiles
  (id, organisation_id, entity_kind, entity_id, status, field_visibility,
   display_name, published_at, deleted_at)
select 'e0110000-0000-0000-0000-00000000000e', :'beta_org'::uuid,
       'venue', '5555000b-0000-0000-0000-00000000000b', 'published',
       '{}'::jsonb, 'Beta Deleted Venue', now(), now();

select net.val('N00 FIXTURE: four profiles exist -- 2 published live, 1 draft, 1 deleted',
  $$select count(*) filter (where status='published' and deleted_at is null)::text || '/' ||
           count(*) filter (where status='draft')::text || '/' ||
           count(*) filter (where deleted_at is not null)::text
      from public.network_profiles$$, '2/1/1');

-- ===========================================================================
-- NA. THE CONSTRAINT LAYER, AS `authenticated`.
--
-- Driven as a real client rather than as postgres, for 20260829011500's exact
-- reason: private.network_visibility_is_valid() is called from a CHECK, a CHECK
-- expression is evaluated as the INSERTING role, and without the EXECUTE grant
-- every client insert would fail 42501 (a privilege error) instead of 23514 (a
-- constraint violation). Those are different strings in the same column, and
-- only running it as `authenticated` can tell them apart. U20/U20a do the same
-- for the custom-field options check.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';

select net.try('NA1 CONTROL: a WELL-FORMED visibility map is accepted (23514 vs 42501 oracle)',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name, field_visibility, city)
           values ('e0110000-0000-0000-0000-0000000000a1', %L, 'venue',
                   '55550000-0000-0000-0000-000000000001', 'Vocab Control',
                   '{"city":"network"}'::jsonb, 'Bath')$$, :'alpha_org'), 'ok(1)');

select net.try('NA2 an UNKNOWN KEY is refused by the CHECK, not by a privilege error',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name, field_visibility)
           values ('e0110000-0000-0000-0000-0000000000a2', %L, 'venue',
                   '55550000-0000-0000-0000-000000000001', 'Bad Key',
                   '{"phone":"network"}'::jsonb)$$, :'alpha_org'), 'denied(23514)');

select net.try('NA3 an UNKNOWN LEVEL (a typo for "network") is refused the same way',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name, field_visibility)
           values ('e0110000-0000-0000-0000-0000000000a3', %L, 'venue',
                   '55550000-0000-0000-0000-000000000001', 'Bad Level',
                   '{"city":"netwrok"}'::jsonb)$$, :'alpha_org'), 'denied(23514)');

-- Q71 IS ENFORCED IN BOTH DIRECTIONS: display_name and entity_kind are always
-- network-visible, so they are REJECTED as keys. A level that cannot be set
-- cannot be mis-set.
select net.try('NA4 display_name is REJECTED as a visibility key (always network, Q71)',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name, field_visibility)
           values ('e0110000-0000-0000-0000-0000000000a4', %L, 'venue',
                   '55550000-0000-0000-0000-000000000001', 'Always Visible',
                   '{"display_name":"hidden"}'::jsonb)$$, :'alpha_org'), 'denied(23514)');

-- N3, at the constraint layer: a hidden (or absent) field may not carry a value.
select net.try('NA5 N3: a field left out of the map (= hidden) may NOT carry a value',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name, field_visibility, region)
           values ('e0110000-0000-0000-0000-0000000000a5', %L, 'venue',
                   '55550000-0000-0000-0000-000000000001', 'Hidden With Value',
                   '{}'::jsonb, 'Somerset')$$, :'alpha_org'), 'denied(23514)');

select net.try('NA5b N3: an EXPLICITLY hidden field may not carry a value either',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name, field_visibility, region)
           values ('e0110000-0000-0000-0000-0000000000a6', %L, 'venue',
                   '55550000-0000-0000-0000-000000000001', 'Explicit Hidden',
                   '{"region":"hidden"}'::jsonb, 'Somerset')$$, :'alpha_org'), 'denied(23514)');

select net.try('NA5c CONTROL: the SAME value with region at `network` is accepted',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name, field_visibility, region)
           values ('e0110000-0000-0000-0000-0000000000a7', %L, 'venue',
                   '55550000-0000-0000-0000-000000000001', 'Shown Region',
                   '{"region":"network"}'::jsonb, 'Somerset')$$, :'alpha_org'), 'denied(23505)');

-- ...and Q81's biconditional, both ways.
select net.try('NA6 Q81: a `published` profile with no published_at is refused',
  format($$insert into public.network_profiles
             (organisation_id, entity_kind, entity_id, display_name, status)
           values (%L,'venue','55550000-0000-0000-0000-000000000001','No Timestamp','published')$$,
         :'alpha_org'), 'denied(23514)');
select net.try('NA6b Q81: a `draft` profile WITH a published_at is refused too',
  format($$insert into public.network_profiles
             (organisation_id, entity_kind, entity_id, display_name, published_at)
           values (%L,'venue','55550000-0000-0000-0000-000000000001','Stray Timestamp',now())$$,
         :'alpha_org'), 'denied(23514)');

reset role; reset request.jwt.claims;

-- NA5c above expects 23505 rather than ok(1), and that is not a fudge: NA1
-- already planted a live profile for venue 55550000-...-0001, and
-- network_profiles_entity_unique (Q74, ONE profile per private record) refuses
-- the second. What NA5c proves is that the refusal moved from 23514 to 23505 --
-- i.e. the N3 CHECK no longer objects once region is at `network`, which is the
-- control NA5/NA5b need. Stated because an unexplained 23505 reads as a bug.
select net.val('NA7 CONTROL: NA1''s row really is what makes NA5c a 23505 (Q74, one per record)',
  $$select count(*)::text from public.network_profiles
     where entity_id='55550000-0000-0000-0000-000000000001' and deleted_at is null$$, '1');

-- Tidy NA1's row away so the census in § NM stays the four fixtures.
delete from public.network_profiles where id='e0110000-0000-0000-0000-0000000000a1';

-- ===========================================================================
-- NB. The permission catalogue, read out of the database.
-- ===========================================================================
select net.val('NB1 the three network keys exist',
  $$select string_agg(key, ',' order by key) from public.permissions
     where key like 'view_network' or key like 'manage_network%'$$,
  'manage_network_connections,manage_network_profile,view_network');

-- M1f's SET IS UNCHANGED, and this is the assertion that says so from THIS
-- file as well as from rls_phase2_crm.sql -- a reviewer's first question about
-- a new READ key is whether it moved that set.
select net.val('NB2 view_crm is STILL the only survives_suspension key (M1f unchanged)',
  $$select string_agg(key, ',' order by key) from public.permissions
     where survives_suspension$$, 'view_crm');

select net.val('NB3 view_network is held by all NINE roles (Free is a view-only network tier)',
  $$select count(*)::text from public.role_permissions where permission_key='view_network'$$, '9');
select net.val('NB4 manage_network_profile is held by owner/admin/manager/marketing',
  $$select string_agg(role_key, ',' order by role_key) from public.role_permissions
     where permission_key='manage_network_profile'$$, 'admin,manager,marketing,owner');
select net.val('NB5 manage_network_connections is held by six roles',
  $$select string_agg(role_key, ',' order by role_key) from public.role_permissions
     where permission_key='manage_network_connections'$$,
  'admin,booker,manager,marketing,owner,venue_manager');

-- MFA IS COVERED FOR FREE, and this is the proof rather than the claim: an
-- aal1 OWNER session holds NONE of the three keys, because role_requires_mfa
-- ('owner') is true and permitted_organisations folds that in. No network
-- policy carries an aal term, so if this were false the whole gate would be
-- missing and nothing else here would notice.
set role authenticated;
set request.jwt.claims = :'powner_c1';
select net.val('NB6 an aal1 OWNER holds NONE of the three network keys (MFA, folded in)',
  $$select (select count(*) from private.permitted_organisations('view_network'))::text || '/' ||
           (select count(*) from private.permitted_organisations('manage_network_profile'))::text || '/' ||
           (select count(*) from private.permitted_organisations('manage_network_connections'))::text$$,
  '0/0/0');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
-- THE BOOLEAN, NOT THE COUNT. powner is an owner of THREE organisations in the
-- shared fixtures (org-alpha plus the two merge orgs), and how many of them are
-- live at this point in the run is a fact about OTHER suites, not about the MFA
-- gate. Asserting an exact number would couple this control to fixtures it says
-- nothing about; "none" versus "some" is the whole of what NB6 needs.
select net.val('NB6b CONTROL: the SAME owner at aal2 holds all three (NB6 is the gate, not a dead session)',
  $$select ((select count(*) from private.permitted_organisations('view_network')) > 0)::text || '/' ||
           ((select count(*) from private.permitted_organisations('manage_network_profile')) > 0)::text || '/' ||
           ((select count(*) from private.permitted_organisations('manage_network_connections')) > 0)::text$$,
  'true/true/true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- ND. THE DEPENDENCY ASSERTION (N2) -- THE HEADLINE STRUCTURAL GUARD.
--
-- Global Constraints N2: "No private table in a discovery path -- ENFORCED
-- STRUCTURALLY, NOT BY REVIEW." Read out of pg_depend/pg_rewrite, which is the
-- planner's own record of what a view reads.
--
-- ===========================================================================
-- WIDENED IN FIX ROUND 1 (review finding I1), BECAUSE IT HAD A DEMONSTRATED
-- BYPASS AND THIS COMMENT CLAIMED IT DID NOT
-- ===========================================================================
-- The first version filtered `t.relkind = 'r' and t.relnamespace = 'public'`,
-- and this paragraph said "a join added to either view puts a name in this set
-- whatever the SQL looks like". THAT WAS FALSE, and it was false about the
-- phase's most load-bearing guard -- a Constraint 13 violation.
--
-- pg_depend records a view->VIEW dependency as the referenced VIEW's pg_class
-- row (relkind 'v'), never transitively as that view's own base tables. So a
-- relkind='r' filter cannot see one. A cross-SCHEMA join (auth.users, say) was
-- invisible for the same reason. MEASURED on this stack, in a rolled-back
-- transaction, with network_directory rewritten to
-- `... left join public.activity_events a on a.organisation_id = p.organisation_id`:
--
--   OLD (relkind='r', public only)   network_profiles (1)              <- BLIND
--   NEW (any relkind, any schema)    public.activity_events,
--                                    public.network_profiles (2)       <- caught
--
-- That mattered: the schema's only other two `public` views are
-- public.activity_events and public.event_finance_summary, and BOTH are views
-- over tenant-private data -- precisely the class N2 exists to keep out of a
-- discovery path. It was the one mutation the Task 1 mutation set did not try
-- (M3 joined public.companies, which is a TABLE and therefore visible).
--
-- SO: no relkind filter and no namespace filter on the referenced object, and
-- the name is reported SCHEMA-QUALIFIED so a same-named relation in another
-- schema is a different string rather than a collision.
--
-- FUNCTIONS ARE COUNTED SEPARATELY (net.view_fn_deps below) rather than folded
-- in: a view that calls a SECURITY DEFINER helper reading a private table is
-- the same leak wearing a different hat, and the connected view legitimately
-- calls one (private.permitted_organisations), so the two sets have different
-- expected values and must not share an assertion.
--
-- THE PAIRED NON-VACUITY CONTROL is the same query over
-- public.event_finance_summary, which must return {public.financial_entries}.
-- Without it, a query that saw nothing at all would return the empty set for
-- both views and pass -- the exact vacuity D11b was added to catch elsewhere.
-- ===========================================================================
create view net.view_deps as
  select v.relname as viewname,
         coalesce(string_agg(distinct tn.nspname || '.' || t.relname, ','
                             order by tn.nspname || '.' || t.relname), '<none>') as tables,
         count(distinct tn.nspname || '.' || t.relname)::text as n
    from pg_catalog.pg_class v
    join pg_catalog.pg_rewrite rw on rw.ev_class = v.oid
    join pg_catalog.pg_depend d
      on d.objid = rw.oid and d.classid = 'pg_catalog.pg_rewrite'::regclass
    -- NO relkind AND NO namespace FILTER. A view, a materialised view, a
    -- foreign table, a partitioned table and a relation in `auth` are all
    -- things a discovery view must not read, and every one of them was
    -- invisible before fix round 1.
    join pg_catalog.pg_class t on t.oid = d.refobjid
    join pg_catalog.pg_namespace tn on tn.oid = t.relnamespace
   -- The `net` schema is included on the VIEW side so ND3b's synthetic probe
   -- below is reported by this exact query rather than by a second copy of it
   -- that could drift.
   where v.relnamespace in ('public'::regnamespace, 'net'::regnamespace)
     and v.relkind = 'v' and t.oid <> v.oid
   group by v.relname;

-- The FUNCTION half. A view's `pg_depend` rows include pg_proc entries for
-- every function its definition calls.
create view net.view_fn_deps as
  select v.relname as viewname,
         coalesce(string_agg(distinct pn.nspname || '.' || p.proname, ','
                             order by pn.nspname || '.' || p.proname), '<none>') as fns,
         count(distinct pn.nspname || '.' || p.proname)::text as n
    from pg_catalog.pg_class v
    join pg_catalog.pg_rewrite rw on rw.ev_class = v.oid
    join pg_catalog.pg_depend d
      on d.objid = rw.oid and d.classid = 'pg_catalog.pg_rewrite'::regclass
     and d.refclassid = 'pg_catalog.pg_proc'::regclass
    join pg_catalog.pg_proc p on p.oid = d.refobjid
    join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
   where v.relnamespace = 'public'::regnamespace and v.relkind = 'v'
   group by v.relname;

select net.val('ND1 network_directory depends on EXACTLY {public.network_profiles}, cardinality 1',
  $$select tables || ' (' || n || ')' from net.view_deps where viewname='network_directory'$$,
  'public.network_profiles (1)');

select net.val('ND2 network_connected_profiles depends on EXACTLY those two, cardinality 2',
  $$select tables || ' (' || n || ')' from net.view_deps
     where viewname='network_connected_profiles'$$,
  'public.network_connection_requests,public.network_profiles (2)');

select net.val('ND3 NON-VACUITY CONTROL: the same query sees event_finance_summary''s dependency',
  $$select tables || ' (' || n || ')' from net.view_deps where viewname='event_finance_summary'$$,
  'public.financial_entries (1)');

-- ND3b IS THE CONTROL THAT PROVES THE WIDENING, AND IT IS SYNTHETIC ON
-- PURPOSE.
--
-- ND1-ND3 cannot tell the widened query from the old one: every view in this
-- schema reads only TABLES, so a relkind='r' filter returns the same answer for
-- all three. The bypass finding I1 demonstrated needs a view that reads a VIEW,
-- and the schema contains none -- which is exactly why the hole survived Task
-- 1's whole mutation set.
--
-- So one is built here, pointed at public.activity_events (a view over
-- tenant-private data, i.e. the real shape of the leak), and net.view_deps --
-- THE SAME VIEW ND1-ND3 USE, not a copy -- is asked what it sees. Under the
-- shipped query it reports the view. Under the old relkind='r' one it reported
-- `<none> (0)`, which is what this assertion would then read.
--
-- It is dropped immediately below, so nothing downstream meets it.
create view net.probe_view_over_view as
  select a.id from public.activity_events a where false;

select net.val('ND3b CONTROL: net.view_deps SEES a view->view dependency (the I1 bypass)',
  $$select tables || ' (' || n || ')' from net.view_deps
     where viewname='probe_view_over_view'$$,
  'public.activity_events (1)');

drop view net.probe_view_over_view;

select net.val('ND3b2 ...and the probe is gone, so nothing downstream reads it',
  $$select count(*)::text from pg_catalog.pg_class
     where relname='probe_view_over_view'$$, '0');

-- THE FUNCTION SET. The directory calls none; the connected view calls exactly
-- one, and it is the permission helper its `exists` needs. A SECURITY DEFINER
-- helper reading a private table would appear here and nowhere else.
-- NOTE THE `coalesce` AND WHY IT IS OUTSIDE THE SUBQUERY. A view that calls no
-- function has NO ROW in net.view_fn_deps at all -- the aggregate inside that
-- view never runs for it -- so the scalar select returns NULL, not the
-- '<none>' string_agg's own coalesce produces. Coalescing the ROW's absence is
-- what makes "calls nothing" and "was not inspected" the same visible answer
-- here; ND3d is the paired control that the query finds a function when there
-- is one to find.
select net.val('ND3c network_directory calls NO function at all',
  $$select coalesce((select fns || ' (' || n || ')' from net.view_fn_deps
                      where viewname='network_directory'), '<none> (0)')$$,
  '<none> (0)');
select net.val('ND3d network_connected_profiles calls EXACTLY private.permitted_organisations',
  $$select fns || ' (' || n || ')' from net.view_fn_deps
     where viewname='network_connected_profiles'$$,
  'private.permitted_organisations (1)');

-- security_invoker is what makes the base policy the SINGLE gate. Without it
-- the views would run as their owner and become a second, independent access
-- surface nothing keeps in step -- the classic view-bypasses-RLS defect.
select net.val('ND4 BOTH views are security_invoker (one gate, not two that drift)',
  $$select (select (c.reloptions::text like '%security_invoker=true%')::text
              from pg_catalog.pg_class c where c.oid='public.network_directory'::regclass)
        || '/' ||
           (select (c.reloptions::text like '%security_invoker=true%')::text
              from pg_catalog.pg_class c where c.oid='public.network_connected_profiles'::regclass)$$,
  'true/true');

-- ===========================================================================
-- NC. THE COLUMN-LIST ASSERTION.
--
-- THE DENOMINATOR IS READ FROM THE CATALOG, NOT HARDCODED. The Task 1 brief
-- asserted the base table has 18 columns; it has 19. A hardcoded denominator
-- that is wrong makes "the view has fewer" true for the wrong reason, and a
-- future column added to network_profiles would not move it. So NC2 measures
-- BOTH numbers and states them, and NC3 asserts the inequality that matters.
-- ===========================================================================
select net.val('NC1 network_directory exposes exactly 11 columns',
  $$select count(*)::text from information_schema.columns
     where table_schema='public' and table_name='network_directory'$$, '11');
select net.val('NC1b network_connected_profiles exposes exactly 11 columns',
  $$select count(*)::text from information_schema.columns
     where table_schema='public' and table_name='network_connected_profiles'$$, '11');

select net.val('NC2 MEASURED: base table 19 columns, directory view 11 (the denominator, from the catalog)',
  $$select (select count(*) from information_schema.columns
              where table_schema='public' and table_name='network_profiles')::text
        || '/' ||
           (select count(*) from information_schema.columns
              where table_schema='public' and table_name='network_directory')::text$$,
  '19/11');

select net.val('NC3 ...and the view is strictly NARROWER than the table it reads',
  $$select ((select count(*) from information_schema.columns
               where table_schema='public' and table_name='network_directory')
            < (select count(*) from information_schema.columns
                 where table_schema='public' and table_name='network_profiles'))::text$$,
  'true');

-- THE TWO NAMES THAT MUST NOT BE THERE. A discovery result identifies a
-- PROFILE, never a tenant and never a tenant's private record.
select net.val('NC4 NEITHER view projects organisation_id or entity_id (0 of 4 possible)',
  $$select count(*)::text from information_schema.columns
     where table_schema='public'
       and table_name in ('network_directory','network_connected_profiles')
       and column_name in ('organisation_id','entity_id')$$, '0');

select net.val('NC4b CONTROL: the base table HAS both columns (NC4 is not vacuous)',
  $$select count(*)::text from information_schema.columns
     where table_schema='public' and table_name='network_profiles'
       and column_name in ('organisation_id','entity_id')$$, '2');

-- The eleven, by name, so a column swapped for another is red even at 11.
select net.val('NC5 the directory''s eleven columns, by name',
  $$select string_agg(column_name, ',' order by column_name)
      from information_schema.columns
     where table_schema='public' and table_name='network_directory'$$,
  'bio,city,contact_email,country,display_name,entity_kind,headline,id,published_at,region,website_url');

-- ===========================================================================
-- NM. THE MASKING ASSERTION, BEHAVIOURALLY, ACROSS THE TENANT BOUNDARY.
--
-- Org ALPHA published a profile with city='Bristol' at `network` and
-- contact_email at `connections`. Read it as a BETA member.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pbowner_c';

select net.val('NM1 CONTROL: a BETA member SEES ALPHA''s published profile in the directory',
  $$select display_name from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Alpha Promotions');

select net.val('NM2 POSITIVE: a `network` field (city) resolves for them -- the mask is not blanket',
  $$select city from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Bristol');

select net.val('NM3 THE FINDING: a `connections` field (contact_email) is NULL in the directory',
  $$select coalesce(contact_email,'<null>') from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, '<null>');
select net.val('NM3b ...and so is the second one (bio), so NM3 is not one-column luck',
  $$select coalesce(bio,'<null>') from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, '<null>');

-- The connected view returns NOTHING yet -- there is no accepted request.
select net.val('NM4 the CONNECTED view is empty for them before any request is accepted',
  $$select count(*)::text from public.network_connected_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, '0');

-- A DRAFT and a SOFT-DELETED profile are not discoverable.
select net.val('NM5 ALPHA''s DRAFT profile is invisible to BETA in the directory',
  $$select count(*)::text from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000d'$$, '0');
select net.val('NM5b ...and so is it in the BASE TABLE (the directory policy needs published)',
  $$select count(*)::text from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000d'$$, '0');
select net.val('NM5c CONTROL: the same caller DOES see ALPHA''s PUBLISHED row in the base table',
  $$select count(*)::text from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, '1');
reset role; reset request.jwt.claims;

-- ALPHA sees its own draft. The pair NM5/NM6 is what makes "invisible" mean
-- "invisible to the OTHER tenant" rather than "invisible, full stop".
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.val('NM6 CONTROL: ALPHA sees its OWN draft (no tier term, no deleted_at term)',
  $$select display_name from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000d'$$, 'Alpha Draft Venue');
reset role; reset request.jwt.claims;

-- ---- N3, READ AS POSTGRES -------------------------------------------------
--
-- FLIP city TO hidden AND WATCH THE BASE COLUMN GO NULL. This is the half the
-- masking views cannot prove: a value that is merely masked at read time is one
-- policy bug away from a leak, and a NULL is not. The UPDATE below NULLs the
-- column in the same statement, which is exactly what
-- lib/network/profiles.ts's setFieldVisibilityAction does -- and the CHECK is
-- what makes doing it any other way impossible.
-- RUN AS ALPHA'S MANAGER, THROUGH THE REAL UPDATE POLICY, not as postgres.
-- Two reasons, both load-bearing: it proves setFieldVisibilityAction's
-- statement is one the policy actually permits, and
-- private.audit_network_row() returns early when auth.uid() is null (a
-- migration or a DBA is not a client action) -- so a postgres-side flip would
-- emit NO audit row and section NX would be asserting against a transition that
-- was never recorded.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NM6b the visibility flip is a write the UPDATE policy PERMITS',
  $$update public.network_profiles
       set field_visibility = field_visibility || '{"city":"hidden"}'::jsonb,
           city = null
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select net.val('NM7 after flipping city to hidden, the ROW still appears in the directory',
  $$select display_name from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Alpha Promotions');
select net.val('NM8 ...and city is now NULL in the view',
  $$select coalesce(city,'<null>') from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, '<null>');
reset role; reset request.jwt.claims;

select net.val('NM9 N3: ...AND THE BASE COLUMN IS NULL TOO, read as postgres',
  $$select coalesce(city,'<null>') from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, '<null>');

-- The CHECK is what enforces NM9 rather than the application remembering.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NM10 the CHECK refuses re-planting a value while city is hidden',
  $$update public.network_profiles set city='Bristol'
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'denied(23514)');
select net.try('NM10b CONTROL: the SAME write with city back at `network` is accepted',
  $$update public.network_profiles
       set field_visibility = field_visibility || '{"city":"network"}'::jsonb,
           city='Bristol'
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- NG. `anon` HOLDS NOTHING (N6). FIVE OBJECTS -- the denominator is stated.
--
-- Q70's "no public, logged-out profiles at MVP" is enforced by the GRANT, not
-- by the absence of a route: the anon key ships in every browser bundle, so a
-- route that does not exist is not a control.
-- ===========================================================================
select net.val('NG1 none of the 5 network objects carries an anon= grant',
  $$select count(*)::text from pg_catalog.pg_class c
     where c.relnamespace='public'::regnamespace
       and c.relname in ('network_profiles','network_links','network_connection_requests',
                         'network_directory','network_connected_profiles')
       and c.relacl::text like '%anon=%'$$, '0');

select net.val('NG1b CONTROL: all 5 objects exist and were inspected (the denominator)',
  $$select count(*)::text from pg_catalog.pg_class c
     where c.relnamespace='public'::regnamespace
       and c.relname in ('network_profiles','network_links','network_connection_requests',
                         'network_directory','network_connected_profiles')$$, '5');

select net.val('NG2 CONTROL: `authenticated` DOES hold a grant on all 5 (NG1 is not "no ACL at all")',
  $$select count(*)::text from pg_catalog.pg_class c
     where c.relnamespace='public'::regnamespace
       and c.relname in ('network_profiles','network_links','network_connection_requests',
                         'network_directory','network_connected_profiles')
       and c.relacl::text like '%authenticated=%'$$, '5');

-- No DELETE grant on any of the three tables -- soft delete is the only delete.
select net.val('NG3 no DELETE grant on any of the three tables',
  $$select count(*)::text from information_schema.role_table_grants
     where table_schema='public' and grantee='authenticated'
       and privilege_type='DELETE'
       and table_name in ('network_profiles','network_links','network_connection_requests')$$, '0');
select net.val('NG3b CONTROL: they hold 9 SELECT/INSERT/UPDATE grants between them',
  $$select count(*)::text from information_schema.role_table_grants
     where table_schema='public' and grantee='authenticated'
       and privilege_type in ('SELECT','INSERT','UPDATE')
       and table_name in ('network_profiles','network_links','network_connection_requests')$$, '9');

-- ===========================================================================
-- NT. THE FREE-TIER GATE (Q76) -- THE INERT-MACHINERY PROOF.
--
-- The network analogue of rls_phase2_crm.sql § N, and it is the ONLY thing
-- that will notice if private.network_publish_organisations() breaks, because
-- the gate is inert in the shipped state (create_organisation writes no
-- subscription row, so every org matches the escape).
--
-- WHEN PHASE 7 REMOVES THE ESCAPE, NT1 MUST BE RE-READ AND ITS EXPECTED RESULT
-- FLIPPED -- not re-run and found green. An inert gate makes a wrong test green
-- (FOLLOW-UPS.md § Phase 5), and NT1 is precisely the assertion that would stay
-- green for the wrong reason.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NT1 NO SUBSCRIPTION ROW: a manage_network_profile holder INSERTs a profile (the ESCAPE)',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name, field_visibility)
           values ('e0110000-0000-0000-0000-0000000000f1', %L, 'venue',
                   '55550000-0000-0000-0000-000000000001', 'Escape Profile', '{}'::jsonb)$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- A REAL free row. network_publish = false.
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'alpha_org'::uuid, 'free', 'monthly', 1, 'active', now() + interval '30 days')
on conflict (organisation_id) do update set plan_id='free', status='active';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NT2 FREE: the SAME INSERT is now refused with 42501 (a loud refusal, not a silent 0)',
  format($$insert into public.network_profiles
             (organisation_id, entity_kind, entity_id, display_name, field_visibility)
           values (%L,'artist','44440000-0000-0000-0000-000000000001','Free Profile','{}'::jsonb)$$,
         :'alpha_org'), 'denied(42501)');
select net.try('NT3 FREE: an UPDATE of the pre-existing profile is refused too',
  $$update public.network_profiles set display_name='Renamed On Free'
     where id='e0110000-0000-0000-0000-0000000000f1'$$, 'denied(42501)');
-- Q81: a downgrade FREEZES writing; it never hides a customer's own data.
select net.val('NT4 FREE: ...while the SELECT of that same row still returns it (Q81)',
  $$select display_name from public.network_profiles
     where id='e0110000-0000-0000-0000-0000000000f1'$$, 'Escape Profile');
select net.val('NT4b FREE: ...and browsing the DIRECTORY still works -- Free is a view-only tier',
  $$select count(*)::text from public.network_directory$$, '2');
reset role; reset request.jwt.claims;

update public.organisation_subscriptions set plan_id='starter'
 where organisation_id = :'alpha_org'::uuid;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NT5 STARTER: writes come back (the gate is the plan, not a one-way door)',
  $$update public.network_profiles set display_name='Escape Profile'
     where id='e0110000-0000-0000-0000-0000000000f1'$$, 'ok(1)');
reset role; reset request.jwt.claims;

delete from public.organisation_subscriptions where organisation_id = :'alpha_org'::uuid;

-- ---- THE ROLE GATE, paired -----------------------------------------------
-- A BOOKER holds view_network and manage_network_connections but NOT
-- manage_network_profile. The pairing is what makes the finding meaningful:
-- the booker reads the profile (so session, membership and view_network all
-- demonstrably work) and cannot publish one.
set role authenticated;
set request.jwt.claims = :'pbooker_c';
-- THE ORG IDS COME FROM psql VARIABLES, NOT FROM A SUBQUERY ON
-- public.organisations, and that is not a style choice. `organisations` has its
-- own SELECT policy: an ALPHA booker cannot read org-beta's row, so
-- `(select id from public.organisations where slug='org-beta')` evaluates to
-- NULL for this caller and the outer filter matches nothing -- which would make
-- this assertion pass for a reason that has nothing to do with the network. The
-- variables are resolved as postgres at the top of this file, so what is
-- measured here is the network policy alone.
--
-- 3 / 1. ALPHA holds its published profile, its draft and section NT's escape
-- profile, all three visible to its own member through the own-select policy.
-- Of BETA's two rows at this point in the run the booker sees exactly ONE: the
-- published live profile, through the DIRECTORY policy. The soft-deleted one is
-- filtered by that policy's `deleted_at is null`, and BETA's second published
-- profile does not exist yet -- section NR creates it below.
select net.val('NT6 CONTROL: a BOOKER reads ALPHA''s 3 own profiles, and 1 of BETA''s 2 (the published live one)',
  format($$select (select count(*) from public.network_profiles
                     where organisation_id = %L)::text
                || '/' ||
                  (select count(*) from public.network_profiles
                     where organisation_id = %L)::text$$,
         :'alpha_org', :'beta_org'),
  '3/1');
select net.try('NT7 a BOOKER''s profile INSERT is refused (no manage_network_profile)',
  format($$insert into public.network_profiles
             (organisation_id, entity_kind, entity_id, display_name, field_visibility)
           values (%L,'artist','44440000-0000-0000-0000-000000000001','Booker Profile','{}'::jsonb)$$,
         :'alpha_org'), 'denied(42501)');
-- ok(0), not denied: the UPDATE policy carries the key in its USING clause, so
-- the row is invisible to the statement and there is nothing to refuse. Same
-- distinction rls_phase2_crm B17 and rls_phase5_finance FD15 record.
select net.try('NT8 a BOOKER''s profile UPDATE matches NOTHING -- ok(0), the USING clause',
  $$update public.network_profiles set display_name='x'
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'ok(0)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- NR. THE SELF-REQUEST AND LIVE-PAIR LIFECYCLE GUARDS.
--
-- Q79 AS CHANGED BY THE FOUNDER 2026-09-07 (20260907000000): a DECLINED pair
-- may re-request. NR5/NR6 prove that flip; NR6b/NR6c prove what did NOT move
-- (the old declined row survives beside the fresh one, and a LIVE pending row
-- still blocks the pair). The declined ROW itself stays immutable -- that is
-- the transition guard's half, and NR10 still proves it binds `postgres` too.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';

select net.try('NR1 ALPHA cannot request a connection to its OWN profile (23514)',
  format($$insert into public.network_connection_requests
             (from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values (%L,'e0110000-0000-0000-0000-00000000000a',
                   %L,'e0110000-0000-0000-0000-00000000000a')$$,
         :'alpha_org', :'alpha_org'), 'denied(23514)');

select net.try('NR2 CONTROL: the same shape aimed at BETA''s profile SUCCEEDS',
  format($$insert into public.network_connection_requests
             (id, from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values ('c0110000-0000-0000-0000-000000000001', %L,
                   'e0110000-0000-0000-0000-00000000000a',
                   %L, 'e0110000-0000-0000-0000-00000000000b')$$,
         :'alpha_org', :'beta_org'), 'ok(1)');

-- THE FORGERY THE SECOND INLINE `exists` EXISTS FOR: to_organisation_id is a
-- client-supplied column on a table the client may INSERT into.
select net.try('NR3 to_organisation_id cannot be FORGED -- the profile must really be theirs',
  format($$insert into public.network_connection_requests
             (from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values (%L,'e0110000-0000-0000-0000-00000000000a',
                   %L,'e0110000-0000-0000-0000-0000000000f1')$$,
         :'alpha_org', :'beta_org'), 'denied(42501)');

select net.try('NR4 a request may not be sent from a DRAFT profile (Q78)',
  format($$insert into public.network_connection_requests
             (from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values (%L,'e0110000-0000-0000-0000-00000000000d',
                   %L,'e0110000-0000-0000-0000-00000000000b')$$,
         :'alpha_org', :'beta_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- BETA DECLINES. Then ALPHA MAY ask again -- Q79 as changed 2026-09-07
-- (20260907000000): a declined pair no longer occupies the live-pair slot.
-- Until that migration this block asserted the opposite (denied(23505),
-- "declined is terminal"), and flipping it red-to-green was the measurement
-- that the narrowed index actually landed.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select net.try('NR5 the RECIPIENT declines the request',
  $$update public.network_connection_requests
       set status='declined', responded_at=now()
     where id='c0110000-0000-0000-0000-000000000001'$$, 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NR6 Q79 (changed 2026-09-07): a SECOND identical request after a DECLINE succeeds',
  format($$insert into public.network_connection_requests
             (id, from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values ('c0110000-0000-0000-0000-000000000006', %L,
                   'e0110000-0000-0000-0000-00000000000a',
                   %L, 'e0110000-0000-0000-0000-00000000000b')$$,
         :'alpha_org', :'beta_org'), 'ok(1)');

-- WHAT DID NOT MOVE, both halves. The re-request is a FRESH ROW beside the
-- old declined record -- the decline is not resurrected, reopened or hidden
-- (append-only, "a richer record than a tombstone") -- and the narrowed index
-- still refuses a duplicate while a LIVE (pending) request stands, so the
-- narrowing cannot drift into no uniqueness at all.
select net.val('NR6b ...as a FRESH row: the pair now holds the declined record AND the new pending one',
  format($$select string_agg(status, ',' order by status)
             from public.network_connection_requests
            where from_organisation_id=%L
              and to_network_profile_id='e0110000-0000-0000-0000-00000000000b'$$,
         :'alpha_org'), 'declined,pending');
select net.try('NR6c ...and a THIRD request while the new PENDING one stands is still 23505',
  format($$insert into public.network_connection_requests
             (from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values (%L,'e0110000-0000-0000-0000-00000000000a',
                   %L,'e0110000-0000-0000-0000-00000000000b')$$,
         :'alpha_org', :'beta_org'), 'denied(23505)');
reset role; reset request.jwt.claims;

-- THE WITHDRAWN HALF OF THE LIFECYCLE (Q79): the sender retracts, and the
-- pair is free again. (Before 20260907000000 this trio was "the positive
-- control for NR6" -- withdrawn-frees vs. declined-blocks. The contrast is
-- gone; the withdrawn path itself still needs proving through the REAL
-- sender-withdraws policy.)
--
-- IT USES A SECOND BETA PROFILE, ON PURPOSE, and not the declined row above.
-- The obvious shortcut -- flip c...0001 to `withdrawn` as postgres and retry --
-- DOES NOT WORK, and finding that out is itself a result worth recording: the
-- transition guard is a TRIGGER, so it fires for `postgres` too and refuses
-- declined -> withdrawn with 23514. A trigger that only bound RLS-limited
-- callers would be a much weaker control, and this is the cheapest possible
-- demonstration that it is not one.
--
-- So the retry is proven on a fresh pair, through the REAL sender-withdraws
-- policy: send, withdraw as the sender, send the same pair again.
insert into public.network_profiles
  (id, organisation_id, entity_kind, entity_id, status, field_visibility,
   display_name, published_at)
select 'e0110000-0000-0000-0000-00000000000c', :'beta_org'::uuid,
       'venue', '5555000b-0000-0000-0000-00000000000b', 'published',
       '{}'::jsonb, 'Beta Second Room', now()
where not exists (select 1 from public.network_profiles
                   where entity_id='5555000b-0000-0000-0000-00000000000b'
                     and deleted_at is null);

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NR7 a request on a FRESH pair (BETA''s second profile) is accepted',
  format($$insert into public.network_connection_requests
             (id, from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values ('c0110000-0000-0000-0000-000000000002', %L,
                   'e0110000-0000-0000-0000-00000000000a',
                   %L, 'e0110000-0000-0000-0000-00000000000c')$$,
         :'alpha_org', :'beta_org'), 'ok(1)');
-- `responded_at` MOVES WITH THE STATUS, and that is the constraint talking
-- rather than a flourish: network_connection_requests_responded_iff_terminal
-- asserts (status = 'pending') = (responded_at is null), so a withdraw that
-- left responded_at null is a 23514. NR8b measures that half -- it is the exact
-- statement lib/network/connections.ts must NOT write, and the reason
-- withdrawConnectionRequestAction moves BOTH columns in one UPDATE.
select net.try('NR8 a withdraw that leaves responded_at null is refused by the CHECK',
  $$update public.network_connection_requests set status='withdrawn'
     where id='c0110000-0000-0000-0000-000000000002'$$, 'denied(23514)');
select net.try('NR8b the SENDER withdraws it properly, through the real sender-withdraws policy',
  $$update public.network_connection_requests
       set status='withdrawn', responded_at=now()
     where id='c0110000-0000-0000-0000-000000000002'$$, 'ok(1)');
select net.try('NR9 CONTROL: once WITHDRAWN, the pair is free for a fresh request (Q79)',
  format($$insert into public.network_connection_requests
             (id, from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values ('c0110000-0000-0000-0000-000000000003', %L,
                   'e0110000-0000-0000-0000-00000000000a',
                   %L, 'e0110000-0000-0000-0000-00000000000c')$$,
         :'alpha_org', :'beta_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- THE TRIGGER BINDS `postgres` TOO, asserted rather than mentioned. This is the
-- statement the shortcut above would have used.
select net.try('NR10 the transition guard refuses declined -> withdrawn even as POSTGRES',
  $$update public.network_connection_requests set status='withdrawn'
     where id='c0110000-0000-0000-0000-000000000001'$$, 'denied(23514)');
select net.val('NR10b CONTROL: that row is still `declined` (NR10 changed nothing)',
  $$select status from public.network_connection_requests
     where id='c0110000-0000-0000-0000-000000000001'$$, 'declined');

-- ===========================================================================
-- NU. THE TWO UPDATE POLICIES, AND THE TRANSITION TRIGGER BEHIND THEM.
--
-- The subtle one. A single policy with an `or` across the two organisation
-- columns would let a SENDER mark its own request accepted, because neither
-- clause ties the actor to the transition they may make.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NU1 THE FINDING: the SENDER cannot set status=accepted (42501)',
  $$update public.network_connection_requests
       set status='accepted', responded_at=now()
     where id='c0110000-0000-0000-0000-000000000003'$$, 'denied(42501)');
select net.try('NU2 ...nor `declined` -- answering is the recipient''s word alone',
  $$update public.network_connection_requests
       set status='declined', responded_at=now()
     where id='c0110000-0000-0000-0000-000000000003'$$, 'denied(42501)');
select net.val('NU3 CONTROL: the sender CAN see the row (NU1 is WITH CHECK, not invisibility)',
  $$select status from public.network_connection_requests
     where id='c0110000-0000-0000-0000-000000000003'$$, 'pending');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select net.try('NU4 POSITIVE: the RECIPIENT can (the same statement, a different actor)',
  $$update public.network_connection_requests
       set status='accepted', responded_at=now()
     where id='c0110000-0000-0000-0000-000000000003'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- NU5 -- THE RECIPIENT CANNOT WITHDRAW. REWRITTEN IN FIX ROUND 1 (I2), AND THE
-- ORIGINAL WAS VACUOUS FOR THE ONE THING IT WAS CITED AS PROVING.
-- ===========================================================================
-- This is the behavioural guard for the deviation the Task 1 report calls its
-- most important line: the sender-withdraws policy's WITH CHECK repeats
-- `from_organisation_id`, because PostgreSQL ORs PERMISSIVE policies in the
-- WITH CHECK clause as well as the USING clause, so a bare
-- `status = 'withdrawn'` is satisfiable by a RECIPIENT whose USING passed
-- through the OTHER policy.
--
-- THE FIRST VERSION RAN AGAINST `c...0003` IMMEDIATELY AFTER NU4 SET IT TO
-- `accepted`. That row is TERMINAL, so the BEFORE UPDATE transition trigger
-- raises 23514 before the WITH CHECK is ever evaluated -- the expected value
-- was itself the tell, since a policy refusal is 42501 (as NU1/NU2 correctly
-- expect). Reverting the WITH CHECK term left it GREEN: the trigger refused the
-- statement either way. It asserted the trigger and was cited as asserting the
-- policy.
--
-- SO IT RUNS ON A **PENDING** ROW NOW. The trigger permits every transition out
-- of `pending`, which leaves the two policies as the only thing that can refuse
-- -- and 42501, not 23514, is what a policy refusal looks like. The SENDER
-- doing the same statement on the SAME row is the positive control: identical
-- SQL, identical row, different actor, opposite outcome. That pair is the
-- statement that distinguishes the shipped policy from the brief's.
-- ===========================================================================
insert into public.network_profiles
  (id, organisation_id, entity_kind, entity_id, status, field_visibility,
   display_name, published_at)
select 'e0110000-0000-0000-0000-00000000000f', :'beta_org'::uuid,
       'agency', '3333000b-0000-0000-0000-00000000000b', 'published',
       '{}'::jsonb, 'Beta Withdraw Probe', now();

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NU5a FIXTURE: a fresh PENDING request, so the trigger cannot pre-empt the policy',
  format($$insert into public.network_connection_requests
             (id, from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values ('c0110000-0000-0000-0000-000000000004', %L,
                   'e0110000-0000-0000-0000-00000000000a',
                   %L, 'e0110000-0000-0000-0000-00000000000f')$$,
         :'alpha_org', :'beta_org'), 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select net.val('NU5b CONTROL: the RECIPIENT can see the row and it really is pending',
  $$select status from public.network_connection_requests
     where id='c0110000-0000-0000-0000-000000000004'$$, 'pending');
select net.try('NU5 THE FINDING: the RECIPIENT cannot set `withdrawn` -- 42501, the POLICY refusing',
  $$update public.network_connection_requests
       set status='withdrawn', responded_at=now()
     where id='c0110000-0000-0000-0000-000000000004'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NU5c POSITIVE CONTROL: the SENDER runs the IDENTICAL statement and it applies',
  $$update public.network_connection_requests
       set status='withdrawn', responded_at=now()
     where id='c0110000-0000-0000-0000-000000000004'$$, 'ok(1)');

-- ===========================================================================
-- NU5d/NU5e/NU5f -- to_organisation_id IS DERIVED, NOT SUPPLIED (fix round 1,
-- review finding I4).
--
-- The column is NOT NULL, and sendConnectionRequestAction used to require it
-- from the form. NOTHING COULD SUPPLY IT: public.network_directory is the only
-- sanctioned way to find a foreign profile and deliberately does not project
-- organisation_id, and reading it off public.network_profiles for a foreign
-- organisation is forbidden by that table's own directory policy. So the
-- send-from-directory flow had no legal source for the value.
--
-- private.fill_connection_request_recipient() (20260904006000) derives it from
-- to_network_profile_id when the caller OMITS it -- which the action now always
-- does. NU5c has just withdrawn the request against this profile, so the
-- live-pair index leaves the pair free for a fresh request.
--
-- NU5f is the half that keeps NR3 meaningful: the trigger fills only when NULL,
-- so a SUPPLIED-and-wrong value is still the policy's problem and still 42501.
-- An unconditional overwrite would have turned that forged insert into a silent
-- success and deleted the assertion.
-- ===========================================================================
select net.try('NU5d I4: a request INSERT that OMITS to_organisation_id is ACCEPTED',
  format($$insert into public.network_connection_requests
             (id, from_organisation_id, from_network_profile_id,
              to_network_profile_id)
           values ('c0110000-0000-0000-0000-000000000005', %L,
                   'e0110000-0000-0000-0000-00000000000a',
                   'e0110000-0000-0000-0000-00000000000f')$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

select net.val('NU5e ...and the trigger derived BETA''s organisation from the profile',
  format($$select (to_organisation_id = %L)::text
             from public.network_connection_requests
            where id='c0110000-0000-0000-0000-000000000005'$$,
         :'beta_org'), 'true');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NU5f CONTROL: a SUPPLIED-and-wrong to_organisation_id is still refused (NR3 still means something)',
  format($$insert into public.network_connection_requests
             (from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values (%L,'e0110000-0000-0000-0000-00000000000a',
                   %L,'e0110000-0000-0000-0000-00000000000b')$$,
         :'alpha_org', :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- ...and the mirror hole, on a pending row, so the pair is complete in both
-- directions: NU1/NU2 already prove the sender cannot ACCEPT or DECLINE, and
-- NU5/NU5c prove the recipient cannot WITHDRAW while the sender can.

set role authenticated;
set request.jwt.claims = :'pbowner_c';
-- THE TRANSITION TRIGGER. Terminal means final: an accepted request cannot go
-- back to pending, even though `pending` would otherwise just fail the WITH
-- CHECK -- and, more to the point, cannot be flipped to another terminal value.
select net.try('NU6 THE TRIGGER: an ACCEPTED row cannot move back to `pending` (23514)',
  $$update public.network_connection_requests
       set status='pending', responded_at=null
     where id='c0110000-0000-0000-0000-000000000003'$$, 'denied(23514)');
select net.try('NU7 ...nor sideways to `declined` (the WITH CHECK would allow the landing value)',
  $$update public.network_connection_requests set status='declined'
     where id='c0110000-0000-0000-0000-000000000003'$$, 'denied(23514)');
reset role; reset request.jwt.claims;

-- NOW THE PAYOFF (N4): the accepted connection resolves ALPHA's `connections`
-- fields for BETA -- AND NOTHING ELSE.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select net.val('NU8 PAYOFF: the connected view now returns ALPHA''s profile for BETA',
  $$select display_name from public.network_connected_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Alpha Promotions');
select net.val('NU9 ...and a `connections` field (contact_email) now RESOLVES',
  $$select contact_email from public.network_connected_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'bookings@alpha.test');
select net.val('NU10 ...while the DIRECTORY view still masks it (two views, two levels)',
  $$select coalesce(contact_email,'<null>') from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, '<null>');
-- N4: an accepted connection grants NO access to any tenant table.
-- THE ORG ID IS A psql VARIABLE HERE FOR THE SAME REASON AS NT6, AND HERE IT IS
-- THE DIFFERENCE BETWEEN A FINDING AND A VACUITY. Written as a subquery on
-- public.organisations, this assertion returned 0/0/0 because a BETA caller
-- cannot read org-alpha's ROW -- so it was measuring the organisations policy,
-- not the network boundary, and would have stayed green through any leak of
-- ALPHA's contacts. Resolved as postgres at the top of the file, the 0/0/0 is
-- what N4 actually claims: an accepted connection unlocks NO tenant table.
select net.val('NU11 N4: the connection unlocks NO tenant data -- ALPHA''s contacts/notes/finance',
  format($$select (select count(*) from public.contacts where organisation_id = %L)::text
                || '/' ||
                  (select count(*) from public.notes where organisation_id = %L)::text
                || '/' ||
                  (select count(*) from public.financial_entries where organisation_id = %L)::text$$,
         :'alpha_org', :'alpha_org', :'alpha_org'),
  '0/0/0');
select net.val('NU11b CONTROL: the same caller reads its OWN org''s contacts (NU11 is not a dead session)',
  $$select (count(*) > 0)::text from public.contacts$$, 'true');
reset role; reset request.jwt.claims;
-- THE DENOMINATOR FOR NU11, read as postgres: ALPHA really does hold contacts,
-- notes and finance lines for the connected counterparty to have failed to see.
-- Without this, 0/0/0 is equally satisfied by a tenant that owns nothing.
select net.val('NU11c DENOMINATOR: ALPHA really has contacts, notes and finance lines to leak',
  format($$select ((select count(*) from public.contacts where organisation_id = %L) > 0)::text
                || '/' ||
                  ((select count(*) from public.notes where organisation_id = %L) > 0)::text
                || '/' ||
                  ((select count(*) from public.financial_entries where organisation_id = %L) > 0)::text$$,
         :'alpha_org', :'alpha_org', :'alpha_org'),
  'true/true/true');
set role authenticated;
set request.jwt.claims = :'pbowner_c';
-- Q80's symmetry: the exists is written both ways round, so the ACCEPTOR sees
-- the REQUESTER's connections fields too.
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.val('NU12 Q80 SYMMETRY: the connection resolves the other way round too',
  $$select display_name from public.network_connected_profiles
     where id='e0110000-0000-0000-0000-00000000000b'$$, 'Beta Bookings');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- NL. network_links HAS NO COUNTERPARTY PATH (Q82).
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NL1 ALPHA links BETA''s published profile to its own private company',
  format($$insert into public.network_links
             (id, organisation_id, network_profile_id, private_entity_type, private_entity_id)
           values ('d0110000-0000-0000-0000-000000000001', %L,
                   'e0110000-0000-0000-0000-00000000000b',
                   'company','11110000-0000-0000-0000-000000000002')$$,
         :'alpha_org'), 'ok(1)');
select net.try('NL2 ...but NOT to a DRAFT profile (the inline exists reads status)',
  format($$insert into public.network_links
             (organisation_id, network_profile_id, private_entity_type, private_entity_id)
           values (%L,'e0110000-0000-0000-0000-00000000000d',
                   'venue','55550000-0000-0000-0000-000000000002')$$,
         :'alpha_org'), 'denied(42501)');
select net.try('NL3 ...nor to a SOFT-DELETED profile',
  format($$insert into public.network_links
             (organisation_id, network_profile_id, private_entity_type, private_entity_id)
           values (%L,'e0110000-0000-0000-0000-00000000000e',
                   'venue','55550000-0000-0000-0000-000000000002')$$,
         :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- THE Q82 ASSERTION. BETA owns the profile ALPHA just linked. BETA must not be
-- able to learn that -- knowing who has filed you in their CRM is itself
-- commercially sensitive. The positive control is that ALPHA sees its own link,
-- so "0" is a boundary and not a broken session.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select net.val('NL4 Q82: the PROFILE''S OWNER sees 0 links to their own profile',
  $$select count(*)::text from public.network_links
     where network_profile_id='e0110000-0000-0000-0000-00000000000b'$$, '0');
select net.val('NL4b ...and 0 network links in total',
  $$select count(*)::text from public.network_links$$, '0');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.val('NL5 CONTROL: the LINKING organisation sees its own link (NL4 is a boundary)',
  $$select count(*)::text from public.network_links
     where network_profile_id='e0110000-0000-0000-0000-00000000000b'$$, '1');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- NS. SOURCE-SHAPE GUARDS, WITH DENOMINATORS (Constraint 2 and the
-- single-column-FK replacement guard).
--
-- Constraint 2 is a SHAPE rule and no behavioural test can tell the two forms
-- apart -- the set form and the per-row form return identical rows for every
-- user. So it is guarded here, structurally, read back through pg_get_expr
-- (which deparses the stored node tree, so quoting and whitespace are
-- normalised before the comparison sees them -- the D11 technique).
-- ===========================================================================
create view net.network_policy_exprs as
  select p.polname, c.relname,
         coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
         coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
   where c.relnamespace='public'::regnamespace
     and c.relname in ('network_profiles','network_links','network_connection_requests');

select net.val('NS0 DENOMINATOR: 11 network policies were inspected, and that is non-zero',
  $$select count(*)::text from net.network_policy_exprs$$, '11');

-- The directory policy is the ONE that does not name permitted_organisations,
-- deliberately: it asks "is this an active member of ANY organisation", which
-- is not a per-key question. So 10 of 11.
select net.val('NS1 10 of the 11 use the SET form; the 11th is the directory policy',
  $$select count(*) filter (where expr like '%permitted_organisations(%')::text || '/' ||
           string_agg(polname, ',') filter (where expr not like '%permitted_organisations(%')
      from net.network_policy_exprs$$,
  '10/network_profiles_select_published_directory');

select net.val('NS2 NONE of the 11 uses the per-row has_permission( form',
  $$select count(*)::text from net.network_policy_exprs
     where expr like '%has_permission(%'$$, '0');

-- The six write-gated policies name the tier helper. Six: profiles
-- insert+update, links insert+update, requests insert, requests
-- recipient-responds. The SENDER-WITHDRAWS policy deliberately does not (a Free
-- org must be able to retract).
select net.val('NS3 6 policies name network_publish_organisations; the withdraw policy does not',
  $$select count(*) filter (where expr like '%network_publish_organisations%')::text || '/' ||
           (select count(*) from net.network_policy_exprs
             where polname='network_connection_requests_update_sender_withdraws'
               and expr like '%network_publish_organisations%')::text
      from net.network_policy_exprs$$, '6/0');

-- THE REPLACEMENT GUARD FOR THE SINGLE-COLUMN FK, half one: the SELECT policy
-- on network_links names network_profiles nowhere at all.
select net.val('NS4 Q82: network_links'' SELECT policy contains NO occurrence of network_profiles',
  $$select count(*)::text from net.network_policy_exprs
     where polname='network_links_select_view_network'
       and expr like '%network_profiles%'$$, '0');
select net.val('NS4b CONTROL: the assertion found that policy at all (denominator 1)',
  $$select count(*)::text from net.network_policy_exprs
     where polname='network_links_select_view_network'$$, '1');

-- Half two: the write policies read only `id` and `status` (and deleted_at) from
-- network_profiles. Asserted by the ABSENCE of any other column name that would
-- signal a tenant claim -- most of all organisation_id, which would be exactly
-- the composite FK's semantics smuggled into a policy.
select net.val('NS5 network_links'' write policies name NO network_profiles column beyond id/status/deleted_at',
  $$select count(*)::text from net.network_policy_exprs
     where relname='network_links'
       and (expr like '%p.organisation_id%' or expr like '%p.display_name%'
            or expr like '%p.entity_id%'   or expr like '%p.field_visibility%')$$, '0');
select net.val('NS5b CONTROL: those write policies DO read p.status (the guard is not vacuous)',
  $$select count(*)::text from net.network_policy_exprs
     where relname='network_links' and expr like '%p.status%'$$, '2');

-- NO POLICY GRANTS A NON-OWNING ORGANISATION ANY READ OF network_links.
select net.val('NS6 network_links has exactly ONE select policy, and no other read path',
  $$select count(*)::text from pg_catalog.pg_policy p
     join pg_catalog.pg_class c on c.oid=p.polrelid
    where c.relname='network_links' and p.polcmd in ('r','*')$$, '1');

-- No FOR ALL policy anywhere on the three (a `for all` silently applies USING
-- as the WITH CHECK for INSERT).
select net.val('NS7 none of the 11 is a FOR ALL policy',
  $$select count(*)::text from pg_catalog.pg_policy p
     join pg_catalog.pg_class c on c.oid=p.polrelid
    where c.relnamespace='public'::regnamespace
      and c.relname in ('network_profiles','network_links','network_connection_requests')
      and p.polcmd='*'$$, '0');

-- THE TWO-POLICY SPLIT, structurally: there are exactly two UPDATE policies on
-- the requests table, and neither's WITH CHECK mentions both status verbs.
select net.val('NS8 the requests table has exactly TWO update policies (not one with an `or`)',
  $$select count(*)::text from pg_catalog.pg_policy p
     join pg_catalog.pg_class c on c.oid=p.polrelid
    where c.relname='network_connection_requests' and p.polcmd='w'$$, '2');

-- ===========================================================================
-- NF. THE FORWARD RATINGS GUARD (Q85 / N5).
--
-- CLAUDE.md: "Ratings are permanently private in v1. They never leave the
-- rating organisation's tenant -- not even as an anonymised aggregate on a
-- network profile." public.ratings does not exist yet, so the standing guard is
-- a FORWARD one: NOTHING on the network surface names `rating` in any form, so
-- the day a ratings table lands this assertion is already watching.
--
-- Inspects THREE object classes -- policies, view definitions and function
-- bodies -- and states how many of each it looked at, because a "0 violations"
-- assertion passes perfectly against a suite that inspected nothing.
-- ===========================================================================
create view net.network_surface as
  select 'policy:' || p.polname as objname,
         coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
         coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') as body
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
   where c.relnamespace='public'::regnamespace and c.relname like 'network%'
  union all
  select 'view:' || c.relname,
         pg_catalog.pg_get_viewdef(c.oid)
    from pg_catalog.pg_class c
   where c.relnamespace='public'::regnamespace and c.relkind='v'
     and c.relname like 'network%'
  union all
  select 'function:' || pr.proname,
         pg_catalog.pg_get_functiondef(pr.oid)
    from pg_catalog.pg_proc pr
    join pg_catalog.pg_namespace n on n.oid = pr.pronamespace
   where n.nspname in ('public','private') and pr.proname like 'network%';

select net.val('NF1 N5: NO network policy, view or function body contains the substring `rating`',
  $$select count(*)::text from net.network_surface where body ~* 'rating'$$, '0');

select net.val('NF1b DENOMINATOR: it inspected 11 policies, 2 views and 3 functions (16), non-zero',
  $$select count(*) filter (where objname like 'policy:%')::text || '/' ||
           count(*) filter (where objname like 'view:%')::text || '/' ||
           count(*) filter (where objname like 'function:%')::text || '/' ||
           count(*)::text
      from net.network_surface$$, '11/2/3/16');

-- ...and the same guard over the two masking views' COLUMN lists, which is
-- where an "anonymised aggregate on a network profile" would actually land.
select net.val('NF2 N5: neither masking view exposes a column whose name mentions rating or score',
  $$select count(*)::text from information_schema.columns
     where table_schema='public'
       and table_name in ('network_directory','network_connected_profiles')
       and (column_name ~* 'rating' or column_name ~* 'score')$$, '0');
select net.val('NF2b DENOMINATOR: 22 view columns were inspected',
  $$select count(*)::text from information_schema.columns
     where table_schema='public'
       and table_name in ('network_directory','network_connected_profiles')$$, '22');

-- ===========================================================================
-- NX. THE AUDIT ROWS (Q84; PRD § 15 "Network publishing and changes to
-- visibility").
--
-- Every write above ran under a real session, so the trigger has fired for
-- real. What is asserted here is that it fired for the RIGHT transitions and
-- that its payload carries NO published field's value.
-- ===========================================================================
select net.val('NX1 the visibility flip in § NM emitted a visibility_changed audit row',
  $$select (count(*) > 0)::text from public.audit_events
     where action='network_profile.visibility_changed'
       and target_id='e0110000-0000-0000-0000-00000000000a'$$, 'true');

-- The `requested` count became 6 with the Q79 change (20260907000000): NR6's
-- re-request-after-decline is a real INSERT now, so it audits like any other
-- send -- which is itself worth having on the books, since the re-request is
-- the write the Phase 7 rate limiter (Q86/Q87) will meter.
select net.val('NX2 the § NR/§ NU requests emitted requested / accepted / declined rows',
  $$select (select count(*) from public.audit_events where action='network_connection.requested')::text
        || '/' ||
           (select count(*) from public.audit_events where action='network_connection.accepted')::text
        || '/' ||
           (select count(*) from public.audit_events where action='network_connection.declined')::text$$,
  '6/1/1');

-- THE PAYLOAD DISCIPLINE. audit_events is superuser-readable, and CLAUDE.md
-- § Superuser dashboard keeps tenant record content off that surface. The
-- fixture's published values are the oracle: none of them may appear.
select net.val('NX3 NO published field VALUE appears in any network audit payload',
  $$select count(*)::text from public.audit_events
     where action like 'network_%'
       and (after::text like '%Alpha Promotions%'
         or after::text like '%Bristol%'
         or after::text like '%bookings@alpha.test%'
         or after::text like '%Independent promoter%'
         or after::text like '%Twenty years of shows%')$$, '0');
-- TWO, not one: section NM flips city to hidden and then restores it, and both
-- are real client writes through the UPDATE policy, so both are audited.
select net.val('NX3b CONTROL: those payloads DO carry field_visibility (NX3 is not "empty payloads")',
  $$select count(*)::text from public.audit_events
     where action='network_profile.visibility_changed'
       and after ? 'field_visibility'$$, '2');

-- No audit row for a link (Q82: private, grants nothing) -- stated so the
-- absence reads as a decision rather than an oversight.
select net.val('NX4 network_links emits NO audit row, on purpose (Q82)',
  $$select count(*)::text from public.audit_events
     where target_type='network_link' or action like 'network_link%'$$, '0');

-- ===========================================================================
-- NX5. INSERT-AS-PUBLISHED IS AUDITED (final-review finding, 20260907001000).
--
-- Nothing forces an INSERT to be a draft: the INSERT policy carries no status
-- term and the published_at CHECK is satisfiable at creation. The application
-- always inserts drafts -- but this table's audit lives in the DATABASE
-- precisely because PostgREST plus the anon key bypass the app, so a direct
-- insert-as-published must emit network_profile.published or the one action
-- PRD § 15 names explicitly has an unaudited path. As first shipped it did:
-- 20260904005000's else-arm swallowed every INSERT. NX5b was red against that
-- function and is green against 20260907001000's.
--
-- Two fresh ALPHA venues, because every existing ALPHA entity with a profile
-- occupies its one-live-profile-per-entity slot. Inserted as postgres (fixture,
-- sessionless -- no audit row, which is itself the early-return behaviour);
-- the profile inserts run as pmanager_c through the real INSERT policy.
-- ===========================================================================
insert into public.venues (id, organisation_id, name)
select v.id::uuid, o.id, v.nm
  from public.organisations o, (values
    ('55550000-0000-0000-0000-000000000031', 'NX5 Draft Control Venue'),
    ('55550000-0000-0000-0000-000000000032', 'NX5 Published-At-Birth Venue')
  ) as v(id, nm)
 where o.slug='org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select net.try('NX5 CONTROL: an INSERT as a DRAFT is accepted and stays unaudited',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, status,
              field_visibility, display_name)
           values ('e0110000-0000-0000-0000-0000000000a1', %L, 'venue',
                   '55550000-0000-0000-0000-000000000031', 'draft',
                   '{}'::jsonb, 'NX5 Draft Control')$$,
         :'alpha_org'), 'ok(1)');
select net.try('NX5b a direct INSERT-AS-PUBLISHED is accepted (no status term in the policy)...',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, status,
              field_visibility, display_name, published_at)
           values ('e0110000-0000-0000-0000-0000000000a2', %L, 'venue',
                   '55550000-0000-0000-0000-000000000032', 'published',
                   '{}'::jsonb, 'NX5 Published At Birth', now())$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

select net.val('NX5c ...and it emits EXACTLY ONE network_profile.published row',
  $$select count(*)::text from public.audit_events
     where action='network_profile.published'
       and target_id='e0110000-0000-0000-0000-0000000000a2'$$, '1');
select net.val('NX5d ...while the draft INSERT emitted none (the else-arm survives the fix)',
  $$select count(*)::text from public.audit_events
     where target_id='e0110000-0000-0000-0000-0000000000a1'$$, '0');

-- The published-at-birth profile leaves the platform-wide directory it just
-- entered, so no later suite inherits an extra discoverable row from this
-- section. Soft delete (a de-escalation, unaudited by design), as postgres.
update public.network_profiles set deleted_at = now()
 where id in ('e0110000-0000-0000-0000-0000000000a1',
              'e0110000-0000-0000-0000-0000000000a2');

-- ===========================================================================
-- NZ. HOUSEKEEPING.
--
-- § NT plants and removes a subscription row. Asserted rather than assumed,
-- because a leak surfaces as a red assertion in the HTTP block downstream whose
-- text says nothing about the network.
-- ===========================================================================
-- SCOPED TO ALPHA, DELIBERATELY. Other organisations in the shared fixtures
-- (org-merge, org-http-merge) carry subscription rows their own suites planted,
-- so a bare `count(*) = 0` would assert something this file has no claim over
-- and would go red for a reason nothing here caused. What this file owes is
-- that section NT's free -> starter -> gone sequence really ended at "gone" for
-- org-alpha, which is the state every downstream block was written against.
select net.val('NZ1 HOUSEKEEPING: this file left no ALPHA organisation_subscriptions row behind',
  format($$select count(*)::text from public.organisation_subscriptions
            where organisation_id = %L$$, :'alpha_org'), '0');

-- ===========================================================================
-- Results
-- ===========================================================================
\o
\echo ''
\echo '========== PHASE 6 NETWORK RLS SUITE =========='
select seq, case when pass then 'PASS' else '**FAIL**' end as result,
       label, expected, actual
from net.results order by seq;

\echo ''
select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from net.results;

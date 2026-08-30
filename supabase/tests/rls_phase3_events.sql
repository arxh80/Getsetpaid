-- ===========================================================================
-- Phase 3 (Events) RLS / permission / record-scope test suite.
--
-- Covers everything created by
--   20260901000000_events_and_lineup.sql          (the tables and the grants)
--   20260901010000_manage_events_permission.sql   (the key, and the sixth
--                                                  entity_is_manageable arm)
--   20260901011000_event_rls_policies.sql         (the six policies)
--   20260901020000_event_list_indexes.sql         (the four list indexes --
--                                                  § EX, added by Task 3)
--
-- RUN IT WITH:  supabase/tests/run-rls-tests.sh
--   It runs AFTER rls_phase2_crm.sql and reuses that suite's fixtures whole --
--   the twelve users, org ALPHA and org BETA, the venues and the artists. Only
--   events and lineup rows are created here. Reusing them is not laziness: a
--   second cast of characters would be a second place for the role matrix to
--   drift, and the interesting properties of this phase are about how events
--   sit on top of the Phase 2 record scope rather than beside it.
--
-- IT USES ITS OWN `ev` SCHEMA, NOT `crm`. rls_phase2_crm.sql opens with
-- `drop schema if exists crm cascade`, and its results table is what
-- run-rls-tests.sh counts to decide whether the Phase 2 suite passed. Writing
-- into it would make "Phase 2 CRM suite: all assertions passed" a statement
-- about two suites, and a Phase 3 failure would be reported under a Phase 2
-- heading. The helpers below are that file's, verbatim, with the schema
-- renamed.
--
-- CAST OF CHARACTERS -- rls_phase2_crm.sql's, unchanged:
--
--   Org ALPHA (slug org-alpha)                     Org BETA (slug org-beta)
--   ---------------------------------------------  -------------------------
--   powner      owner            aal2              pbowner  owner      aal2
--   padmin      admin            aal2
--   pmanager    manager          aal1              pmulti   admin in BOTH,
--   pbooker     booker           aal1                       aal2
--   pvenuemgr   venue_manager    aal1
--   pfinance    finance          aal2
--   pmarketing  marketing        aal1
--   pstd1       standard_user    aal1
--   pstd2       standard_user    aal1
--   pro         read_only        aal1
--
-- WHO HOLDS manage_events (founder, Q29, 2026-08-30): owner, admin, manager,
-- booker, venue_manager, standard_user. NOT finance, marketing, read_only.
-- § EA asserts that from the catalogue; §§ EC-ED assert the consequences.
--
-- READ THE EXPECTATION VOCABULARY BEFORE READING THE ASSERTIONS -- copied
-- verbatim from rls_phase2_crm.sql, because the distinctions are the same and
-- restating them differently would be the beginning of them drifting:
--   denied(42501)  the statement was REJECTED -- no grant, or a WITH CHECK /
--                  INSERT policy violation.
--   denied(23503)  rejected by a FOREIGN KEY -- the constraint layer, not RLS.
--                  Task 1's tenant-scoped composite FKs produce this, and the
--                  distinction matters: a 23503 holds for every writer in
--                  every role, including one with no session at all.
--   denied(23505)  rejected by a UNIQUE constraint.
--   ok(0)          the statement was ACCEPTED and matched no rows, because the
--                  USING clause filtered the target out first. Secure, but a
--                  DIFFERENT mechanism from denied(42501), and the tests
--                  assert which one is expected rather than accepting either.
--                  On UPDATE, ok(0) is the signature of "you cannot see it";
--                  denied(42501) is the signature of "you can see it and may
--                  not do that to it".
--
-- POSITIVE CONTROLS ARE MANDATORY HERE. A suite of "expect 0 rows" assertions
-- passes perfectly against a database where every policy denies everything.
-- Every negative below is paired with the positive that proves the path works
-- for somebody, in the same section.
--
-- TWO ROWS IN public.events ALREADY EXIST WHEN THIS FILE STARTS, and every
-- count here is written knowing it: rls_phase2_crm.sql § T32 plants
-- `T Alpha Event` (org ALPHA) and `T Beta Event` (org BETA), both UNOWNED, as
-- the targets of artist_fee_history_event_fkey. They are deliberately NOT
-- filtered out of the reads below -- a `where name like ...` would hide a leak
-- of exactly the row the filter excluded -- so the visibility assertions use
-- `string_agg(name)` and name them.
--
-- psql vars required: powner padmin pmanager pbooker pvenuemgr pfinance
--   pmarketing pstd1 pstd2 pro pbowner pmulti          (uuids)
--   ..._c   claims at that user's realistic assurance level
--   ..._c1  the same user forced to aal1 (the stolen-password session)
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists ev cascade;
create schema ev;

create table ev.results (
  seq      serial primary key,
  label    text,
  expected text,
  actual   text,
  pass     boolean
);

-- SECURITY DEFINER for the same reason crm.record is: the assertions are
-- recorded while the session is switched to `authenticated`, which has no
-- privileges on ev.results.
create function ev.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into ev.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- SCRATCH STORAGE FOR ASSERTIONS THAT COMPARE TWO MOMENTS. § EI records the
-- event and lineup counts a manager sees while org ALPHA is LIVE and compares
-- them against the same counts while it is SUSPENDED -- an equality against a
-- measured baseline rather than a hardcoded number, which is the only form
-- that can tell "suspension left reads alone" from "the fixture was empty".
create table ev.notes (k text primary key, v text);

create function ev.note(p_k text, p_v text)
returns void language sql security definer set search_path = '' as $$
  insert into ev.notes (k, v) values (p_k, p_v)
  on conflict (k) do update set v = excluded.v;
$$;

create function ev.try(p_label text, p_sql text, p_expected text)
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
  perform ev.record(p_label, p_expected, v_actual);
end $$;

-- THE CONSTRAINT-NAMING VARIANT (fix round 1, review finding F.8). Identical
-- to ev.try except that a refusal records WHICH constraint raised it, as
-- `denied(<sqlstate>:<conname>)`.
--
-- It exists because `denied(23503)` is ambiguous on public.event_lineup: BOTH
-- event_lineup_event_fkey and event_lineup_artist_fkey are composite and
-- tenant-scoped, so either could produce that SQLSTATE, and an assertion that
-- accepted the bare code would stay green if the write started being refused
-- by the OTHER end. `CONSTRAINT_NAME` is populated for integrity violations;
-- `<no constraint>` is recorded when it is not, rather than a NULL that would
-- silently compare equal to nothing.
create function ev.try_con(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_rows bigint; v_actual text; v_con text;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_actual := 'ok(' || v_rows || ')';
  exception when others then
    get stacked diagnostics v_con = constraint_name;
    v_actual := 'denied(' || sqlstate || ':'
             || coalesce(nullif(v_con, ''), '<no constraint>') || ')';
  end;
  perform ev.record(p_label, p_expected, v_actual);
end $$;

create function ev.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform ev.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema ev to authenticated, anon, service_role;
grant execute on function ev.record(text,text,text) to authenticated, anon, service_role;
grant execute on function ev.note(text,text)        to authenticated, anon, service_role;
grant select  on ev.notes                           to authenticated, anon, service_role;
grant execute on function ev.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function ev.try_con(text,text,text) to authenticated, anon, service_role;
grant execute on function ev.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null

-- ===========================================================================
-- Fixtures -- EVENTS AND LINEUP ONLY
-- ===========================================================================
-- Both organisation ids are captured here, as postgres, and referenced by
-- literal from every assertion that needs one. rls_phase2_crm.sql's fixture
-- block explains why at length and the reason applies unchanged: any
-- cross-tenant assertion that reaches its target organisation through a SELECT
-- the attacker cannot perform is testing nothing -- the subquery returns no
-- rows, the statement affects zero, and `ok(0)` looks like a denial.
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset

-- Planted as postgres so ownership is exactly what the tests need. The venue
-- on the manager's event is rls_phase2_crm.sql's `Manager Venue`, which is
-- what makes the composite events_venue_fkey a live part of this fixture
-- rather than a column left NULL.
insert into public.events (id, organisation_id, owner_user_id, name, starts_at, venue_id)
select v.id::uuid, o.id, nullif(v.owner,'')::uuid, v.nm, v.st::timestamptz,
       nullif(v.venue,'')::uuid
from public.organisations o, (values
  ('ee110000-0000-0000-0000-000000000001', :'pmanager', 'Alpha Manager Event',
   '2026-10-01 20:00+00', '55550000-0000-0000-0000-000000000002'),
  ('ee110000-0000-0000-0000-000000000002', :'pstd1',    'Std1 Event',
   '2026-10-02 20:00+00', ''),
  ('ee110000-0000-0000-0000-000000000003', :'pstd2',    'Std2 Event',
   '2026-10-03 20:00+00', '')
) as v(id, owner, nm, st, venue) where o.slug='org-alpha';

-- A SOFT-DELETED event, owned by pmanager. § EG is about it: its lineup must
-- stay READABLE (the restore path renders what restoring would bring back) and
-- must not be WRITABLE.
insert into public.events (id, organisation_id, owner_user_id, name, starts_at, deleted_at)
select 'ee110000-0000-0000-0000-000000000004', o.id, :'pmanager', 'Deleted Event',
       timestamptz '2026-10-04 20:00+00', now()
from public.organisations o where o.slug='org-alpha';

insert into public.events (id, organisation_id, owner_user_id, name, starts_at)
select 'ee11000b-0000-0000-0000-00000000000b', o.id, :'pbowner', 'Beta Secret Event',
       timestamptz '2026-10-05 20:00+00'
from public.organisations o where o.slug='org-beta';

-- A SOFT-DELETED ARTIST in ALPHA, for § EH3. It exists to prove a NEGATIVE
-- about the policies -- that no lineup policy consults public.artists, not
-- even for deletion -- which is the one property in this file whose whole
-- value is that it keeps a future "helpful" edit out.
insert into public.artists (id, organisation_id, owner_user_id, name, deleted_at)
select '44440000-0000-0000-0000-00000000000f', o.id, :'pmanager',
       'Phase3 Deleted Artist', now()
from public.organisations o where o.slug='org-alpha';

insert into public.event_lineup (id, organisation_id, event_id, artist_id, position, billing)
select v.id::uuid, o.id, v.ev::uuid, v.ar::uuid, v.pos::int, v.bl
from public.organisations o, (values
  ('ff110000-0000-0000-0000-000000000001','ee110000-0000-0000-0000-000000000001',
   '44440000-0000-0000-0000-000000000002','0','headliner'),
  ('ff110000-0000-0000-0000-000000000002','ee110000-0000-0000-0000-000000000002',
   '44440000-0000-0000-0000-000000000001','0','headliner'),
  ('ff110000-0000-0000-0000-000000000003','ee110000-0000-0000-0000-000000000003',
   '44440000-0000-0000-0000-000000000002','0','headliner'),
  ('ff110000-0000-0000-0000-000000000004','ee110000-0000-0000-0000-000000000004',
   '44440000-0000-0000-0000-000000000002','0','headliner')
) as v(id, ev, ar, pos, bl) where o.slug='org-alpha';

insert into public.event_lineup (id, organisation_id, event_id, artist_id, position, billing)
select 'ff11000b-0000-0000-0000-00000000000b', o.id,
       'ee11000b-0000-0000-0000-00000000000b',
       '4444000b-0000-0000-0000-00000000000b', 0, 'headliner'
from public.organisations o where o.slug='org-beta';

-- ===========================================================================
-- EA. The permission catalogue -- read out of role_permissions, not the file
-- ===========================================================================
-- A matrix that was seeded wrong makes every policy assertion below meaningless
-- in a way that still shows as green. Same reason rls_phase2_crm.sql § A exists,
-- and the mutation this section catches is "granting manage_events to read_only
-- in 20260901010000".
select ev.val('EA1 manage_events exists in the catalogue',
  $$select count(*)::text from public.permissions where key='manage_events'$$, '1');
select ev.val('EA2 ...and it does NOT survive suspension (it is a write key)',
  $$select survives_suspension::text from public.permissions where key='manage_events'$$,
  'false');
select ev.val('EA3 exactly six roles hold it, named -- Q29, 2026-08-30',
  $$select string_agg(role_key,',' order by role_key)
      from public.role_permissions where permission_key='manage_events'$$,
  'admin,booker,manager,owner,standard_user,venue_manager');
-- THE NEGATIVE, WRITTEN AS ITS OWN ASSERTION rather than left implied by EA3's
-- string. The three roles named here are the ones a future "just give everyone
-- events" edit would reach for first, and a count is what goes red when one of
-- them is added.
select ev.val('EA4 finance, marketing and read_only hold it ZERO times',
  $$select count(*)::text from public.role_permissions
     where permission_key='manage_events'
       and role_key in ('finance','marketing','read_only')$$, '0');
-- POSITIVE CONTROL for EA4. Without it the zero above is satisfied by three
-- roles that hold nothing at all -- which would be a different, larger bug
-- and would look identical from here.
select ev.val('EA5 CONTROL: those same three roles DO hold view_crm',
  $$select count(*)::text from public.role_permissions
     where permission_key='view_crm'
       and role_key in ('finance','marketing','read_only')$$, '3');

-- ===========================================================================
-- EB. Tenant isolation, and the SHAPE of the policies that provide it
-- ===========================================================================
-- The mutation: dropping `organisation_id in (select
-- private.permitted_organisations('view_crm'))` from events_select_view_crm,
-- leaving only the record-scope disjunction.
--
-- MEASURED: EB1-EB11 DO NOT CATCH THAT, and the reason is worth knowing before
-- reading them. `private.full_scope_organisations()` is itself membership-
-- scoped, so with the permission term gone a manager still sees no BETA row --
-- the tenant boundary holds on the surviving term alone. What the mutation
-- actually removes is the PERMISSION and MFA half of the read gate, and the
-- assertions that go red are EB13 below (structurally: the policy no longer
-- names permitted_organisations at all), § EJ1 (an aal1 Owner, who holds no
-- permission, reads 9 events instead of 0) and -- ADDED IN FIX ROUND 1 --
-- EB15-EB20 below, which put the case IN this section.
--
-- EB15-EB20 EXIST BECAUSE THE MUTATION OPENS A WIDENING NO OTHER ASSERTION IN
-- ANY SUITE COVERS. The surviving disjunct is
--
--     organisation_id in (select private.full_scope_organisations())
--     or owner_user_id = (select auth.uid())
--
-- and the SECOND HALF OF THAT CARRIES NO ORGANISATION OR MEMBERSHIP TERM AT
-- ALL. `permitted_organisations('view_crm')` is the only thing in this policy
-- that asks whether the caller is still a member. Take it away and a user
-- whose membership has been REVOKED goes on reading every event they own --
-- the live ex-employee read path. EB1-EB11 all run as current, active members,
-- so not one of them can express it however it is counted.
set role authenticated;
set request.jwt.claims = :'pmanager_c';

-- NAMED, NOT COUNTED. A count of five passes against five of the wrong rows,
-- and `T Alpha Event` (rls_phase2_crm.sql § T32) is in this list on purpose --
-- filtering it out would hide a leak of precisely the row the filter removed.
-- `Deleted Event` is here too: RLS does not hide soft-deleted rows (design
-- note (g)), the application does.
select ev.val('EB1 pmanager reads exactly ALPHA''s five events, by name',
  $$select string_agg(name,',' order by name) from public.events$$,
  'Alpha Manager Event,Deleted Event,Std1 Event,Std2 Event,T Alpha Event');
select ev.val('EB2 ...and ZERO of org BETA''s, addressed by its organisation id',
  format($$select count(*)::text from public.events where organisation_id=%L$$,
         :'beta_org'), '0');
select ev.val('EB3 ...including the one addressed by primary key',
  $$select count(*)::text from public.events
     where id='ee11000b-0000-0000-0000-00000000000b'$$, '0');
select ev.val('EB4 event_lineup: zero BETA rows',
  $$select count(*)::text from public.event_lineup
     where id='ff11000b-0000-0000-0000-00000000000b'$$, '0');
select ev.val('EB5 CONTROL: the same reader sees ALPHA''s own lineup rows',
  $$select count(*)::text from public.event_lineup$$, '4');
select ev.try('EB6 INSERT into org BETA is REFUSED, not silently dropped',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'planted', now())$$, :'beta_org'), 'denied(42501)');
select ev.try('EB7 UPDATE of a BETA event matches nothing -- ok(0), not 42501',
  $$update public.events set name='rewritten'
     where id='ee11000b-0000-0000-0000-00000000000b'$$, 'ok(0)');
select ev.try('EB8 CONTROL: the same UPDATE on their OWN event writes a row',
  $$update public.events set name='Alpha Manager Event'
     where id='ee110000-0000-0000-0000-000000000001'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- THE MIRROR, from org BETA. Without it EB1-EB5 are satisfied by a policy that
-- shows ALPHA's rows to everybody and BETA has simply not been asked.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select ev.val('EB9 pbowner reads exactly BETA''s two events, by name',
  $$select string_agg(name,',' order by name) from public.events$$,
  'Beta Secret Event,T Beta Event');
select ev.val('EB10 ...and zero ALPHA events',
  format($$select count(*)::text from public.events where organisation_id=%L$$,
         :'alpha_org'), '0');
select ev.val('EB11 ...and one lineup row, their own',
  $$select count(*)::text from public.event_lineup$$, '1');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- THE SHAPE GUARDS. rls_phase2_crm.sql H12/H13, restated over the two new
-- tables -- and they are not style.
--
-- The per-row form `public.has_permission(organisation_id, 'manage_events')`
-- returns IDENTICAL ROWS FOR EVERY USER to the set form used here, so not one
-- behavioural assertion in this file could tell them apart. What differs is
-- that the set form has no correlation to the row, so the planner hoists it to
-- an InitPlan and runs it ONCE per statement: measured at 23 ms against
-- 5210 ms for a fifty-row page (20260828120500's header). A refactor back to
-- the per-row form would be a 200x regression that this entire suite passes
-- cleanly. These three assertions are the only thing that catches it.
--
-- SIX POLICIES, NOT SEVEN. The task brief said seven; the deployed count is
-- three per table (select, insert, update -- there is no DELETE policy and no
-- DELETE grant), which is exactly the shape of the venues / venue_rooms blocks
-- they were copied from. schema_invariants.sql D11b's 21 is the same fact from
-- the other side: it counts policy EXPRESSIONS, and event_lineup contributes
-- four of them from three policies, because UPDATE has both a USING and a
-- WITH CHECK. EB14 is the denominator, so a policy that was dropped rather
-- than fixed cannot make EB12/EB13 pass by emptying their input.
-- ---------------------------------------------------------------------------
select ev.val('EB12 no Phase 3 policy calls has_permission per row',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename in ('events','event_lineup')
       and (coalesce(qual,'') like '%has_permission(%'
         or coalesce(with_check,'') like '%has_permission(%')$$, '0');
select ev.val('EB13 every Phase 3 policy is built on the hoistable set form',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename in ('events','event_lineup')
       and coalesce(qual,'') || coalesce(with_check,'')
           not like '%permitted_organisations%'$$, '0');
select ev.val('EB14 CONTROL: EB12/EB13 inspected 6 policies, not zero',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename in ('events','event_lineup')$$, '6');

-- ---------------------------------------------------------------------------
-- EB15-EB20. THE REVOKED MEMBER (fix round 1, review finding F.1).
--
-- The one reader for whom `owner_user_id = (select auth.uid())` is true and
-- membership is not. `pstd1`'s ALPHA membership is flipped to `revoked` for
-- the length of three statements and put back; `organisation_memberships`
-- carries no trigger but `set_updated_at`, and this is the only place in the
-- suite that touches it.
--
-- IN AN EXPLICIT TRANSACTION so an abort between the flip and the restore
-- cannot leave the local database with a revoked fixture user. Same reason as
-- the two schema lifts in §§ ED and EF.
--
-- WHY IT DISCRIMINATES, traced against the deployed expression before it was
-- written: unmutated, `permitted_organisations('view_crm')` requires
-- `status = 'active'`, so a revoked pstd1 gets an empty set and the whole
-- conjunction is false -> 0 rows. Under the mutation that term is gone,
-- `full_scope_organisations()` (also active-only) is empty, and
-- `owner_user_id = auth.uid()` is TRUE for their own event -> they read it.
-- EB16 is the assertion that flips; EB20 is the positive control that the zero
-- is the revocation talking and not a broken fixture.
-- ---------------------------------------------------------------------------
begin;

update public.organisation_memberships
   set status = 'revoked'
 where user_id = :'pstd1' and organisation_id = :'alpha_org';

select ev.val('EB15 CONTROL: pstd1''s ALPHA membership really is revoked',
  format($$select status from public.organisation_memberships
            where user_id=%L and organisation_id=%L$$, :'pstd1', :'alpha_org'),
  'revoked');

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select ev.val('EB16 a REVOKED member reads ZERO events -- including the one they OWN',
  $$select count(*)::text from public.events$$, '0');
select ev.val('EB17 ...and zero lineup rows',
  $$select count(*)::text from public.event_lineup$$, '0');
select ev.try('EB18 ...and cannot write one either',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'Revoked Event', now())$$, :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

update public.organisation_memberships
   set status = 'active'
 where user_id = :'pstd1' and organisation_id = :'alpha_org';

select ev.val('EB19 CONTROL: the membership is restored to active',
  format($$select status from public.organisation_memberships
            where user_id=%L and organisation_id=%L$$, :'pstd1', :'alpha_org'),
  'active');

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select ev.val('EB20 POSITIVE: reinstated, they read their own event again',
  $$select coalesce(string_agg(name,',' order by name),'<none>') from public.events$$,
  'Std1 Event');
reset role; reset request.jwt.claims;

commit;

-- ===========================================================================
-- EC. The role matrix, cell by cell
-- ===========================================================================
-- The mutation: granting DELETE on public.events.
--
-- The two POSITIVE cells first, because they are the ones that make every
-- refusal below mean something. Booker and Venue Manager are the pair the key
-- exists for: a Booker holds manage_artists and not manage_venues, a Venue
-- Manager the mirror, and both put on events.
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select ev.try('EC1 POSITIVE: a BOOKER creates an event',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'Booker Event', timestamptz '2026-11-01 20:00+00')$$,
         :'alpha_org'), 'ok(1)');
select ev.try('EC2 ...and DELETE is refused by the missing grant, in every role',
  $$delete from public.events where name='Booker Event'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
select ev.try('EC3 POSITIVE: a VENUE MANAGER creates an event',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'VenueMgr Event', timestamptz '2026-11-02 20:00+00')$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pfinance_c';
select ev.try('EC4 finance cannot create an event (view_crm only)',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'Finance Event', now())$$, :'alpha_org'), 'denied(42501)');
select ev.val('EC5 CONTROL: finance READS events perfectly well',
  $$select (count(*) > 0)::text from public.events$$, 'true');
select ev.try('EC6 finance cannot DELETE either',
  $$delete from public.events where name='Booker Event'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmarketing_c';
select ev.try('EC7 marketing cannot create an event (manage_contacts only)',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'Marketing Event', now())$$, :'alpha_org'), 'denied(42501)');
select ev.val('EC8 CONTROL: marketing READS events',
  $$select (count(*) > 0)::text from public.events$$, 'true');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pro_c';
select ev.try('EC9 read_only cannot create an event',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'ReadOnly Event', now())$$, :'alpha_org'), 'denied(42501)');
-- ok(0), NOT denied(42501), AND THE DIFFERENCE IS THE POINT. read_only is
-- record-scoped (private.full_scope_organisations() excludes it) and owns
-- nothing, so events_update_manage_events' USING clause filters every row out
-- before the WITH CHECK is ever reached. "You cannot see it" and "you can see
-- it and may not do that to it" are different answers and this file asserts
-- which one is expected rather than accepting either.
select ev.try('EC10 read_only UPDATE matches nothing -- ok(0), the USING clause',
  $$update public.events set name='rewritten'
     where id='ee110000-0000-0000-0000-000000000001'$$, 'ok(0)');
select ev.val('EC11 CONTROL: read_only sees ZERO events -- record scope, not the key',
  $$select count(*)::text from public.events$$, '0');
select ev.try('EC12 read_only cannot DELETE',
  $$delete from public.events where id='ee110000-0000-0000-0000-000000000001'$$,
  'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ev.try('EC13 nor can a manager DELETE an event (no grant, not a policy)',
  $$delete from public.events where id='ee110000-0000-0000-0000-000000000003'$$,
  'denied(42501)');
select ev.try('EC14 nor DELETE a lineup row',
  $$delete from public.event_lineup where id='ff110000-0000-0000-0000-000000000001'$$,
  'denied(42501)');
-- THE PAIRED POSITIVE: removal IS available, as an UPDATE. Without this the
-- four DELETE refusals above are satisfied by a table nobody can remove
-- anything from at all, which is a different bug.
select ev.try('EC15 CONTROL: removal is an UPDATE of deleted_at, and it works',
  $$update public.event_lineup set deleted_at=now()
     where id='ff110000-0000-0000-0000-000000000001'$$, 'ok(1)');
select ev.try('EC16 ...and the restore that proves it was a soft delete',
  $$update public.event_lineup set deleted_at=null
     where id='ff110000-0000-0000-0000-000000000001'$$, 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'powner_c';
select ev.try('EC17 not even an aal2 OWNER can DELETE an event',
  $$delete from public.events where id='ee110000-0000-0000-0000-000000000003'$$,
  'denied(42501)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- ED. Record scope -- the Standard User boundary
-- ===========================================================================
-- The mutation: removing the record-scope disjunction from
-- events_update_manage_events.
set role authenticated;
set request.jwt.claims = :'pstd1_c';

-- NAMED, NOT COUNTED, and this is the assertion the section turns on: a count
-- of 1 passes against the WRONG row. `T Alpha Event` is unowned and every other
-- ALPHA event belongs to somebody else, so the correct answer is exactly one
-- name.
select ev.val('ED1 pstd1 sees ONLY their own event, by name',
  $$select coalesce(string_agg(name,',' order by name),'<none>') from public.events$$,
  'Std1 Event');
select ev.try('ED2 ...cannot claim another user''s by rewriting owner_user_id',
  format($$update public.events set owner_user_id=%L
            where id='ee110000-0000-0000-0000-000000000003'$$, :'pstd1'), 'ok(0)');
select ev.try('ED3 ...cannot give their OWN away -- WITH CHECK, so 42501',
  format($$update public.events set owner_user_id=%L
            where id='ee110000-0000-0000-0000-000000000002'$$, :'pstd2'), 'denied(42501)');
select ev.try('ED4 ...cannot create one owned by somebody else',
  format($$insert into public.events (organisation_id, owner_user_id, name, starts_at)
           values (%L,%L,'Std1 Planted', now())$$, :'alpha_org', :'pstd2'),
  'denied(42501)');
-- EXPLICIT NULL, not an omitted column. The omitted case is ED6's positive and
-- it succeeds, because events.owner_user_id carries `default auth.uid()`
-- (20260901000000). Writing NULL on purpose defeats the default and is what a
-- client sending `{"owner_user_id": null}` does.
select ev.try('ED5 ...nor an UNOWNED one, by defeating the default with an explicit null',
  format($$insert into public.events (organisation_id, owner_user_id, name, starts_at)
           values (%L, null,'Std1 Unowned', now())$$, :'alpha_org'), 'denied(42501)');

-- THE FOUR POSITIVES. Without them everything above is satisfied by a policy
-- that refuses a Standard User everything, which is the failure mode a
-- record-scope rule fails into.
select ev.try('ED6 POSITIVE: INSERT with the owner defaulting to them',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'Std1 Created Event', timestamptz '2026-11-03 20:00+00')$$,
         :'alpha_org'), 'ok(1)');
select ev.val('ED7 ...and the default really made THEM the owner',
  format($$select (owner_user_id = %L)::text from public.events
            where name='Std1 Created Event'$$, :'pstd1'), 'true');
select ev.try('ED8 POSITIVE: EDIT their own',
  $$update public.events set notes='mine'
     where id='ee110000-0000-0000-0000-000000000002'$$, 'ok(1)');
select ev.try('ED9 POSITIVE: soft-delete their own',
  $$update public.events set deleted_at=now()
     where id='ee110000-0000-0000-0000-000000000002'$$, 'ok(1)');
select ev.try('ED10 POSITIVE: ...and restore it, which is why SELECT ignores deleted_at',
  $$update public.events set deleted_at=null
     where id='ee110000-0000-0000-0000-000000000002'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- THE RECORD-SCOPE TERM IN `events_update_manage_events`, ASKED WITH THE
-- SELECT POLICY'S COPY OF IT LIFTED.
--
-- ADDED BECAUSE THE MUTATION RUN PROVED ED1-ED10 COULD NOT SEE IT. Removing
-- the record-scope disjunction from BOTH clauses of
-- events_update_manage_events left the ENTIRE suite green -- 999 psql
-- assertions and 195 HTTP checks, zero failures. That is the same class of
-- gap § Y and P11 exist for, and the cause was measured on this stack rather
-- than guessed:
--
--   * ED2's `ok(0)` survived because PostgreSQL applies the SELECT policies to
--     the rows an UPDATE reads, and events_select_view_crm still carried the
--     disjunction -- so pstd2's event was invisible to the statement whatever
--     the UPDATE policy said.
--   * ED3's `denied(42501)` survived because PostgreSQL ALSO applies the
--     SELECT policy to the NEW row of an UPDATE. Measured three ways:
--       UPDATE policy mutated, SELECT intact, new owner = pstd2   -> 42501
--       UPDATE policy mutated, SELECT intact, new owner = pmanager-> 42501
--       BOTH mutated, new owner = pstd2                           -> UPDATE 1
--     The third line is the one that identifies the mechanism: with the SELECT
--     policy's copy of the term gone too, the give-away succeeds.
--
-- So the two policies are each other's backstop on this exact term, and
-- neither can be measured while the other holds. The SELECT policy's
-- disjunction comes off for the length of four statements, the UPDATE policy
-- is asked on its own, and the SELECT policy is put back and compared against
-- what was there.
--
-- SAFETY, TWO LAYERS. ED11 proves the lift really happened, so ED12/ED13 are
-- the UPDATE policy answering and not the old visibility rule. ED15/ED16
-- assert the restore structurally and behaviourally.
--
-- AND THE WHOLE LIFT RUNS INSIDE AN EXPLICIT TRANSACTION (fix round 1, review
-- finding F.7). `\set ON_ERROR_STOP on` guarantees an abort between the
-- `alter policy` and its restore is reachable, and the previous version left
-- that case to a comment telling the reader to reset the database. Policy DDL
-- is transactional in PostgreSQL and `set role` / `set request.jwt.claims`
-- work inside a transaction block, so an abort now rolls the weakened policy
-- back on its own. ev.record's writes commit with it.
-- ---------------------------------------------------------------------------
begin;

set search_path = 'pg_catalog, public';
select ev.note('ed_select_qual', (select qual from pg_policies
  where schemaname='public' and tablename='events' and cmd='SELECT'));
reset search_path;

alter policy "events_select_view_crm" on public.events
  using ( organisation_id in (select private.permitted_organisations('view_crm')) );

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select ev.val('ED11 CONTROL: with the SELECT term lifted, pstd1 can now SEE pstd2''s event',
  $$select count(*)::text from public.events
     where id='ee110000-0000-0000-0000-000000000003'$$, '1');
-- ok(0) STILL, and now it is the UPDATE policy's USING clause saying it --
-- nothing else is left to. Under the mutation this becomes ok(1).
select ev.try('ED12 ...and STILL cannot claim it -- the UPDATE policy''s USING, alone',
  format($$update public.events set owner_user_id=%L
            where id='ee110000-0000-0000-0000-000000000003'$$, :'pstd1'), 'ok(0)');
-- 42501 STILL, and now it is the UPDATE policy's WITH CHECK saying it. This is
-- THE assertion the record-scope mutation flips.
select ev.try('ED13 ...and STILL cannot give their own away -- the WITH CHECK, alone',
  format($$update public.events set owner_user_id=%L
            where id='ee110000-0000-0000-0000-000000000002'$$, :'pstd2'), 'denied(42501)');
select ev.try('ED14 POSITIVE: ...while an ordinary edit of their own still works',
  $$update public.events set notes='still mine'
     where id='ee110000-0000-0000-0000-000000000002'$$, 'ok(1)');
reset role; reset request.jwt.claims;

alter policy "events_select_view_crm" on public.events
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

select ev.val('ED15 the SELECT policy is restored EXACTLY as the migration made it',
  $$select ((select qual from pg_policies
               where schemaname='public' and tablename='events' and cmd='SELECT')
            = (select v from ev.notes where k='ed_select_qual'))::text$$, 'true');
select ev.val('ED15a CONTROL: and that is the record-scoped expression, not any expression',
  -- Without this, ED15 is satisfied by two identical WRONG expressions, since
  -- both sides are read from the same live schema.
  $$select (select v from ev.notes where k='ed_select_qual')$$,
  '((organisation_id IN ( SELECT private.permitted_organisations(''view_crm''::text) AS permitted_organisations)) AND ((organisation_id IN ( SELECT private.full_scope_organisations() AS full_scope_organisations)) OR (owner_user_id = ( SELECT auth.uid() AS uid))))');

set role authenticated;
set request.jwt.claims = :'pstd1_c';
-- TWO NAMES, NOT ONE: ED6 created `Std1 Created Event` earlier in this
-- section, and it is theirs. ED1 ran before that and is the one-name form.
select ev.val('ED16 ...and behaviourally: pstd1 is back to seeing only their own events',
  $$select coalesce(string_agg(name,',' order by name),'<none>') from public.events$$,
  'Std1 Created Event,Std1 Event');
reset role; reset request.jwt.claims;

commit;

-- ===========================================================================
-- EE. Cross-tenant record transfer -- private.entity_org_unchanged()
-- ===========================================================================
-- The mutation: deleting the entity_org_unchanged term from
-- events_update_manage_events' WITH CHECK.
--
-- pmulti is an ADMIN OF BOTH organisations, which multi-org membership at MVP
-- makes an ordinary user rather than a contrived one. Every other term in the
-- WITH CHECK is satisfied by the destination organisation -- they hold
-- manage_events there, the plan permits writes there, and they are full-scope
-- there -- so entity_org_unchanged is the ONLY thing standing between them and
-- moving a record between tenants in one statement.
--
-- `Std2 Event` is the target because it names no venue: events_venue_fkey is
-- tenant-scoped, so an event WITH a venue would also violate the foreign key,
-- and a 23503 would tell us nothing about the policy.
set role authenticated;
set request.jwt.claims = :'pmulti_c';
select ev.try('EE1 pmulti cannot move an ALPHA event into BETA',
  format($$update public.events set organisation_id=%L
            where id='ee110000-0000-0000-0000-000000000003'$$, :'beta_org'),
  'denied(42501)');
select ev.val('EE2 ...and the row is still in ALPHA',
  format($$select (organisation_id = %L)::text from public.events
            where id='ee110000-0000-0000-0000-000000000003'$$, :'alpha_org'), 'true');
-- THE CONTROL THAT MAKES EE1 A STATEMENT ABOUT organisation_id. Without it,
-- EE1 passes against a policy that refuses pmulti every UPDATE.
select ev.try('EE3 CONTROL: the same user, the same row, editing anything ELSE',
  $$update public.events set notes='pmulti was here'
     where id='ee110000-0000-0000-0000-000000000003'$$, 'ok(1)');
-- ...and that they really are authorised in the destination, so EE1 is not
-- passing because BETA refuses them outright.
select ev.try('EE4 CONTROL: pmulti CAN create an event in BETA directly',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'Multi Beta Event', timestamptz '2026-11-04 20:00+00')$$,
         :'beta_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- EF. event_lineup is scoped BY ITS EVENT
-- ===========================================================================
-- The mutation: removing `p.organisation_id = event_lineup.organisation_id`
-- from the child policy. This is M-1 from Phase 2, reproduced on a new table --
-- and on venue_rooms it left the ENTIRE suite green (843 psql assertions, 174
-- HTTP checks), because the composite FK makes the two columns agree by
-- construction. EF6-EF12 are the § Y technique that takes the FK away.
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select ev.val('EF1 pstd1 sees only the lineup of the event THEY own',
  $$select coalesce(string_agg(id::text,',' order by id),'<none>')
      from public.event_lineup$$,
  'ff110000-0000-0000-0000-000000000002');
select ev.try('EF2 ...cannot add an artist to an event they do not own',
  format($$insert into public.event_lineup (organisation_id, event_id, artist_id)
           values (%L,'ee110000-0000-0000-0000-000000000001',
                   '44440000-0000-0000-0000-000000000001')$$, :'alpha_org'),
  'denied(42501)');
select ev.try('EF3 POSITIVE: ...and CAN add one to their own',
  format($$insert into public.event_lineup (organisation_id, event_id, artist_id, position)
           values (%L,'ee110000-0000-0000-0000-000000000002',
                   '44440000-0000-0000-0000-000000000002', 1)$$, :'alpha_org'),
  'ok(1)');
-- TWO LAYERS, IN THIS ORDER, AND THE ORDER WAS MEASURED RATHER THAN ASSUMED.
-- The task brief predicted denied(23503) here -- the composite foreign key --
-- and the answer is denied(42501): the POLICY refuses an `authenticated`
-- caller FIRST, because its EXISTS finds no ALPHA event with that id, so the
-- constraint is never consulted. Exactly the ordering
-- 20260828121000's venue_rooms block spells out and rls_phase2_crm.sql
-- B19/B20 assert on that table.
--
-- Both layers matter and they are not interchangeable, so both are asserted:
-- the policy is what an attacker meets, and the FK is what holds for every
-- writer in every role INCLUDING the ones RLS does not apply to (postgres, a
-- SECURITY DEFINER body, a DBA repair script). EF4b asks the second question
-- the only way it can be asked -- with no session at all.
select ev.try('EF4 a lineup row naming a BETA event: the POLICY refuses first, 42501',
  format($$insert into public.event_lineup (organisation_id, event_id, artist_id)
           values (%L,'ee11000b-0000-0000-0000-00000000000b',
                   '44440000-0000-0000-0000-000000000001')$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;

-- As postgres: no policy is in the way, so this reaches the constraint layer.
-- A single-column event_lineup_event_fkey would let this row land.
--
-- ev.try_con, NOT ev.try, AND THE CONSTRAINT NAME IS THE POINT (fix round 1,
-- review finding F.8). This row names a BETA event AND an ALPHA artist, and
-- BOTH event_lineup_event_fkey and event_lineup_artist_fkey are composite and
-- tenant-scoped -- either could raise 23503. A bare `denied(23503)` would stay
-- green if the EVENT foreign key were narrowed to a single column and the
-- ARTIST one started doing the refusing instead, which is the exact
-- substitution this assertion exists to notice.
select ev.try_con('EF4b ...and as postgres, where no policy is in the way, the EVENT FK refuses it',
  format($$insert into public.event_lineup (organisation_id, event_id, artist_id)
           values (%L,'ee11000b-0000-0000-0000-00000000000b',
                   '44440000-0000-0000-0000-000000000001')$$, :'alpha_org'),
  'denied(23503:event_lineup_event_fkey)');
select ev.try('EF4c CONTROL: the same postgres INSERT against an ALPHA event lands',
  format($$insert into public.event_lineup (organisation_id, event_id, artist_id, position)
           values (%L,'ee110000-0000-0000-0000-000000000003',
                   '44440000-0000-0000-0000-000000000001', 5)$$, :'alpha_org'),
  'ok(1)');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ev.val('EF5 CONTROL: a full-scope reader sees every ALPHA lineup row',
  $$select (count(*) >= 4)::text from public.event_lineup$$, 'true');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- THE FK-LIFT (§ Y's technique, on the new table).
--
-- `event_lineup_event_fkey (event_id, organisation_id)` is what makes EF4 a
-- 23503 -- and while it holds, the policy's correlation term CANNOT CHANGE AN
-- ANSWER, so nothing behavioural can see it. The constraint comes off for the
-- length of four statements, the row it would have refused is planted as
-- postgres, and the policy is asked on its own.
--
-- THE PLANTED ROW USES A **BETA** ARTIST. event_lineup_artist_fkey is composite
-- too and is NOT dropped, so a row tagged BETA naming an ALPHA artist would be
-- refused by the constraint that is still there and the plant would fail --
-- which would make EF7's zero mean "nothing was planted" rather than "the
-- policy refused it". Measured, not assumed: that is what the first draft did.
--
-- SAFETY, TWO LAYERS. EF6 proves the plant landed, so EF7's zero is the policy
-- answering. The row is deleted and the FK (and its comment) restored
-- immediately afterwards; EF10-EF12 assert both.
--
-- AND THE WHOLE LIFT RUNS INSIDE AN EXPLICIT TRANSACTION (fix round 1, review
-- finding F.7), for the reason § ED's does: constraint DDL is transactional in
-- PostgreSQL, so an abort between `drop constraint` and its re-add rolls back
-- rather than leaving public.event_lineup without its composite foreign key.
-- The ACCESS EXCLUSIVE lock the drop takes is held to commit, which costs
-- nothing here -- this suite is one session.
--
-- UNDER ev.val'S OWN search_path, because pg_get_constraintdef() renders
-- against it -- § Y measured that capturing the note under a different path
-- than the comparison makes the restore assertion fail for a reason that has
-- nothing to do with the schema.
-- ---------------------------------------------------------------------------
begin;

set search_path = 'pg_catalog, public';
select ev.note('ef_fkey_def', (select pg_catalog.pg_get_constraintdef(oid)
  from pg_catalog.pg_constraint
 where conname='event_lineup_event_fkey' and connamespace='public'::regnamespace));
select ev.note('ef_fkey_comment', (select pg_catalog.obj_description(oid, 'pg_constraint')
  from pg_catalog.pg_constraint
 where conname='event_lineup_event_fkey' and connamespace='public'::regnamespace));
reset search_path;

alter table public.event_lineup drop constraint event_lineup_event_fkey;

insert into public.event_lineup (id, organisation_id, event_id, artist_id, position)
select 'ff11ffff-0000-0000-0000-0000000000ff', o.id,
       'ee110000-0000-0000-0000-000000000001',
       '4444000b-0000-0000-0000-00000000000b', 9
from public.organisations o where o.slug='org-beta';

select ev.val('EF6 CONTROL: the cross-tenant lineup row really was planted',
  $$select count(*)::text from public.event_lineup
     where id='ff11ffff-0000-0000-0000-0000000000ff'$$, '1');

-- pmanager holds view_crm in ALPHA and full record scope there, so the parent
-- event clears every OTHER term in the policy. The correlation is the only
-- thing left standing between them and a row tagged BETA.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ev.val('EF7 a slot on an ALPHA event but TAGGED BETA is invisible to ALPHA',
  $$select count(*)::text from public.event_lineup
     where id='ff11ffff-0000-0000-0000-0000000000ff'$$, '0');
select ev.val('EF8 CONTROL: the same reader still sees ALPHA''s own lineup rows',
  $$select (count(*) > 0)::text from public.event_lineup$$, 'true');
reset role; reset request.jwt.claims;

-- The other direction. BETA's owner is the organisation the row is TAGGED with
-- and still must not see it, because the event it hangs off is not theirs.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select ev.val('EF9 ...and invisible to BETA too, whose id it carries',
  $$select count(*)::text from public.event_lineup
     where id='ff11ffff-0000-0000-0000-0000000000ff'$$, '0');
reset role; reset request.jwt.claims;

delete from public.event_lineup where id='ff11ffff-0000-0000-0000-0000000000ff';
alter table public.event_lineup
  add constraint event_lineup_event_fkey
    foreign key (event_id, organisation_id)
    references public.events (id, organisation_id) on delete cascade;

-- THE COMMENT COMES BACK TOO. `alter table ... add constraint` creates a bare
-- constraint, and the text below is 20260901000000's verbatim -- the migration
-- this suite is supposed to leave the schema identical to.
comment on constraint event_lineup_event_fkey on public.event_lineup is
  'Tenant-scoped: a lineup slot can only name an event that agrees with it about which organisation it belongs to. Without the composite form a user could insert a slot into another tenant''s event -- the exact write 20260828001132 proved reachable on venue_rooms and closed.';

select ev.val('EF10 the composite FK is restored EXACTLY as the migration made it',
  $$select ((select pg_catalog.pg_get_constraintdef(oid)
               from pg_catalog.pg_constraint
              where conname='event_lineup_event_fkey'
                and connamespace='public'::regnamespace)
            = (select v from ev.notes where k='ef_fkey_def'))::text$$, 'true');
select ev.val('EF10a CONTROL: that definition is the composite one, not any FK',
  -- Without this the comparison above is satisfied by two identical WRONG
  -- definitions, since both sides are read from the same live schema.
  $$select (select v from ev.notes where k='ef_fkey_def')$$,
  'FOREIGN KEY (event_id, organisation_id) REFERENCES public.events(id, organisation_id) ON DELETE CASCADE');
select ev.val('EF11 the constraint COMMENT is restored too',
  $$select ((select pg_catalog.obj_description(oid, 'pg_constraint')
               from pg_catalog.pg_constraint
              where conname='event_lineup_event_fkey'
                and connamespace='public'::regnamespace)
            = (select v from ev.notes where k='ef_fkey_comment'))::text$$, 'true');
select ev.val('EF12 ...and the planted row is gone',
  $$select count(*)::text from public.event_lineup
     where id='ff11ffff-0000-0000-0000-0000000000ff'$$, '0');

commit;

-- ===========================================================================
-- EG. A SOFT-DELETED PARENT -- readable, not writable
-- ===========================================================================
-- The mutation, in either direction: adding `p.deleted_at is null` to the
-- SELECT policy, or removing it from the three write policies.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
-- READABLE. The detail page renders a deleted event's lineup beside the
-- "Deleted" notice so a user can see what restoring would bring back, and the
-- restore path reads it. 20260828121000 design note (g).
select ev.val('EG1 the lineup of a SOFT-DELETED event is still readable',
  $$select count(*)::text from public.event_lineup
     where event_id='ee110000-0000-0000-0000-000000000004'$$, '1');
select ev.val('EG2 ...and so is the deleted event itself',
  $$select count(*)::text from public.events
     where id='ee110000-0000-0000-0000-000000000004'$$, '1');
-- NOT WRITABLE. INSERT is 42501 (WITH CHECK is the only clause an INSERT
-- policy has); UPDATE is ok(0), because `p.deleted_at is null` is in the USING
-- clause and the target row stops matching. Two different mechanisms, asserted
-- as the two different things they are.
select ev.try('EG3 ...but a new slot cannot be ADDED to it -- 42501',
  format($$insert into public.event_lineup (organisation_id, event_id, artist_id)
           values (%L,'ee110000-0000-0000-0000-000000000004',
                   '44440000-0000-0000-0000-000000000001')$$, :'alpha_org'),
  'denied(42501)');
select ev.try('EG4 ...nor an existing one EDITED -- ok(0), the USING clause',
  $$update public.event_lineup set billing='support'
     where id='ff110000-0000-0000-0000-000000000004'$$, 'ok(0)');
select ev.try('EG5 ...nor soft-deleted, which is the same UPDATE',
  $$update public.event_lineup set deleted_at=now()
     where id='ff110000-0000-0000-0000-000000000004'$$, 'ok(0)');
-- THE POSITIVE CONTROL: the identical statements against a LIVE event of the
-- same owner succeed. Without it EG3-EG5 are satisfied by a lineup nobody can
-- write at all.
select ev.try('EG6 POSITIVE: the same INSERT against a LIVE event succeeds',
  format($$insert into public.event_lineup (organisation_id, event_id, artist_id, position)
           values (%L,'ee110000-0000-0000-0000-000000000001',
                   '44440000-0000-0000-0000-000000000001', 1)$$, :'alpha_org'),
  'ok(1)');
select ev.try('EG7 POSITIVE: ...and the same UPDATE against a LIVE slot',
  $$update public.event_lineup set billing='support'
     where id='ff110000-0000-0000-0000-000000000001'$$, 'ok(1)');
-- AND THE RESTORE PATH ITSELF, end to end: restoring the event re-opens its
-- lineup for writing. This is what would break if `p.deleted_at is null` were
-- ever moved on to the SELECT policy.
select ev.try('EG8 restoring the event re-opens its lineup for writing',
  $$update public.events set deleted_at=null
     where id='ee110000-0000-0000-0000-000000000004'$$, 'ok(1)');
select ev.try('EG9 ...and now the slot on it IS editable',
  $$update public.event_lineup set billing='support'
     where id='ff110000-0000-0000-0000-000000000004'$$, 'ok(1)');
-- Put it back, so § EI's counts and the HTTP block meet the fixture as
-- described.
select ev.try('EG10 ...re-deleted, leaving the fixture as § EI expects it',
  $$update public.events set deleted_at=now()
     where id='ee110000-0000-0000-0000-000000000004'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- EH. THE ARTIST END IS **NOT** A POLICY TERM -- and must not become one
-- ===========================================================================
-- The mutation: adding an artists term to any lineup policy.
--
-- This section is entirely positive, and that is deliberate: it exists to stop
-- a future "helpful" edit. 20260828235000's argument, verbatim on the new
-- table -- a policy predicate is evaluated AS THE CALLER, so a term reading
-- public.artists would be filtered by artists_select_view_crm, and for a
-- record-scoped user who owns the event and not the artist "the artist is
-- deleted" would collapse into "I cannot see the artist". Legitimate writes
-- against perfectly live artists would start being refused.
--
-- WHAT ACTUALLY GUARDS THE ARTIST END: `event_lineup_artist_fkey` for the
-- cross-tenant half (EF4's sibling, at the constraint layer), and
-- `liveInOrg(supabase, "artists", org.id, artistId)` in lib/crm/events.ts for
-- the soft-deleted half. THERE IS NO DATABASE CONTROL BEHIND THAT SECOND ONE.
-- EH3 is the assertion that says so out loud, so nobody deletes the
-- application check believing a policy is behind it.
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select ev.val('EH1 pstd1 cannot even SEE the manager''s artist',
  $$select count(*)::text from public.artists
     where id='44440000-0000-0000-0000-000000000002'$$, '0');
select ev.try('EH2 ...and can nevertheless book them on to their OWN event',
  format($$insert into public.event_lineup (organisation_id, event_id, artist_id, position)
           values (%L,'ee110000-0000-0000-0000-000000000002',
                   '44440000-0000-0000-0000-00000000000f', 2)$$, :'alpha_org'),
  'ok(1)');
-- `<null>`, NOT `true`, AND THAT IS THE POINT. pstd1 cannot read that artist
-- row at all -- it is pmanager's -- so the SELECT returns no row and ev.val
-- records `<null>`. Asking THEM whether it is deleted answers nothing, which
-- is precisely why a `deleted_at` term on the artist end inside a POLICY would
-- collapse "the artist is deleted" into "I cannot see the artist". EH4 asks
-- the same question as postgres, where the answer is a fact about the fixture
-- rather than about the reader, and the two together are the claim: the artist
-- IS soft-deleted, and EH2's write succeeded anyway.
select ev.val('EH3 ...and pstd1 cannot even tell whether that artist is deleted',
  $$select (deleted_at is not null)::text from public.artists
     where id='44440000-0000-0000-0000-00000000000f'$$,
  '<null>');
reset role; reset request.jwt.claims;
select ev.val('EH4 (as postgres) the artist EH2 booked really is soft-deleted',
  $$select (deleted_at is not null)::text from public.artists
     where id='44440000-0000-0000-0000-00000000000f'$$, 'true');
select ev.val('EH5 CONTROL: no lineup policy expression mentions public.artists',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='event_lineup'
       and (coalesce(qual,'') like '%artists%'
         or coalesce(with_check,'') like '%artists%')$$, '0');

-- ===========================================================================
-- EI. A SUSPENDED ORGANISATION IS READ-ONLY, NOT A LOCKOUT
-- ===========================================================================
-- The mutation: flipping manage_events.survives_suspension to true. The P11
-- technique -- the write must STILL refuse, because
-- private.crm_write_organisations() carries its own unconditional
-- `deleted_at is null` clause, and a defence-in-depth term whose value is
-- never measured with the term beside it removed is an assumption.
--
-- The counts are taken WHILE LIVE and compared after suspension, rather than
-- hardcoded: an exact number here would be a hostage to every section above,
-- and '0' would pass against a database where every policy denies everything.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ev.note('live_events',  (select count(*)::text from public.events));
select ev.note('live_lineup',  (select count(*)::text from public.event_lineup));
reset role; reset request.jwt.claims;

update public.organisations set deleted_at = now() where slug = 'org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ev.val('EI1 SUSPENDED: events are still readable, the SAME count as live',
  $$select ((select count(*) from public.events)::text
            = (select v from ev.notes where k='live_events'))::text$$, 'true');
select ev.val('EI1a CONTROL: ...and that baseline is not zero',
  $$select ((select v from ev.notes where k='live_events')::int > 0)::text$$, 'true');
select ev.val('EI2 SUSPENDED: the lineup is still readable, same count as live',
  $$select ((select count(*) from public.event_lineup)::text
            = (select v from ev.notes where k='live_lineup'))::text$$, 'true');
select ev.try('EI3 SUSPENDED: INSERT is refused -- 42501, the WITH CHECK',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'Suspended Event', now())$$, :'alpha_org'), 'denied(42501)');
select ev.try('EI4 SUSPENDED: UPDATE matches nothing -- ok(0), the USING clause',
  $$update public.events set name='rewritten'
     where id='ee110000-0000-0000-0000-000000000001'$$, 'ok(0)');
select ev.try('EI5 SUSPENDED: a lineup INSERT is refused',
  format($$insert into public.event_lineup (organisation_id, event_id, artist_id, position)
           values (%L,'ee110000-0000-0000-0000-000000000001',
                   '44440000-0000-0000-0000-00000000000f', 7)$$, :'alpha_org'),
  'denied(42501)');
select ev.try('EI6 SUSPENDED: a lineup UPDATE matches nothing',
  $$update public.event_lineup set billing='opener'
     where id='ff110000-0000-0000-0000-000000000001'$$, 'ok(0)');
reset role; reset request.jwt.claims;

-- THE P11 TECHNIQUE. Flip the catalogue boolean -- the exact one-row mistake
-- that would open the first gate -- and prove the SECOND gate still refuses.
-- Restored per-key from what this block FOUND, not to a constant, so a
-- catalogue mistake made earlier survives to be caught rather than being
-- silently corrected here.
do $$
declare
  v_alpha uuid; v_mgr uuid; n int;
  r_insert text; r_update text; v_first_gate text; v_saved boolean;
begin
  select id into v_alpha from public.organisations where slug = 'org-alpha';
  select id into v_mgr   from auth.users where email = 'pmanager@test.local';

  select survives_suspension into v_saved
    from public.permissions where key = 'manage_events';

  update public.permissions set survives_suspension = true
   where key = 'manage_events';

  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', v_mgr, 'role','authenticated', 'aal','aal1')::text,
    true);
  v_first_gate := public.has_permission(v_alpha,'manage_events')::text;

  set local role authenticated;
  begin
    insert into public.events (organisation_id, name, starts_at)
    values (v_alpha, 'First Gate Off Event', now());
    get diagnostics n = row_count; r_insert := 'ok(' || n || ')';
  exception when others then r_insert := 'denied(' || sqlstate || ')'; end;
  begin
    update public.events set name = 'flipped'
     where id = 'ee110000-0000-0000-0000-000000000001';
    get diagnostics n = row_count; r_update := 'ok(' || n || ')';
  exception when others then r_update := 'denied(' || sqlstate || ')'; end;
  reset role;

  perform pg_catalog.set_config('request.jwt.claims', '', true);
  update public.permissions set survives_suspension = v_saved
   where key = 'manage_events';

  perform ev.record(
    'EI7  CONTROL: the catalogue flip really DOES open the first gate',
    'true', v_first_gate);
  perform ev.record(
    'EI8  FIRST GATE OFF: the event INSERT still refuses (crm_write_organisations)',
    'denied(42501)', r_insert);
  -- THE MECHANISM CHANGES, AND THE ASSERTION SAYS SO. With the first gate
  -- open, permitted_organisations('manage_events') contains the suspended
  -- organisation again, so the UPDATE's USING clause passes and the row STOPS
  -- being invisible -- EI4's ok(0) becomes a 42501 here. That is the second
  -- gate talking, in WITH CHECK, where 20260828140500 deliberately put the
  -- entitlement term so that a refused write is a loud 403 rather than a
  -- success-shaped 204. An `ok(1)` here would be the breakout.
  perform ev.record(
    'EI9  FIRST GATE OFF: ...and the UPDATE is REFUSED, not silently applied',
    'denied(42501)', r_update);
  perform ev.record(
    'EI10 the key this block borrows was found -- and restored -- FALSE',
    'false', v_saved::text);
end $$;

update public.organisations set deleted_at = null where slug = 'org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ev.try('EI11 REINSTATED: the same INSERT is allowed again',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'Reinstated Event', timestamptz '2026-11-05 20:00+00')$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- EJ. The MFA / assurance gate, on the new tables
-- ===========================================================================
-- A control on an existing mechanism (20260827210000), asserted here because
-- the CRM read gate now covers two more tables and nothing else would notice
-- if it did not. An Owner requires MFA (CLAUDE.md § Session security), so an
-- aal1 session of theirs -- the stolen-password case -- holds no permission at
-- all.
set role authenticated;
set request.jwt.claims = :'powner_c1';
select ev.val('EJ1 aal1 OWNER reads ZERO events',
  $$select count(*)::text from public.events$$, '0');
select ev.val('EJ2 aal1 OWNER reads ZERO lineup rows',
  $$select count(*)::text from public.event_lineup$$, '0');
select ev.try('EJ3 aal1 OWNER cannot create an event',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'aal1 Event', now())$$, :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'powner_c';
select ev.val('EJ4 POSITIVE: the SAME owner at aal2 reads the events',
  $$select (count(*) > 0)::text from public.events$$, 'true');
select ev.try('EJ5 POSITIVE: ...and can create one',
  format($$insert into public.events (organisation_id, name, starts_at)
           values (%L,'Owner aal2 Event', timestamptz '2026-11-06 20:00+00')$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- EK. private.entity_is_visible / _is_manageable ANSWER FOR 'event',
--     THROUGH A REAL SESSION
-- ===========================================================================
-- FOLLOW-UPS.md § "Phase 3 -- events" filed this as Phase 3 Task 2's, and the
-- reason it could not be done from vitest is the reason it belongs here: both
-- functions carry terms that read auth.uid(), which is NULL for `postgres`, so
-- driven as postgres they would answer false for every entity type including
-- the five that have worked since Phase 2 -- a `false` would prove nothing.
--
-- WHAT DEPENDS ON THE ANSWER: the three custom_field_values write policies and
-- the merges INSERT policy dispatch through these two functions, so an event
-- with no arm would make every custom field on every event silently
-- unwritable. 20260901010000 added the manageable arm; 20260901001000 added
-- the visible one.
--
-- THE DISCRIMINATING PAIR IS pfinance. They are FULL-SCOPE (only
-- standard_user and read_only are not) and hold view_crm and NOT
-- manage_events, so `visible=true, manageable=false` on the SAME row is only
-- possible if the two functions really do consult different keys. A dispatch
-- that ignored the key, or that copy-pasted view_crm into the manageable arm,
-- answers true/true and goes red here and nowhere else.
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select ev.val('EK1 pstd1: their OWN event is visible AND manageable',
  format($$select private.entity_is_visible('event','ee110000-0000-0000-0000-000000000002',%L)::text
             || '/' ||
             private.entity_is_manageable('event','ee110000-0000-0000-0000-000000000002',%L)::text$$,
         :'alpha_org', :'alpha_org'), 'true/true');
select ev.val('EK2 pstd1: pstd2''s event is NEITHER -- record scope',
  format($$select private.entity_is_visible('event','ee110000-0000-0000-0000-000000000003',%L)::text
             || '/' ||
             private.entity_is_manageable('event','ee110000-0000-0000-0000-000000000003',%L)::text$$,
         :'alpha_org', :'alpha_org'), 'false/false');
select ev.val('EK3 pstd1: a BETA event is NEITHER -- tenant',
  format($$select private.entity_is_visible('event','ee11000b-0000-0000-0000-00000000000b',%L)::text
             || '/' ||
             private.entity_is_manageable('event','ee11000b-0000-0000-0000-00000000000b',%L)::text$$,
         :'beta_org', :'beta_org'), 'false/false');
-- The organisation argument is a term in its own right, not decoration: this
-- is the cross-tenant hole no foreign key can reach (SECURITY.md § 10), and
-- naming an ALPHA organisation for a BETA row must be false even for a caller
-- who is in ALPHA.
select ev.val('EK4 pstd1: their own event under the WRONG organisation id is false',
  format($$select private.entity_is_visible('event','ee110000-0000-0000-0000-000000000002',%L)::text$$,
         :'beta_org'), 'false');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ev.val('EK5 POSITIVE CONTROL: pmanager, full scope, gets true/true on the SAME row EK2 refused',
  format($$select private.entity_is_visible('event','ee110000-0000-0000-0000-000000000003',%L)::text
             || '/' ||
             private.entity_is_manageable('event','ee110000-0000-0000-0000-000000000003',%L)::text$$,
         :'alpha_org', :'alpha_org'), 'true/true');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pfinance_c';
select ev.val('EK6 pfinance: VISIBLE but NOT MANAGEABLE -- the two keys really differ',
  format($$select private.entity_is_visible('event','ee110000-0000-0000-0000-000000000003',%L)::text
             || '/' ||
             private.entity_is_manageable('event','ee110000-0000-0000-0000-000000000003',%L)::text$$,
         :'alpha_org', :'alpha_org'), 'true/false');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- EX. THE FOUR INDEXES lib/crm/events-list.ts NAMES IN `backedBy` EXIST, AND
--     HAVE THE SHAPE THAT MAKES THE NAMING TRUE
-- ===========================================================================
-- Phase 2 STATED this rule and never asserted it. `lib/list/spec.ts` says
-- `backedBy` is "Required, and required to be a real index name, because the
-- alternative is what was measured before 20260828180000 existed" -- and
-- nothing anywhere checked that the string is a real index name. A rename in a
-- later migration, or a typo in a copied spec, leaves `backedBy` pointing at
-- nothing, every gate green, and the list back to a Seq Scan plus a top-N sort
-- of every live row in the tenant. Measured in Task 3 on 24,998 events: 9.95 ms
-- and 478 buffers unindexed against 0.60 ms and 14 indexed, and the SHAPE is
-- O(tenant) per page click, so it looks fine in every fixture in this file.
--
-- WHY HERE AND NOT IN VITEST. A unit test can read the four strings out of the
-- spec (tests/unit/crm/events-list.test.ts does, and checks their shape); only
-- the database can say whether an index of that name exists. This section is
-- the half that needs a database.
--
-- THE DENOMINATOR IS FOUR. Every assertion below counts over the same list of
-- four `backedBy` names -- `events_org_starts_at_id_live_idx`,
-- `events_org_name_id_live_idx`, `events_org_updated_at_id_live_idx` (the live
-- list's three sorts) and `events_org_deleted_at_id_idx` (the restore view's
-- one). EX1 fixes that four, so nothing below can pass by inspecting an empty
-- set. EX6 is the positive control in the other direction: a name that is NOT
-- one of them finds nothing, so EX1 is not passing because every string
-- matches.
--
-- Run as `postgres`. pg_class and pg_index carry no RLS and this section makes
-- no claim about who can see what -- every other section in this file does
-- that. Deliberately structural.
reset role; reset request.jwt.claims;

select ev.val('EX1 all four `backedBy` names exist as indexes on public.events',
  $$select count(*)::text from pg_catalog.pg_class c
      join pg_catalog.pg_index i on i.indexrelid = c.oid
      join pg_catalog.pg_class t on t.oid = i.indrelid
      join pg_catalog.pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'events'
       and c.relkind = 'i'
       and c.relname in ('events_org_starts_at_id_live_idx',
                         'events_org_name_id_live_idx',
                         'events_org_updated_at_id_live_idx',
                         'events_org_deleted_at_id_idx')$$, '4');

-- The names themselves, not just how many. A count of four could in principle
-- be four copies of one name; it cannot, but reading the set back is free and
-- it is what turns a failure into a message that names the missing index.
select ev.val('EX2 ...and they are those four exactly',
  $$select string_agg(c.relname, ',' order by c.relname)
      from pg_catalog.pg_class c
      join pg_catalog.pg_index i on i.indexrelid = c.oid
      join pg_catalog.pg_class t on t.oid = i.indrelid
      join pg_catalog.pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'events' and c.relkind = 'i'
       and c.relname like 'events\_org\_%'
       and c.relname not in ('events_organisation_id_idx')$$,
  'events_org_deleted_at_id_idx,events_org_name_id_live_idx,events_org_starts_at_id_live_idx,events_org_updated_at_id_live_idx');

-- THE SHAPE, NOT ONLY THE NAME. An index of the right name over the wrong
-- columns satisfies EX1 and serves nothing: `organisation_id` has to LEAD (the
-- list pins it by equality and that is what makes the index reachable at all --
-- 7x on contacts, 20260828180000), `id` has to be the last key column (keyset
-- pagination compares `(sort column, id)` and the tie-break has to be in the
-- index), and the partial predicate has to match the clause lib/list/query.ts
-- always writes, or the index cannot be used at all.
select ev.val('EX3 the three LIVE indexes are (organisation_id, <sort>, id) INCLUDE (owner_user_id) WHERE deleted_at IS NULL',
  $$select count(*)::text from pg_catalog.pg_class c
     where c.relname in ('events_org_starts_at_id_live_idx',
                         'events_org_name_id_live_idx',
                         'events_org_updated_at_id_live_idx')
       and pg_get_indexdef(c.oid) ~
           '^CREATE INDEX \w+ ON public\.events USING btree \(organisation_id, \w+, id\) INCLUDE \(owner_user_id\) WHERE \(deleted_at IS NULL\)$'$$,
  '3');

select ev.val('EX4 the RESTORE index is the same shape with the predicate inverted',
  $$select pg_get_indexdef(c.oid) from pg_catalog.pg_class c
     where c.relname = 'events_org_deleted_at_id_idx'$$,
  'CREATE INDEX events_org_deleted_at_id_idx ON public.events USING btree (organisation_id, deleted_at, id) INCLUDE (owner_user_id) WHERE (deleted_at IS NOT NULL)');

-- The sort COLUMN of each live index is the column its spec entry declares.
-- EX3 accepts any middle column; this pins which. Without it, three indexes
-- over `starts_at` would pass EX1, EX2 and EX3 together, and two of the three
-- sorts would be back to a top-N sort of the tenant.
select ev.val('EX5 each live index'' middle key column is the one its sort declares',
  $$select string_agg(c.relname || '=' || a.attname, ',' order by c.relname)
      from pg_catalog.pg_class c
      join pg_catalog.pg_index i on i.indexrelid = c.oid
      join pg_catalog.pg_attribute a
        on a.attrelid = i.indrelid and a.attnum = i.indkey[1]
     where c.relname in ('events_org_starts_at_id_live_idx',
                         'events_org_name_id_live_idx',
                         'events_org_updated_at_id_live_idx')$$,
  'events_org_name_id_live_idx=name,events_org_starts_at_id_live_idx=starts_at,events_org_updated_at_id_live_idx=updated_at');

-- POSITIVE CONTROL, in the direction that matters: EX1 counts names it is
-- handed, so it would report 4 for any four strings that happened to exist.
-- This asks for a name in the same family that deliberately does NOT exist --
-- `ends_at` is the sort lib/crm/events-list.ts refuses to declare because the
-- column is nullable -- and requires 0. If this returns 1, the lookup above is
-- matching something other than the name it was given.
select ev.val('EX6 POSITIVE CONTROL: a plausible name that was never created finds nothing',
  $$select count(*)::text from pg_catalog.pg_class c
      join pg_catalog.pg_index i on i.indexrelid = c.oid
     where c.relname = 'events_org_ends_at_id_live_idx'$$, '0');

-- ===========================================================================
-- Results
-- ===========================================================================
\o
\echo ''
\echo '========== PHASE 3 (EVENTS) RLS SUITE =========='
select seq, case when pass then 'PASS' else '**FAIL**' end as result,
       label, expected, actual
from ev.results order by seq;

\echo ''
select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from ev.results;

-- ===========================================================================
-- Phase 7 Task 3 (Organisation lifecycle) RLS suite.
--
-- Covers 20260908030000_organisation_lifecycle.sql and
--        20260908031000_network_presence_wind_down.sql:
--   the four lifecycle columns, their CHECK and their normalising trigger
--   private.organisation_retention_days()          the 60-day clock (Q88)
--   organisations_select_platform_lifecycle        the superuser's read
--   organisations_update_platform_lifecycle        THE REINSTATE PATH
--   private.lifecycle_transition_in_progress()     the sanctioned-path marker
--   private.log_audit_event()'s threading          the cascade-audit answer
--   public.suspend_organisation / delete_organisation / reinstate_organisation
--   private.organisation_network_presence_active() Q88/Q92/Q101
--
-- RUN IT WITH:  supabase/tests/run-rls-tests.sh
--   It runs AFTER rls_phase7_impersonation.sql and reuses the SAME fixtures
--   whole -- the twelve Phase 2 users, orgs ALPHA and BETA. It suspends and
--   reinstates ALPHA repeatedly and § LZ asserts it leaves ALPHA ACTIVE and
--   unchanged: a workspace left suspended would make every HTTP check below
--   run against a read-only tenant, and those were written against a live one.
--
-- IT USES ITS OWN `lc` SCHEMA, so a Task 3 failure is not reported under a
-- Task 2 heading. The helpers are rls_phase7_impersonation.sql's, verbatim,
-- with the schema renamed.
--
-- ===========================================================================
-- WHAT THIS FILE IS FOR
-- ===========================================================================
-- Suspension is the state the whole permission catalogue hangs off:
-- `organisations.deleted_at is not null` is the single predicate thirty-odd
-- gates read to mean "read-only". Task 3 added a second column beside it and
-- a new way to clear it, and both of those are exactly the kind of change that
-- can quietly hand an Owner the ability to un-suspend their own workspace --
-- DECISIONS-QUEUE consequence P7, the thing the control exists to prevent.
--
-- So the claims under test are:
--
--   INVARIANT   lifecycle_state = 'active' <=> deleted_at is null, however the
--               row is written -- including by the paths that predate this
--               feature and know nothing about it.            (§ LV)
--   P7 HOLDS    the Owner still cannot un-suspend, the new policy does not
--               give them a way, and neither does a foreign admin or a
--               non-superuser at aal2.                        (§ LP)
--   REINSTATE   the superuser CAN, but only through the sanctioned RPC -- a
--               raw UPDATE with every other condition satisfied still matches
--               nothing.                                      (§ LR)
--   AUDIT       every transition writes exactly one summary row, with a
--               reason, on one correlation thread, carrying counts and no
--               tenant record content.                        (§ LA)
--   NETWORK     Q88/Q92/Q101 at both sides of both clocks.     (§ LN)
--
-- SECTIONS:
--   LF  fixtures and their sanity
--   LV  the invariant, driven from every direction that can write the row
--   LP  P7: the Owner, the foreign admin and the non-superuser are all refused
--   LR  the superuser's path, and its sanctioned-path marker
--   LA  the audit trail: one summary row, threaded, counts not content
--   LN  network presence: both sides of the period-end and retention clocks
--   LZ  housekeeping: ALPHA is left active and unchanged
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a policy/guard refusal.
--   denied(22023)  rejected by an explicit validation.
--   denied(23514)  rejected by a CHECK.
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
--
-- psql vars required (supplied by run-rls-tests.sh's P7VARS).
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists lc cascade;
create schema lc;

create table lc.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function lc.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into lc.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function lc.try(p_label text, p_sql text, p_expected text)
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
  perform lc.record(p_label, p_expected, v_actual);
end $$;

create function lc.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform lc.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema lc to authenticated, anon, service_role;
grant execute on function lc.record(text,text,text) to authenticated, anon, service_role;
grant execute on function lc.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function lc.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset
\o

-- ===========================================================================
-- § LF  FIXTURES AND THEIR SANITY
--
-- Every refusal below is only meaningful if these pass: a refusal from an
-- allowlist that does not contain `super`, or from an organisation that is
-- already suspended, proves nothing about this feature.
-- ===========================================================================
select lc.val('LF1 FIXTURE: `super` is on the platform_admins allowlist',
  format($$select count(*)::text from public.platform_admins where user_id=%L$$, :'super'), '1');
select lc.val('LF2 FIXTURE: ALPHA starts ACTIVE, with deleted_at null',
  format($$select (lifecycle_state = 'active' and deleted_at is null)::text
             from public.organisations where id=%L$$, :'alpha_org'), 'true');
-- ALPHA HAS NO SUBSCRIPTION ROW WHEN THIS SUITE STARTS, and that is the state
-- network_leakage_phase6.sql deliberately leaves behind (its § LI plants one
-- for the downgrade probe, its § LJ borrows one for the Q88 boundary, and its
-- § LZ2 asserts neither was left). private.organisation_network_presence_active()
-- reads current_period_end, so § LN needs one -- and it has to leave the
-- absence exactly as it found it, or LZ2 in the suite before this one stops
-- describing the database.
--
-- So the row is SAVED, PLANTED and RESTORED, rather than assumed. lc.saved_sub
-- carries whatever was there (nothing, today) and § LZ puts it back.
\o /dev/null
create table lc.saved_sub as
  select * from public.organisation_subscriptions where organisation_id = :'alpha_org';
delete from public.organisation_subscriptions where organisation_id = :'alpha_org';
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'alpha_org', 'pro', 'monthly', 3, 'active', now() + interval '30 days');
\o
select lc.val('LF3 FIXTURE: ALPHA now has a subscription row (the network clock reads it)',
  format($$select count(*)::text from public.organisation_subscriptions
            where organisation_id=%L$$, :'alpha_org'), '1');
select lc.val('LF3b FIXTURE: ...and it was planted by this suite, not inherited',
  $$select count(*)::text from lc.saved_sub$$, '0');
select lc.val('LF4 FIXTURE: the retention window is 60 days (founder ruling Q88)',
  $$select private.organisation_retention_days()::text$$, '60');
select lc.val('LF5 FIXTURE: manage_organisation still does NOT survive suspension',
  $$select survives_suspension::text from public.permissions
     where key='manage_organisation'$$, 'false');

-- ===========================================================================
-- § LV  THE INVARIANT
--
-- `lifecycle_state = 'active' <=> deleted_at is null` is what makes it safe to
-- leave thirty-odd permission gates reading deleted_at alone. It is enforced
-- twice -- normalised by private.organisation_lifecycle_sync(), asserted by
-- organisations_lifecycle_matches_deleted_at -- and this section drives it
-- from every direction that can write the row, INCLUDING the ones that predate
-- the feature: a bare `set deleted_at = now()` naming no lifecycle column at
-- all is the Owner's own self-suspension path and a DBA's, and it must land
-- coherent rather than raise.
-- ===========================================================================
\o /dev/null
update public.organisations set deleted_at = now() where id = :'alpha_org';
\o
select lc.val('LV1 a bare deleted_at write NORMALISES to suspended (the pre-Task-3 path)',
  format($$select lifecycle_state from public.organisations where id=%L$$, :'alpha_org'),
  'suspended');
select lc.val('LV1b ...and gets both clocks, stamped 60 days apart',
  format($$select (retention_expires_at - lifecycle_changed_at = interval '60 days')::text
             from public.organisations where id=%L$$, :'alpha_org'), 'true');

-- An unrelated UPDATE must NOT restart a running retention window: the clock
-- belongs to the transition, not to the last time anybody touched the row.
\o /dev/null
select retention_expires_at as before_touch from public.organisations where id = :'alpha_org' \gset
update public.organisations set name = name where id = :'alpha_org';
\o
select lc.val('LV2 an unrelated UPDATE does NOT extend a running retention window',
  format($$select (retention_expires_at = %L::timestamptz)::text
             from public.organisations where id=%L$$, :'before_touch', :'alpha_org'), 'true');

\o /dev/null
update public.organisations set deleted_at = null where id = :'alpha_org';
\o
select lc.val('LV3 clearing deleted_at clears the state, both clocks and the reason',
  format($$select (lifecycle_state='active' and lifecycle_changed_at is null
                   and retention_expires_at is null and lifecycle_reason is null)::text
             from public.organisations where id=%L$$, :'alpha_org'), 'true');

-- THE CHECK, PROVED BY DISABLING THE TRIGGER. A defence-in-depth constraint
-- whose value is never measured with the thing beside it removed is an
-- assumption, not a control -- rls_phase2_crm.sql § 7's reasoning, applied to
-- this pair. Restored inside the same block.
do $$
declare v_alpha uuid; r text;
begin
  select id into v_alpha from public.organisations where slug='org-alpha';
  alter table public.organisations disable trigger organisation_lifecycle_sync;
  begin
    update public.organisations set deleted_at = pg_catalog.now() where id = v_alpha;
    r := 'ok';
  exception when others then r := 'denied(' || sqlstate || ')'; end;
  alter table public.organisations enable trigger organisation_lifecycle_sync;
  perform lc.record(
    'LV4 TRIGGER OFF: the CHECK alone refuses an active-but-deleted row',
    'denied(23514)', r);
end $$;
select lc.val('LV4b CONTROL: ...and ALPHA is still active, so LV4 really wrote nothing',
  format($$select (lifecycle_state='active' and deleted_at is null)::text
             from public.organisations where id=%L$$, :'alpha_org'), 'true');

-- ===========================================================================
-- § LP  CONSEQUENCE P7 STILL HOLDS
--
-- The new permissive UPDATE policy is the whole risk of this task: permissive
-- policies OR together, so a term that is true for the wrong caller opens the
-- door for them without touching anything the existing tests read. These are
-- the negatives. There is one superuser at MVP, so the "foreign superuser" is
-- shaped rather than real -- an aal2 Owner of ANOTHER tenant, which is the
-- nearest thing the fixture can offer and the caller a real escalation would
-- start from.
-- ===========================================================================
\o /dev/null
update public.organisations set deleted_at = now() where id = :'alpha_org';
\o
set role authenticated;
set request.jwt.claims = :'powner_c';
select lc.try('LP1 SUSPENDED: the Owner still cannot un-suspend (P7, unchanged)',
  $$update public.organisations set deleted_at=null where slug='org-alpha'$$, 'ok(0)');
select lc.val('LP1b ...and deleted_at really is still set',
  $$select (deleted_at is not null)::text from public.organisations
     where slug='org-alpha'$$, 'true');
select lc.try('LP2 SUSPENDED: nor can the Owner flip lifecycle_state directly',
  $$update public.organisations set lifecycle_state='active', deleted_at=null
     where slug='org-alpha'$$, 'ok(0)');
-- Phase 10 Task 6: this suite's subject is not step-up, so its principals
-- are armed the way the server would be after a passed step-up
-- (supabase/tests/step_up_fixture.sql; step-up is rls_phase10_step_up.sql's).
select step_up_fixture.arm(:'super_c') \g /dev/null
select lc.try('LP3 the Owner cannot call the reinstate RPC either',
  $$select public.reinstate_organisation('org-alpha','I would like my workspace back')$$,
  'denied(42501)');
select lc.try('LP3b ...nor suspend somebody else''s',
  $$select public.suspend_organisation('org-beta','a competitor')$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- The foreign admin: BETA's Owner, aal2, aimed at ALPHA.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select lc.try('LP4 a FOREIGN aal2 Owner cannot reinstate ALPHA',
  $$select public.reinstate_organisation('org-alpha','not mine')$$, 'denied(42501)');
select lc.try('LP4b ...nor reach the row with a raw UPDATE',
  $$update public.organisations set deleted_at=null where slug='org-alpha'$$, 'ok(0)');
select lc.val('LP4c ...and cannot even READ ALPHA''s row (no lifecycle policy for them)',
  $$select count(*)::text from public.organisations where slug='org-alpha'$$, '0');
reset role; reset request.jwt.claims;

-- The superuser at aal1: on the allowlist, no second factor. The identity is
-- right and the session is not, which is the case
-- private.has_platform_permission() exists to separate.
set role authenticated;
set request.jwt.claims = :'super_c1';
select lc.try('LP5 the superuser at aal1 cannot reinstate (has_platform_permission is aal2-gated)',
  $$select public.reinstate_organisation('org-alpha','no second factor')$$, 'denied(42501)');
select lc.val('LP5b ...and reads no organisations row either, so the policy is aal-gated too',
  $$select count(*)::text from public.organisations where slug='org-beta'$$, '0');
reset role; reset request.jwt.claims;

select lc.val('LP6 after every attack above, ALPHA is STILL suspended',
  format($$select (deleted_at is not null and lifecycle_state='suspended')::text
             from public.organisations where id=%L$$, :'alpha_org'), 'true');

-- THE STRUCTURAL GUARD. LP1-LP5 would go on passing if a later migration
-- relaxed organisations_update_manage_organisation and something else happened
-- to close the door -- so the shape is read out of pg_policies too, exactly as
-- rls_phase2_crm.sql P11e does for the Foundation four.
select lc.val('LP7 organisations_update_manage_organisation STILL carries its own deleted_at gate',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='organisations'
       and policyname='organisations_update_manage_organisation'
       and qual ~ 'deleted_at IS NULL'$$, '1');
select lc.val('LP8 the new policy names BOTH terms -- the superuser AND the sanctioned path',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='organisations'
       and policyname='organisations_update_platform_lifecycle'
       and qual ~ 'has_platform_permission'
       and qual ~ 'lifecycle_transition_in_progress'$$, '1');

-- ---- THE ACTIVE-ROW DIRECTION (fix round 1, review finding I1) -----------
-- EVERY ASSERTION ABOVE ATTACKS AN ALREADY-SUSPENDED ROW, where USING's
-- `deleted_at is null` closes the door before anything else is consulted. The
-- LIVE-row direction was never driven, and it was open: an aal2 Owner could
-- PATCH their own live workspace to lifecycle_state = 'deleted' with an
-- arbitrary lifecycle_reason, un-audited -- reaching Q101's immediate
-- directory removal, a state only the superuser can undo (P7), and
-- member-authored text on the platform's own suspended-workspace banner.
--
-- Reproduced as `ok(1)` before the fix. These are the assertions that keep it
-- shut.
\o /dev/null
update public.organisations set deleted_at = null where id = :'alpha_org';
\o
select lc.val('LP9  FIXTURE: ALPHA is LIVE again, so USING cannot be what refuses below',
  format($$select (deleted_at is null)::text from public.organisations where id=%L$$,
         :'alpha_org'), 'true');

set role authenticated;
set request.jwt.claims = :'powner_c';
select lc.try('LP9a I1: the Owner cannot wind their OWN LIVE workspace down',
  $$update public.organisations
       set deleted_at = now(), lifecycle_state = 'deleted',
           lifecycle_reason = 'Suspended by GetSetPaid for fraud - call 0800-SCAM'
     where slug='org-alpha'$$, 'denied(42501)');
select lc.try('LP9b ...nor set a bare deleted_at (the Phase 2 self-suspension door is CLOSED -- Q104)',
  $$update public.organisations set deleted_at=now() where slug='org-alpha'$$,
  'denied(42501)');
select lc.try('LP9c ...nor write lifecycle_reason alone, which the customer banner renders',
  $$update public.organisations set lifecycle_reason='call 0800-SCAM'
     where slug='org-alpha'$$, 'denied(42501)');
select lc.try('LP9d ...nor lifecycle_state alone',
  $$update public.organisations set lifecycle_state='deleted' where slug='org-alpha'$$,
  'denied(42501)');
-- THE POSITIVE CONTROL. Without it, LP9a-LP9d would pass just as well against
-- a policy that had accidentally revoked UPDATE altogether, and the Owner's
-- ordinary settings screen would be broken with a green suite.
select lc.try('LP9e CONTROL: the SAME Owner CAN still rename their live workspace',
  $$update public.organisations set name='Alpha Promotions' where slug='org-alpha'$$,
  'ok(1)');
reset role; reset request.jwt.claims;

select lc.val('LP9f ...and after all four refusals the row is UNCHANGED and still live',
  format($$select (lifecycle_state='active' and deleted_at is null
                   and lifecycle_reason is null)::text
             from public.organisations where id=%L$$, :'alpha_org'), 'true');
select lc.val('LP9g ...and NO audit row was minted by any of them',
  format($$select count(*)::text from public.audit_events
            where organisation_id=%L
              and action in ('organisation.suspended','organisation.deleted',
                             'organisation.reinstated')
              and after->>'reason' like '%%0800-SCAM%%'$$, :'alpha_org'), '0');

-- ---- THE SECOND GATE, PROVEN BY TURNING THE FIRST ONE OFF ----------------
-- rls_phase2_crm.sql section 7's discipline, applied to this fix: a
-- defence-in-depth term whose value is never measured with the term beside it
-- removed is an assumption, not a control -- and I1 happened precisely because
-- ONE term was assumed to cover both directions of a write.
--
-- The policy's WITH CHECK is relaxed back to its pre-fix shape inside a DO
-- block, the attack is re-run, and private.organisation_lifecycle_guard() --
-- which consults no policy at all -- is what refuses. Restored in the same
-- block; LP10d is the proof it was.
do $$
declare v_owner uuid; v_alpha uuid; r_attack text; r_control text; n int;
begin
  select id into v_alpha from public.organisations where slug='org-alpha';
  select id into v_owner from auth.users where email='powner@test.local';

  -- Back to 20260826154304:737's bare clause -- the exact shape I1 exploited.
  alter policy organisations_update_manage_organisation
    on public.organisations
    with check ( public.has_permission(id, 'manage_organisation') );

  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', v_owner, 'role','authenticated','aal','aal2')::text,
    true);
  set local role authenticated;
  begin
    update public.organisations
       set deleted_at = pg_catalog.now(), lifecycle_state = 'deleted',
           lifecycle_reason = 'gate 1 is off'
     where id = v_alpha;
    get diagnostics n = row_count; r_attack := 'ok(' || n || ')';
  exception when others then r_attack := 'denied(' || sqlstate || ')'; end;
  begin
    update public.organisations set name = 'Alpha Promotions' where id = v_alpha;
    get diagnostics n = row_count; r_control := 'ok(' || n || ')';
  exception when others then r_control := 'denied(' || sqlstate || ')'; end;
  reset role;
  perform pg_catalog.set_config('request.jwt.claims','',true);

  -- Put the fix back.
  alter policy organisations_update_manage_organisation
    on public.organisations
    with check (
      public.has_permission(id, 'manage_organisation')
      and deleted_at       is null
      and lifecycle_state  = 'active'
      and lifecycle_reason is null
    );

  perform lc.record(
    'LP10  GATE 1 OFF: the TRIGGER alone still refuses the wind-down',
    'denied(42501)', r_attack);
  perform lc.record(
    'LP10b GATE 1 OFF: ...and an ordinary rename still works, so LP10 is the guard',
    'ok(1)', r_control);
  perform lc.record(
    'LP10c GATE 1 OFF: ...and ALPHA is still live and unreasoned',
    'true',
    (select (lifecycle_state='active' and deleted_at is null
             and lifecycle_reason is null)::text
       from public.organisations where id = v_alpha));
end $$;
select lc.val('LP10d ...and GATE 1 was restored (the WITH CHECK carries all three terms again)',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='organisations'
       and policyname='organisations_update_manage_organisation'
       and with_check ~ 'deleted_at IS NULL'
       and with_check ~ 'lifecycle_state'
       and with_check ~ 'lifecycle_reason IS NULL'$$, '1');
select lc.val('LP10e STRUCTURAL: the guard trigger is on the table and sorts BEFORE the normaliser',
  $$select string_agg(tgname, ',' order by tgname) from pg_trigger
     where tgrelid='public.organisations'::regclass and not tgisinternal
       and tgname like 'organisation_lifecycle%'$$,
  'organisation_lifecycle_guard,organisation_lifecycle_sync');

-- HAND § LR BACK THE FIXTURE IT INHERITS. The LP9 block needed ALPHA LIVE (the
-- whole point of I1 is the active-row direction), and § LR opens by measuring
-- the marker against a SUSPENDED one. Restored as postgres, which the guard
-- exempts by design -- row_security_active() is false for a rolbypassrls role.
\o /dev/null
update public.organisations set deleted_at = now() where id = :'alpha_org';
\o
select lc.val('LP11 HOUSEKEEPING: ALPHA is suspended again, as § LR expects to find it',
  format($$select (deleted_at is not null and lifecycle_state='suspended')::text
             from public.organisations where id=%L$$, :'alpha_org'), 'true');

-- ===========================================================================
-- § LR  THE SUPERUSER'S PATH, AND ITS MARKER
--
-- The positive half. It matters as much as the negatives: FOLLOW-UPS.md's
-- point was that shipping suspend without reinstate is a one-way door, so a
-- reinstate that refuses everybody would satisfy § LP and fail the task.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';

-- THE MARKER, MEASURED DIRECTLY. Outside a transition the superuser has every
-- other condition satisfied -- on the allowlist, aal2, the row readable -- and
-- the raw UPDATE still matches nothing. This is the assertion that stops the
-- policy degrading into "the superuser may PATCH organisations".
select lc.val('LR1 outside a transition, no marker is set',
  $$select private.lifecycle_transition_in_progress()::text$$, 'false');
select lc.try('LR2 THE MARKER: a raw UPDATE by the superuser matches NOTHING',
  $$update public.organisations set deleted_at=null where slug='org-alpha'$$, 'ok(0)');
select lc.val('LR2b ...and ALPHA is still suspended, so LR2''s ok(0) really wrote nothing',
  $$select (deleted_at is not null)::text from public.organisations
     where slug='org-alpha'$$, 'true');
select lc.val('LR3 CONTROL: the superuser CAN read the row (so LR2 is the marker, not the read)',
  $$select count(*)::text from public.organisations where slug='org-alpha'$$, '1');

select lc.try('LR4 THE WAY BACK: reinstate through the RPC succeeds',
  $$select public.reinstate_organisation('org-alpha','paid up, ticket 4471')$$, 'ok(1)');
select lc.val('LR4b ...and ALPHA is active, with every lifecycle column cleared',
  $$select (lifecycle_state='active' and deleted_at is null
            and retention_expires_at is null and lifecycle_reason is null)::text
     from public.organisations where slug='org-alpha'$$, 'true');
select lc.val('LR5 the marker is CLOSED again after the RPC returns',
  $$select private.lifecycle_transition_in_progress()::text$$, 'false');
select lc.try('LR5b ...so the next raw UPDATE in the SAME transaction matches nothing',
  $$update public.organisations set deleted_at=now() where slug='org-alpha'$$, 'ok(0)');

-- The state machine's own refusals.
select lc.try('LR6 reinstating an ACTIVE workspace is refused, not a silent no-op',
  $$select public.reinstate_organisation('org-alpha','already fine')$$, 'denied(22023)');
select lc.try('LR7 a reason is MANDATORY',
  $$select public.suspend_organisation('org-alpha','   ')$$, 'denied(22023)');
select lc.try('LR8 an unknown slug is a distinguishable refusal (the operator gets told)',
  $$select public.suspend_organisation('no-such-workspace','x')$$, 'denied(22023)');

select lc.try('LR9 SUSPEND through the RPC',
  $$select public.suspend_organisation('org-alpha','non-payment, invoice 902')$$, 'ok(1)');
select lc.val('LR9b ...state, reason and both clocks are set',
  $$select (lifecycle_state='suspended' and deleted_at is not null
            and lifecycle_reason='non-payment, invoice 902'
            and retention_expires_at > now())::text
     from public.organisations where slug='org-alpha'$$, 'true');
select lc.try('LR10 suspending an already-suspended workspace is refused',
  $$select public.suspend_organisation('org-alpha','again')$$, 'denied(22023)');

select lc.try('LR11 CLOSE (soft-delete) a suspended workspace',
  $$select public.delete_organisation('org-alpha','customer closed the account')$$, 'ok(1)');
select lc.val('LR11b ...and it is ''deleted'' with deleted_at set',
  $$select (lifecycle_state='deleted' and deleted_at is not null)::text
     from public.organisations where slug='org-alpha'$$, 'true');
select lc.val('LR11c ...and closing RE-STAMPED the retention clock (the customer-favourable read)',
  $$select (retention_expires_at > now() + interval '59 days')::text
     from public.organisations where slug='org-alpha'$$, 'true');

select lc.try('LR12 reinstating from CLOSED works too -- there is no one-way door',
  $$select public.reinstate_organisation('org-alpha','reopened at the customer''''s request')$$,
  'ok(1)');
select lc.val('LR12b ...and ALPHA is active again',
  $$select lifecycle_state from public.organisations where slug='org-alpha'$$, 'active');
reset role; reset request.jwt.claims;

-- SOFT-DELETE MEANS SOFT, asserted with RLS off because the superuser cannot
-- read a tenant's contacts and must not be able to: CLAUDE.md § Superuser
-- dashboard, "no direct tenant-data access outside impersonation". So this one
-- runs as postgres -- it is a statement about the DATABASE, not about what any
-- caller can see.
select lc.val('LR11d SOFT: ALPHA''s contacts were never touched by the close',
  $$select (count(*) > 0)::text from public.contacts c
     join public.organisations o on o.id = c.organisation_id
    where o.slug='org-alpha'$$, 'true');

-- REINSTATEMENT PAST THE DEADLINE. The 60 days is when a workspace stops being
-- visible to the network, NOT a deadline that locks the operator out of their
-- own undo -- public.reinstate_organisation() carries no window check and this
-- is what asserts it, because "we could not reopen it" is the failure this
-- whole task exists to prevent.
-- TWO STEPS, AND THE FIRST ONE'S CLOCK IS THROWN AWAY. The normalising trigger
-- re-stamps lifecycle_changed_at whenever the state ARRIVES (that is what stops
-- an unrelated UPDATE extending a running window -- LV2), so a single UPDATE
-- setting a 90-day-old deleted_at gets a clock starting now. The second UPDATE
-- moves lifecycle_changed_at on a row that is ALREADY suspended, which the
-- trigger honours, and retention_expires_at is then DERIVED from it -- so this
-- fixture exercises the real derivation rather than writing a deadline by hand.
\o /dev/null
update public.organisations set deleted_at = now() - interval '90 days'
 where id = :'alpha_org';
update public.organisations
   set lifecycle_changed_at = now() - interval '90 days',
       lifecycle_reason = 'long expired'
 where id = :'alpha_org';
\o
set role authenticated;
set request.jwt.claims = :'super_c';
select lc.val('LR13 FIXTURE: ALPHA is suspended and 30 days PAST its retention deadline',
  $$select (retention_expires_at < now())::text from public.organisations
     where slug='org-alpha'$$, 'true');
select lc.try('LR13b ...and reinstatement still works (the deadline is not a lock)',
  $$select public.reinstate_organisation('org-alpha','recovered after the window')$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ---- THE EDGE NOBODY HAD WRITTEN DOWN (fix round 1, review Minor 3) ------
-- suspend_organisation() refuses only when the state is ALREADY 'suspended',
-- so a CLOSED workspace can be suspended -- and that is not a no-op: the
-- retention clock re-stamps (Q102) and directory presence RETURNS, because
-- Q88's grace applies to 'suspended' and Q101's immediate removal applies to
-- 'deleted'. Coherent with both rulings, and the one transition in the state
-- machine that nothing measured. It is a real operator move (a closure logged
-- against the wrong workspace, downgraded rather than reopened), so it is
-- pinned here rather than left to be discovered.
set role authenticated;
set request.jwt.claims = :'super_c';
select lc.try('LR14 FIXTURE: close ALPHA again, to drive deleted -> suspended',
  $$select public.delete_organisation('org-alpha','M3 fixture: closed')$$, 'ok(1)');
select lc.val('LR14a ...and a CLOSED workspace has no directory presence (Q101)',
  $$select private.organisation_network_presence_active(
             (select id from public.organisations where slug='org-alpha'))::text$$,
  'false');
select lc.try('LR15 M3: a CLOSED workspace CAN be suspended (deleted -> suspended)',
  $$select public.suspend_organisation('org-alpha','M3: downgraded to suspension')$$,
  'ok(1)');
select lc.val('LR15a ...and it really is suspended now',
  $$select lifecycle_state from public.organisations where slug='org-alpha'$$,
  'suspended');
select lc.val('LR15b CONSEQUENCE: directory presence RETURNS under Q88''s grace',
  $$select private.organisation_network_presence_active(
             (select id from public.organisations where slug='org-alpha'))::text$$,
  'true');
select lc.try('LR15c HOUSEKEEPING: reopen it',
  $$select public.reinstate_organisation('org-alpha','M3 teardown')$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § LA  THE AUDIT TRAIL
--
-- CLAUDE.md § Non-negotiable rules: "Audit high-value actions. Actor, org,
-- timestamp, action, target, correlation ID, before/after." And FOLLOW-UPS.md
-- wanted the volume answer: ONE summary row per lifecycle action, threaded,
-- rather than one row per cascaded child.
-- ===========================================================================
select lc.val('LA1 every transition above wrote exactly one audit row',
  format($$select count(*)::text from public.audit_events
            where organisation_id=%L and action in ('organisation.suspended',
                    'organisation.deleted','organisation.reinstated')$$, :'alpha_org'), '8');
select lc.val('LA1b ...each with its OWN correlation thread (one operation, one id)',
  format($$select (count(distinct correlation_id) = count(*))::text
             from public.audit_events
            where organisation_id=%L and action in ('organisation.suspended',
                    'organisation.deleted','organisation.reinstated')$$, :'alpha_org'), 'true');
select lc.val('LA2 the actor is the REAL superuser, never the customer',
  format($$select (count(*) filter (where actor_user_id = %L) = count(*))::text
             from public.audit_events
            where organisation_id=%L and action in ('organisation.suspended',
                    'organisation.deleted','organisation.reinstated')$$,
         :'super', :'alpha_org'), 'true');
select lc.val('LA3 the FIRST suspension''s reason is on the record, verbatim',
  format($$select after->>'reason' from public.audit_events
            where organisation_id=%L and action='organisation.suspended'
            order by created_at asc limit 1$$, :'alpha_org'),
  'non-payment, invoice 902');
select lc.val('LA4 THE SUMMARY: counts, both clocks and the period end, all present',
  format($$select (after ? 'active_members' and after ? 'published_profiles'
                   and after ? 'retention_expires_at' and after ? 'network_presence_until'
                   and after ? 'lifecycle_state')::text
             from public.audit_events
            where organisation_id=%L and action='organisation.suspended'
            order by created_at asc limit 1$$, :'alpha_org'), 'true');
select lc.val('LA4b ...and the counts are real, not zeros (ALPHA has members)',
  format($$select ((after->>'active_members')::int > 0)::text
             from public.audit_events
            where organisation_id=%L and action='organisation.suspended'
            order by created_at asc limit 1$$, :'alpha_org'), 'true');
-- NO TENANT RECORD CONTENT. The same discipline § IA asserts for the
-- impersonation rows: a summary is counts, and a count is not content.
-- THE REASON IS CUSTOMER-VISIBLE, AND THAT IS AN INTENDED PROPERTY WITH A
-- TEST, NOT AN ACCIDENT. Found in self-review: public.organisations is
-- readable by every active member (organisations_select_member) and RLS
-- filters ROWS, not columns, so a member reads lifecycle_reason from
-- PostgREST -- while the first cut of the banner deliberately hid it. The
-- product now shows it and the operator's form warns them before they type
-- (20260908032000). This assertion is what keeps the two halves agreeing: if
-- it ever fails because a member can no longer read the column, the banner and
-- the form hint are both wrong and must move with it.
-- ALPHA is ACTIVE at this point (LR13b reinstated it), and an active workspace
-- has no reason to read -- so this plants one rather than asserting against
-- whatever happens to be there, and clears it again.
\o /dev/null
update public.organisations
   set deleted_at = now(), lifecycle_reason = 'Non-payment: invoice 902.'
 where id = :'alpha_org';
\o
set role authenticated;
set request.jwt.claims = :'powner_c';
select lc.val('LA5a INTENDED DISCLOSURE: a member of the workspace reads the operator''s reason',
  $$select lifecycle_reason from public.organisations where slug='org-alpha'$$,
  'Non-payment: invoice 902.');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select lc.val('LA5b ...and a FOREIGN organisation''s Owner reads nothing at all',
  $$select lifecycle_reason from public.organisations where slug='org-alpha'$$,
  '<null>');
reset role; reset request.jwt.claims;
\o /dev/null
update public.organisations set deleted_at = null where id = :'alpha_org';
\o

select lc.val('LA5 the payload names no contact, no email and no record id',
  format($$select count(*)::text from public.audit_events
            where organisation_id=%L and action in ('organisation.suspended',
                    'organisation.deleted','organisation.reinstated')
              and (after::text ~* '@|contact|event_id|display_name')$$, :'alpha_org'), '0');

-- THE THREADING MECHANISM, MEASURED DIRECTLY RATHER THAN INFERRED. Every row
-- above happens to be alone on its thread, so LA1b would pass identically
-- against a function that still minted a fresh id per call. This is the
-- assertion that distinguishes the two: two audit writes inside one declared
-- operation land on ONE thread.
do $$
declare v_corr uuid := pg_catalog.gen_random_uuid(); v_super uuid; v_alpha uuid; n int;
begin
  select id into v_alpha from public.organisations where slug='org-alpha';
  select user_id into v_super from public.platform_admins limit 1;
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', v_super, 'role','authenticated','aal','aal2')::text, true);
  perform private.begin_lifecycle_transition(v_corr);
  perform private.log_audit_event('lifecycle.probe.one', 'organisation', v_alpha);
  perform private.log_audit_event('lifecycle.probe.two', 'organisation', v_alpha);
  perform private.end_lifecycle_transition();
  perform private.log_audit_event('lifecycle.probe.three', 'organisation', v_alpha);

  select count(distinct correlation_id) into n from public.audit_events
   where action in ('lifecycle.probe.one','lifecycle.probe.two');
  perform lc.record(
    'LA6 THREADING: two audit writes inside one declared operation share one correlation id',
    '1', n::text);
  select count(*) into n from public.audit_events
   where action = 'lifecycle.probe.three' and correlation_id = v_corr;
  perform lc.record(
    'LA6b ...and a write AFTER the operation closes is NOT on that thread',
    '0', n::text);

  delete from public.audit_events where action like 'lifecycle.probe.%';
  perform pg_catalog.set_config('request.jwt.claims','',true);
end $$;

-- ===========================================================================
-- § LN  NETWORK PRESENCE -- Q88, Q92 AND Q101
--
-- network_leakage_phase6.sql § LJ drives the same boundary through the
-- DIRECTORY VIEW, from a real counterparty's session. This section drives the
-- PREDICATE, so that a failure says which of the three clocks moved.
--
-- ALPHA's own subscription is used and restored.
-- ===========================================================================
select lc.val('LN1 ACTIVE: presence, with no clock consulted at all',
  format($$select private.organisation_network_presence_active(%L)::text$$, :'alpha_org'), 'true');

\o /dev/null
update public.organisation_subscriptions set current_period_end = now() + interval '20 days'
 where organisation_id = :'alpha_org';
update public.organisations
   set deleted_at = now(), lifecycle_state = 'suspended',
       lifecycle_reason = 'LN fixture'
 where id = :'alpha_org';
\o
select lc.val('LN2 SUSPENDED, period still running: presence (Q88''s grace)',
  format($$select private.organisation_network_presence_active(%L)::text$$, :'alpha_org'), 'true');

\o /dev/null
update public.organisation_subscriptions set current_period_end = now() - interval '1 day'
 where organisation_id = :'alpha_org';
\o
select lc.val('LN3 SUSPENDED, period ENDED: no presence (the other side of Q88)',
  format($$select private.organisation_network_presence_active(%L)::text$$, :'alpha_org'), 'false');

-- Q92's outer bound. The two clocks are NOT the same date: an annual plan
-- suspended just after a renewal has a period end eleven months out and a
-- retention deadline sixty days out, and the ruling that the organisation is
-- wound down at sixty days is the stronger one. Without this assertion the
-- second term in the predicate could be deleted and everything else would pass.
\o /dev/null
update public.organisation_subscriptions set current_period_end = now() + interval '300 days'
 where organisation_id = :'alpha_org';
-- Through lifecycle_changed_at, not retention_expires_at: the trigger derives
-- the deadline, so writing it directly on a suspended row is overwritten (LR13
-- has the same note).
update public.organisations set lifecycle_changed_at = now() - interval '61 days'
 where id = :'alpha_org';
\o
select lc.val('LN4 Q92: past the 60-day window, no presence even with 300 days of period left',
  format($$select private.organisation_network_presence_active(%L)::text$$, :'alpha_org'), 'false');

\o /dev/null
update public.organisations
   set lifecycle_changed_at = now(), lifecycle_state = 'deleted'
 where id = :'alpha_org';
\o
select lc.val('LN5 Q101: a CLOSED workspace has no presence at once, both clocks running',
  format($$select private.organisation_network_presence_active(%L)::text$$, :'alpha_org'), 'false');

-- The fail-closed branch. Since Phase 7 Task A every organisation carries a
-- subscription row, so this is the "cannot happen" case -- asserted anyway,
-- because the direction it fails in is the whole question for a cross-tenant
-- read.
\o /dev/null
update public.organisations set lifecycle_state = 'suspended',
       lifecycle_changed_at = now() where id = :'alpha_org';
delete from public.organisation_subscriptions where organisation_id = :'alpha_org';
\o
select lc.val('LN6 FAIL CLOSED: no subscription row means no presence, not unlimited presence',
  format($$select private.organisation_network_presence_active(%L)::text$$, :'alpha_org'), 'false');

-- RESTORE THE DATABASE TO WHAT THIS SUITE FOUND: ALPHA active, and its
-- subscription row back to exactly whatever was there before § LF planted one
-- (nothing, today -- so this deletes the plant and re-inserts nothing).
\o /dev/null
update public.organisations set deleted_at = null where id = :'alpha_org';
delete from public.organisation_subscriptions where organisation_id = :'alpha_org';
insert into public.organisation_subscriptions select * from lc.saved_sub;
\o

-- ===========================================================================
-- § LZ  HOUSEKEEPING
--
-- ALPHA is suspended and reinstated a dozen times above. Leaving it wound down
-- would make every HTTP check in run-rls-tests.sh below run against a
-- read-only tenant, and those were written against a live one -- the same
-- failure mode § IZ guards against for impersonation sessions.
-- ===========================================================================
select lc.val('LZ1 ALPHA is left ACTIVE, with every lifecycle column cleared',
  format($$select (lifecycle_state='active' and deleted_at is null
                   and lifecycle_changed_at is null and retention_expires_at is null
                   and lifecycle_reason is null)::text
             from public.organisations where id=%L$$, :'alpha_org'), 'true');
select lc.val('LZ2 ALPHA''s subscription row is back to exactly what § LF found (none)',
  format($$select ((select count(*) from public.organisation_subscriptions where organisation_id=%L)
                   = (select count(*) from lc.saved_sub))::text$$, :'alpha_org'), 'true');
select lc.val('LZ3 BETA was never touched',
  format($$select (lifecycle_state='active' and deleted_at is null)::text
             from public.organisations where id=%L$$, :'beta_org'), 'true');
select lc.val('LZ4 no lifecycle probe rows were left in the audit log',
  $$select count(*)::text from public.audit_events where action like 'lifecycle.probe.%'$$, '0');
select lc.val('LZ5 the AUDIT trail survived (append-only)',
  format($$select (count(*) > 0)::text from public.audit_events
            where organisation_id=%L and action in ('organisation.suspended',
                    'organisation.deleted','organisation.reinstated')$$, :'alpha_org'), 'true');

\pset format aligned
select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
  from lc.results order by seq;
select count(*) filter (where not pass) as failures, count(*) as total from lc.results;

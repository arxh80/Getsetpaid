-- ===========================================================================
-- Phase 7 Task 4 (Billing + feature overrides) RLS suite.
--
-- Covers 20260909000000_billing_and_feature_overrides.sql:
--   organisation_billing_overrides / organisation_feature_overrides
--   private.active_billing_override() / private.active_feature_override()
--   private.effective_organisation_plan()          the shared SQL half
--   private.override_table_guard()                 Gate 2 (defense in depth)
--   public.grant_billing_override / revoke_billing_override
--   public.grant_feature_override / revoke_feature_override
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh
--   It runs LAST of the psql suites, after rls_phase7_lifecycle.sql, and
--   reuses the SAME fixtures whole -- the twelve Phase 2 users, orgs ALPHA
--   and BETA. ALPHA arrives here with NO subscription row (rls_phase7_
--   lifecycle.sql's own § LZ restores it to that state), so this suite plants
--   its own -- SAVED, PLANTED and RESTORED, the same discipline that file's
--   § LF/§ LZ use, so the HTTP block below still runs against the tenant
--   state it was written against.
--
-- IT USES ITS OWN `ov` SCHEMA, so a Task 4 failure is not reported under a
-- Task 3 heading. The helpers are rls_phase7_lifecycle.sql's `lc.*`, verbatim,
-- with the schema renamed.
--
-- SECTIONS:
--   OF  fixtures and their sanity
--   OB  billing override: grant, effective-tier resolution, read visibility
--   OC  billing override: writable only through the audited RPCs
--   OD  billing override: expiry boundary, both sides
--   OE  billing override: revoke
--   OG  DOWNGRADE SAFETY -- an override that lowers the tier denies writes
--       and deletes nothing
--   OH  billing override: the audit trail
--   OI  feature overrides: grant, visibility, write-guard, expiry, revoke,
--       audit -- the same shape as OB-OH, condensed
--   OZ  housekeeping: ALPHA's subscription row and every override created
--       here are cleaned up
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a policy/guard refusal.
--   denied(22023)  rejected by an explicit validation.
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
--
-- psql vars required (supplied by run-rls-tests.sh's P7VARS).
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists ov cascade;
create schema ov;

create table ov.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function ov.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into ov.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function ov.try(p_label text, p_sql text, p_expected text)
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
  perform ov.record(p_label, p_expected, v_actual);
end $$;

create function ov.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform ov.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema ov to authenticated, anon, service_role;
grant execute on function ov.record(text,text,text) to authenticated, anon, service_role;
grant execute on function ov.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function ov.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset
\o

-- ===========================================================================
-- § OF  FIXTURES AND THEIR SANITY
-- ===========================================================================
select ov.val('OF1 FIXTURE: `super` is on the platform_admins allowlist',
  format($$select count(*)::text from public.platform_admins where user_id=%L$$, :'super'), '1');
select ov.val('OF2 FIXTURE: ALPHA is ACTIVE',
  format($$select (deleted_at is null)::text from public.organisations where id=%L$$,
         :'alpha_org'), 'true');

-- ALPHA arrives with NO subscription row (rls_phase7_lifecycle.sql's own
-- § LZ leaves it that way). SAVED, PLANTED, RESTORED -- same discipline.
\o /dev/null
create table ov.saved_sub as
  select * from public.organisation_subscriptions where organisation_id = :'alpha_org';
delete from public.organisation_subscriptions where organisation_id = :'alpha_org';
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'alpha_org', 'pro', 'monthly', 3, 'active', now() + interval '30 days');
\o
select ov.val('OF3 FIXTURE: ALPHA now has a real Pro subscription row',
  format($$select plan_id from public.organisation_subscriptions
            where organisation_id=%L$$, :'alpha_org'), 'pro');
select ov.val('OF4 FIXTURE: ALPHA still has its Phase 5 financial_entries rows',
  format($$select (count(*) > 0)::text from public.financial_entries
            where organisation_id=%L$$, :'alpha_org'), 'true');
\o /dev/null
select count(*) as fin_before from public.financial_entries where organisation_id = :'alpha_org' \gset
\o

-- ===========================================================================
-- § OB  GRANT, EFFECTIVE-TIER RESOLUTION, READ VISIBILITY
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select ov.try('OB1 the superuser grants a billing override naming Pro for ALPHA',
  $$select public.grant_billing_override('org-alpha','pro',null,
             'goodwill extension while the invoice is queried', now()+interval '1 hour')$$,
  'ok(1)');
reset role; reset request.jwt.claims;
select ov.val('OB2 exactly one ACTIVE billing override exists for ALPHA',
  format($$select count(*)::text from public.organisation_billing_overrides
            where organisation_id=%L and revoked_at is null$$, :'alpha_org'), '1');
-- exists(), NOT `(id is not null) from ...`: the latter returns ZERO ROWS
-- (not a row containing false) when the function itself has no active
-- override to return, which ov.val then reports as '<null>' rather than
-- 'false' -- measured, and every occurrence of the naive form below was
-- wrong the same way.
select ov.val('OB3 private.active_billing_override() sees it',
  format($$select exists(select 1 from private.active_billing_override(%L))::text$$,
         :'alpha_org'), 'true');
select ov.val('OB4 private.effective_organisation_plan(): plan_id is the OVERRIDDEN tier',
  format($$select plan_id from private.effective_organisation_plan(%L)$$, :'alpha_org'),
  'pro');
select ov.val('OB4b ...and override_active is true',
  format($$select override_active::text from private.effective_organisation_plan(%L)$$,
         :'alpha_org'), 'true');

-- VISIBILITY. Any ACTIVE MEMBER of ALPHA -- not just its Owner -- can read
-- this row (organisation_billing_overrides_select_member's own comment: the
-- entitlement resolution has to work for every role). A FOREIGN admin cannot.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ov.val('OB5 ALPHA''s own MANAGER (non-admin) reads the active override',
  format($$select count(*)::text from public.organisation_billing_overrides
            where organisation_id=%L$$, :'alpha_org'), '1');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select ov.val('OB6 a FOREIGN organisation''s Owner reads ZERO of ALPHA''s overrides',
  format($$select count(*)::text from public.organisation_billing_overrides
            where organisation_id=%L$$, :'alpha_org'), '0');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § OC  WRITABLE ONLY THROUGH THE AUDITED RPCs
-- ===========================================================================
-- ALPHA's own aal2 Owner cannot write the table directly, granted or not.
set role authenticated;
set request.jwt.claims = :'powner_c';
select ov.try('OC1 ALPHA''s own Owner cannot INSERT a billing override directly',
  format($$insert into public.organisation_billing_overrides
             (organisation_id, override_tier, reason, granted_by, expires_at)
           values (%L,'starter','self-service',%L, now()+interval '1 hour')$$,
         :'alpha_org', :'powner'),
  'denied(42501)');
select ov.try('OC2 ...nor UPDATE the one the superuser just granted',
  format($$update public.organisation_billing_overrides
             set expires_at = now() + interval '999 hours'
           where organisation_id=%L$$, :'alpha_org'),
  'ok(0)');
reset role; reset request.jwt.claims;

-- The superuser THEMSELVES cannot write directly, bypassing the RPCs -- the
-- sanctioned-path marker (private.override_transition_in_progress()) is only
-- ever true inside grant/revoke_*_override(), so a raw PATCH from the
-- superuser's own browser satisfies has_platform_permission and still
-- matches nothing.
set role authenticated;
set request.jwt.claims = :'super_c';
select ov.try('OC3 the SUPERUSER cannot UPDATE the table directly (no transition marker)',
  format($$update public.organisation_billing_overrides
             set expires_at = now() + interval '999 hours'
           where organisation_id=%L$$, :'alpha_org'),
  'ok(0)');
select ov.try('OC4 ...nor INSERT one directly',
  format($$insert into public.organisation_billing_overrides
             (organisation_id, override_tier, reason, granted_by, expires_at)
           values (%L,'starter','direct insert',%L, now()+interval '1 hour')$$,
         :'alpha_org', :'super'),
  'denied(42501)');
select ov.try('OC5 no client role, not even the superuser, may DELETE a row',
  format($$delete from public.organisation_billing_overrides where organisation_id=%L$$,
         :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § OD  EXPIRY BOUNDARY, BOTH SIDES -- READ-TIME EXPIRY, NO SCHEDULER
-- ===========================================================================
-- Backdated as `postgres` (bypasses RLS and the guard trigger, same as every
-- other suite's direct fixture manipulation) to put the ACTIVE row exactly on
-- both sides of the boundary without waiting a real hour.
-- starts_at is ALSO pushed back, or a boundary this close to the grant's own
-- `now()` can put the freshly-computed expires_at BEFORE starts_at and trip
-- organisation_billing_overrides_window (measured: it did, on the first cut
-- of this file). Pushing starts_at safely into the past leaves the window
-- (starts_at, expires_at) intact while moving expires_at across "now" alone.
\o /dev/null
select id as ob1_id from public.organisation_billing_overrides
  where organisation_id = :'alpha_org' and revoked_at is null \gset
update public.organisation_billing_overrides
   set starts_at  = now() - interval '2 hours',
       expires_at = now() + interval '1 second'
 where id = :'ob1_id';
\o
select ov.val('OD1 ONE SECOND BEFORE expiry: still active',
  format($$select exists(select 1 from private.active_billing_override(%L))::text$$,
         :'alpha_org'), 'true');
\o /dev/null
update public.organisation_billing_overrides
   set expires_at = now() - interval '1 second'
 where id = :'ob1_id';
\o
select ov.val('OD2 ONE SECOND AFTER expiry: no longer active (read-time expiry)',
  format($$select exists(select 1 from private.active_billing_override(%L))::text$$,
         :'alpha_org'), 'false');
select ov.val('OD3 ...and effective_organisation_plan() has reverted to the REAL plan (Pro)',
  format($$select plan_id from private.effective_organisation_plan(%L)$$, :'alpha_org'),
  'pro');
select ov.val('OD4 ...with override_active now false',
  format($$select override_active::text from private.effective_organisation_plan(%L)$$,
         :'alpha_org'), 'false');
-- THE ROW STILL EXISTS -- expiry is a READ filter, not a delete.
select ov.val('OD5 the expired row itself is untouched (history, not deleted)',
  format($$select count(*)::text from public.organisation_billing_overrides
            where id=%L$$, :'ob1_id'), '1');

-- ===========================================================================
-- § OE  REVOKE, BEFORE NATURAL EXPIRY
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select ov.try('OE1 grant a FRESH override to revoke early',
  $$select public.grant_billing_override('org-alpha','starter',5,
             'temporary seat bump for a trial', now()+interval '2 hours')$$, 'ok(1)');
reset role; reset request.jwt.claims;
\o /dev/null
select id as ob2_id from public.organisation_billing_overrides
  where organisation_id = :'alpha_org' and revoked_at is null and expires_at > now()
  order by created_at desc limit 1 \gset
\o
set role authenticated;
set request.jwt.claims = :'super_c';
select ov.try('OE2 the superuser revokes it early, with a reason',
  format($$select public.revoke_billing_override(%L,'no longer needed')$$, :'ob2_id'),
  'ok(1)');
reset role; reset request.jwt.claims;
select ov.val('OE3 it is now revoked, not deleted',
  format($$select (revoked_at is not null and revoked_reason='no longer needed')::text
             from public.organisation_billing_overrides where id=%L$$, :'ob2_id'), 'true');
select ov.val('OE4 ...and no longer active',
  format($$select exists(select 1 from private.active_billing_override(%L))::text$$,
         :'alpha_org'), 'false');
set role authenticated;
set request.jwt.claims = :'super_c';
select ov.try('OE5 revoking the SAME id again is refused (already revoked)',
  format($$select public.revoke_billing_override(%L,'twice')$$, :'ob2_id'),
  'denied(22023)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § OG  DOWNGRADE SAFETY -- CLAUDE.md: "must never silently delete data"
--
-- ALPHA is really Pro. An override naming Starter must deny a NEW finance
-- write exactly as a real downgrade would, and must delete NOTHING that is
-- already there.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select ov.try('OG1 the superuser overrides ALPHA DOWN to Starter',
  $$select public.grant_billing_override('org-alpha','starter',null,
             'billing dispute pending resolution', now()+interval '1 hour')$$, 'ok(1)');
reset role; reset request.jwt.claims;
\o /dev/null
select id as og1_id from public.organisation_billing_overrides
  where organisation_id = :'alpha_org' and revoked_at is null and expires_at > now()
  order by created_at desc limit 1 \gset
\o
-- RUN AS ALPHA'S OWN OWNER, NOT `postgres`. private.finance_module_
-- organisations() reads `m.user_id = auth.uid()`, which is NULL for a plain
-- postgres session -- an unqualified call here would return empty regardless
-- of ALPHA's real state, making 'false' pass for the wrong reason.
set role authenticated;
set request.jwt.claims = :'powner_c';
select ov.val('OG2 ALPHA no longer appears in finance_module_organisations()',
  format($$select exists(select 1 from private.finance_module_organisations() x
                           where x=%L)::text$$, :'alpha_org'), 'false');
select ov.try('OG3 a NEW finance write is now REFUSED (downgrade behaviour, not a crash)',
  format($$insert into public.financial_entries
             (organisation_id, event_id, category, amount_minor)
           values (%L,'ef110000-0000-0000-0000-000000000001','cost', 999)$$,
         :'alpha_org'), 'denied(42501)');
select ov.val('OG4 EXISTING finance rows still SELECT -- nothing was deleted',
  format($$select count(*)::text from public.financial_entries
            where organisation_id=%L$$, :'alpha_org'),
  (:'fin_before')::text);
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';
select ov.try('OG5 the superuser revokes the downgrade',
  format($$select public.revoke_billing_override(%L,'dispute resolved, restoring Pro')$$,
         :'og1_id'), 'ok(1)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select ov.val('OG6 ALPHA is Pro again, with finance restored',
  format($$select exists(select 1 from private.finance_module_organisations() x
                           where x=%L)::text$$, :'alpha_org'), 'true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § OH  THE AUDIT TRAIL
-- ===========================================================================
-- THREE grants (OB1, OE1, OG1) + TWO revokes (OE2, OG5) = five. OE5's
-- refused re-revoke wrote no row -- a refusal is not a transition.
select ov.val('OH1 every grant/revoke above wrote exactly one audit row each',
  format($$select count(*)::text from public.audit_events
            where organisation_id=%L and action in
                  ('organisation.billing_override_granted',
                   'organisation.billing_override_revoked')$$, :'alpha_org'), '5');
select ov.val('OH2 the actor is the REAL superuser, never the customer',
  format($$select (count(*) filter (where actor_user_id=%L) = count(*))::text
             from public.audit_events
            where organisation_id=%L and action in
                  ('organisation.billing_override_granted',
                   'organisation.billing_override_revoked')$$, :'super', :'alpha_org'),
  'true');
select ov.val('OH3 the FIRST grant''s reason is on the record, verbatim',
  format($$select after->>'reason' from public.audit_events
            where organisation_id=%L and action='organisation.billing_override_granted'
            order by created_at asc limit 1$$, :'alpha_org'),
  'goodwill extension while the invoice is queried');

-- ===========================================================================
-- § OI  FEATURE OVERRIDES -- the same shape, condensed
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select ov.try('OI1 the superuser grants an early_access_preview override for ALPHA',
  $$select public.grant_feature_override('org-alpha','early_access_preview',
             'design partner for the new panel', now()+interval '1 hour')$$, 'ok(1)');
select ov.val('OI2 private.active_feature_override() sees it',
  format($$select private.active_feature_override(%L,'early_access_preview')::text$$,
         :'alpha_org'), 'true');
select ov.try('OI3 an UNKNOWN flag_key is refused before it ever reaches the CHECK',
  $$select public.grant_feature_override('org-alpha','not_a_real_flag',
             'typo', now()+interval '1 hour')$$, 'denied(22023)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ov.val('OI4 ALPHA''s own MANAGER reads the active feature override',
  format($$select count(*)::text from public.organisation_feature_overrides
            where organisation_id=%L$$, :'alpha_org'), '1');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select ov.val('OI5 a FOREIGN organisation''s Owner reads ZERO',
  format($$select count(*)::text from public.organisation_feature_overrides
            where organisation_id=%L$$, :'alpha_org'), '0');
select ov.try('OI6 ...and cannot write one either',
  format($$insert into public.organisation_feature_overrides
             (organisation_id, flag_key, reason, granted_by, expires_at)
           values (%L,'early_access_preview','self-service',%L,
                   now()+interval '1 hour')$$, :'alpha_org', :'pbowner'),
  'denied(42501)');
reset role; reset request.jwt.claims;

-- starts_at pushed back first -- see § OD's identical fix for why (the check
-- constraint compares against starts_at, not "now").
\o /dev/null
select id as of1_id from public.organisation_feature_overrides
  where organisation_id = :'alpha_org' and revoked_at is null \gset
update public.organisation_feature_overrides
   set starts_at  = now() - interval '2 hours',
       expires_at = now() - interval '1 second'
 where id = :'of1_id';
\o
select ov.val('OI7 EXPIRY: no longer active once expires_at passes',
  format($$select private.active_feature_override(%L,'early_access_preview')::text$$,
         :'alpha_org'), 'false');
\o /dev/null
update public.organisation_feature_overrides
   set expires_at = now() + interval '1 hour'
 where id = :'of1_id';
\o
select ov.val('OI8 ...and reactivating the window makes it active again (no scheduler either way)',
  format($$select private.active_feature_override(%L,'early_access_preview')::text$$,
         :'alpha_org'), 'true');

set role authenticated;
set request.jwt.claims = :'super_c';
select ov.try('OI9 the superuser revokes it',
  format($$select public.revoke_feature_override(%L,'preview period ended')$$, :'of1_id'),
  'ok(1)');
reset role; reset request.jwt.claims;
select ov.val('OI10 no longer active after revoke',
  format($$select private.active_feature_override(%L,'early_access_preview')::text$$,
         :'alpha_org'), 'false');
select ov.val('OI11 the audit trail carries both the grant and the revoke',
  format($$select count(*)::text from public.audit_events
            where organisation_id=%L and action in
                  ('organisation.feature_override_granted',
                   'organisation.feature_override_revoked')$$, :'alpha_org'), '2');

-- ===========================================================================
-- § OZ  HOUSEKEEPING
--
-- Every override this suite created is revoked (never deleted -- there is no
-- delete path, by design) and ALPHA's subscription row is restored to
-- exactly what § OF found (nothing), so the HTTP block below runs against the
-- tenant state it was written against.
-- ===========================================================================
\o /dev/null
update public.organisation_billing_overrides
   set revoked_at = now(), revoked_reason = 'suite housekeeping'
 where organisation_id = :'alpha_org' and revoked_at is null;
update public.organisation_feature_overrides
   set revoked_at = now(), revoked_reason = 'suite housekeeping'
 where organisation_id = :'alpha_org' and revoked_at is null;
delete from public.organisation_subscriptions where organisation_id = :'alpha_org';
insert into public.organisation_subscriptions select * from ov.saved_sub;
\o
select ov.val('OZ1 no ACTIVE billing override remains on ALPHA',
  format($$select (not exists(select 1 from private.active_billing_override(%L)))::text$$,
         :'alpha_org'), 'true');
select ov.val('OZ2 no ACTIVE feature override remains on ALPHA',
  format($$select private.active_feature_override(%L,'early_access_preview')::text$$,
         :'alpha_org'), 'false');
select ov.val('OZ3 ALPHA''s subscription row is back to exactly what § OF found (none)',
  format($$select ((select count(*) from public.organisation_subscriptions
                      where organisation_id=%L)
                   = (select count(*) from ov.saved_sub))::text$$, :'alpha_org'), 'true');
select ov.val('OZ4 ALPHA''s financial_entries are exactly as before (nothing deleted)',
  format($$select (count(*)::text = %L)::text from public.financial_entries
            where organisation_id=%L$$, (:'fin_before')::text, :'alpha_org'), 'true');
select ov.val('OZ5 BETA was never touched',
  format($$select (deleted_at is null)::text from public.organisations where id=%L$$,
         :'beta_org'), 'true');

\pset format aligned
select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
  from ov.results order by seq;
select count(*) filter (where not pass) as failures, count(*) as total from ov.results;

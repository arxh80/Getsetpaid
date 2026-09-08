-- Phase 7, Task A: switch the subscription entitlement gate ON.
--
-- 20260828140000 shipped private.crm_write_organisations() -- the function
-- named in all 25 CRM write policies -- DELIBERATELY INERT: its
-- `s.organisation_id is null` branch reads "no subscription row" as "not yet
-- billed, therefore not yet gated", because create_organisation() wrote no
-- such row and a gate without that branch would have denied every CRM write
-- in the product on the day it shipped. FOLLOW-UPS.md § "Phase 7 --
-- superuser dashboard" calls switching it on a prerequisite for the
-- superuser/billing surfaces this phase builds: "Phase 7 must (1) backfill
-- an organisation_subscriptions row for every existing organisation, (2)
-- make create_organisation() write one, and (3) delete the branch -- in the
-- same migration, in that order. Do it in the wrong order and every tenant
-- loses write access to their own CRM."
--
-- THE SAME ESCAPE IN private.custom_field_limit() (20260829010500) is
-- removed in the SAME change, per that migration's own header: "Phase 7
-- removes this branch in the same migration that backfills the rows, HERE
-- AND IN private.crm_write_organisations(). Both halves, one change." Its
-- polarity is the OPPOSITE of crm_write_organisations()'s, and that is the
-- whole reason it cannot be fixed by deleting a `when` clause the way the
-- other one is: Free's custom_field_limit is 0, so falling through to the
-- plan's-entitlements/Free CASE (the way removing crm_write_organisations()'s
-- branch naturally denies) would read a missing row as "zero custom fields
-- for every organisation that exists", not as "no CRM writes for every
-- organisation that exists" -- the SAME defect this migration's Requirement 1
-- fixes, wearing the opposite sign. So instead of falling through,
-- custom_field_limit() below RAISES when an organisation exists but carries
-- no subscription row -- which Requirement 1 makes structurally impossible
-- from this migration forward (every organisation always has one, from birth
-- or from the backfill below), so the raise is a dead branch in normal
-- operation and a loud failure the day that invariant is ever violated,
-- rather than a silent zero that ships the feature dead or a silent
-- unlimited that reopens the escape this migration exists to close.
--
-- Out of scope, deliberately: private.finance_module_organisations()
-- (20260903001000) and private.network_publish_organisations()
-- (20260904001000) carry the SAME "no subscription row" escape, mirrored
-- clause for clause from crm_write_organisations(), and this migration does
-- NOT touch either of them -- the Phase 7 ledger
-- (.superpowers/sdd/plan-the-whole-build-synthetic-thompson/progress.md)
-- scopes Task A to exactly the two functions above; finance's and network's
-- escapes are a separate follow-up. Their OBSERVABLE behaviour still changes
-- here, because Requirement 1 makes create_organisation() write a real
-- 'starter' row for every new organisation -- so an organisation that used to
-- read "no row -> escape open -> every tier-gated write allowed" now reads
-- "a real Starter row -> finance_module false, network_publish true" for
-- those two gates. That is a consequence of Requirement 1, not a change to
-- either function's source, and the test fixtures below account for it.

-- ===========================================================================
-- REQUIREMENT 1, STEP 1 of 3: BACKFILL.
-- ===========================================================================
-- Every organisation that exists today and carries no organisation_subscriptions
-- row gets one, DONE FIRST so steps 2 and 3 below never observe a gap.
--
-- TIER FOR BACKFILL: 'starter', NOT 'free'. Free's crm_writes is false
-- (CLAUDE.md § Subscription tiers), so backfilling Free would read-only every
-- real workspace on this database the moment this migration applies --
-- including the local e2e/RLS fixture organisations, which assume writes
-- work and are not paying customers making an informed downgrade. Starter is
-- the cheapest tier that keeps CRM writes on, which is the only property this
-- backfill needs: it is not a real billing decision, it is "every
-- organisation that exists was, in effect, already unmetered" made explicit
-- as a row. REAL TIERS ARRIVE WITH THE PAYMENT PROCESSOR (open decision,
-- CLAUDE.md § Open decisions) -- this backfill is not that integration, and
-- every row it writes is expected to be superseded once billing is real.
--
-- Fixture organisations that already carry an explicit subscription row
-- (planted directly by a test, not through create_organisation()) are
-- untouched: the `not exists` guard only ever inserts for an organisation
-- that has none, and organisation_id is UNIQUE on this table besides.
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
select o.id, 'starter', 'monthly', 1, 'active', pg_catalog.now() + interval '30 days'
from public.organisations o
where not exists (
  select 1 from public.organisation_subscriptions s
  where s.organisation_id = o.id
);

-- ===========================================================================
-- REQUIREMENT 1, STEP 2 of 3: create_organisation() WRITES A ROW.
-- ===========================================================================
-- Additive-only constraint (CLAUDE.md § Git workflow / this task's brief):
-- `create or replace function` on the same signature is how a function is
-- corrected without editing the migration that first shipped it -- the
-- pattern every prior fix round in this schema already uses
-- (crm_write_organisations() itself was replaced this way by 20260828150000).
--
-- Body is 20260826154304's, UNCHANGED, plus one insert. Same tier and same
-- reasoning as the backfill above: Starter, the cheapest tier with CRM
-- writes, real tiers to follow once the payment processor is wired. Inside
-- the SAME function body as the organisation and membership inserts, so it
-- shares their atomicity for free -- a function body runs inside the
-- caller's transaction, nothing below catches an exception, and a failure
-- anywhere rolls back the organisation, the membership, the subscription row
-- and the audit record together.
create or replace function public.create_organisation(p_name text, p_slug text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_name  text := pg_catalog.btrim(coalesce(p_name, ''));
  v_slug  text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, '')));
  v_org   uuid;
begin
  -- Defence in depth: this function bypasses RLS, so it re-checks the one
  -- thing RLS would otherwise have guaranteed.
  if v_actor is null then
    raise exception 'create_organisation: no authenticated user (auth.uid() is null)'
      using errcode = '28000';
  end if;

  if v_name = '' then
    raise exception 'create_organisation: name is required' using errcode = '22023';
  end if;

  -- Slugs address organisations in URLs; constrain the shape here rather than
  -- accepting whatever a client sends into a user-facing identifier.
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.length(v_slug) < 2 or pg_catalog.length(v_slug) > 63 then
    raise exception 'create_organisation: slug must be 2-63 chars of lowercase letters, digits and single hyphens (got %)', p_slug
      using errcode = '22023';
  end if;

  insert into public.organisations (name, slug)
  values (v_name, v_slug)
  returning id into v_org;

  insert into public.organisation_memberships
    (organisation_id, user_id, role, status, joined_at)
  values
    (v_org, v_actor, 'owner', 'active', now());

  -- Phase 7, Task A: every organisation now carries a subscription row from
  -- birth, closing the gap private.crm_write_organisations() and
  -- private.custom_field_limit() used to read as "not yet billed, therefore
  -- not yet gated". Starter -- see this migration's header for why.
  insert into public.organisation_subscriptions
    (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
  values
    (v_org, 'starter', 'monthly', 1, 'active', now() + interval '30 days');

  perform private.log_audit_event(
    p_action          => 'organisation.created',
    p_target_type     => 'organisation',
    p_organisation_id => v_org,
    p_target_id       => v_org,
    p_after           => pg_catalog.jsonb_build_object('name', v_name, 'slug', v_slug)
  );

  return v_org;
end;
$$;

comment on function public.create_organisation(text, text) is
  'Creates an organisation plus the caller''s owner membership and a Starter-tier organisation_subscriptions row, atomically, and audits it. The only sanctioned path -- public.organisations has no INSERT policy. Phase 7 Task A: previously wrote no subscription row at all, which is what made private.crm_write_organisations() and private.custom_field_limit()''s "no subscription row" escapes reachable by every organisation in the product; both escapes are removed in the same migration this comment ships with.';

revoke all on function public.create_organisation(text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_organisation(text, text) to authenticated;

-- ===========================================================================
-- REQUIREMENT 1, STEP 3 of 3: DELETE THE ESCAPE FROM crm_write_organisations().
-- ===========================================================================
-- Identical to 20260828150000's body with exactly one thing removed: the
-- `s.organisation_id is null or` branch. Steps 1 and 2 above are what make
-- this safe to remove NOW rather than the day it shipped -- every
-- organisation this function can be asked about has a row by the time this
-- statement runs.
--
-- The LEFT JOINs to organisation_subscriptions/subscription_plans are left as
-- LEFT JOINs rather than tightened to INNER JOINs: with the escape gone, an
-- organisation with no row simply fails every remaining disjunct (s.status is
-- NULL, so `s.status = 'active'` and the past_due branch are both NULL, which
-- is not true, which is not selected) -- the same three-valued-logic
-- fail-closed property 20260828150000's header already relies on for a NULL
-- current_period_end. No raise is needed here the way custom_field_limit()
-- needs one below: crm_write_organisations() is SET-RETURNING, so an
-- organisation simply absent from the set denies every write that names it,
-- which is the correct behaviour whether the missing row is an impossible
-- state (the invariant) or a real one (a caller asking about an organisation
-- this session cannot see, which is only reachable at all through the
-- membership join in the first place).
create or replace function private.crm_write_organisations()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.organisation_memberships m
  join public.organisations o
    on o.id = m.organisation_id
   and o.deleted_at is null
  left join public.organisation_subscriptions s
    on s.organisation_id = m.organisation_id
  left join public.subscription_plans p
    on p.key = s.plan_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (
      p.crm_writes
      and (
        s.status = 'active'
        -- The founder's 3-day grace window. NULL-safe by three-valued logic:
        -- a NULL period end makes this comparison NULL, which is not true,
        -- which denies. See 20260828150000's header.
        or (
          s.status = 'past_due'
          and pg_catalog.now()
              < s.current_period_end
                + pg_catalog.make_interval(days => private.past_due_grace_days())
        )
      )
    );
$$;

comment on function private.crm_write_organisations() is
  'Subscription entitlement (CLAUDE.md § Permissions, second term): the organisations in which auth.uid() is an active member of a not-soft-deleted organisation AND the organisation''s plan permits CRM writes. Mirrors lib/entitlements/policy.ts''s resolveEntitlements() status gate clause for clause -- ''active'' writes; ''past_due'' writes for private.past_due_grace_days() days measured from current_period_end (founder decision, 2026-08-28); ''cancelled'' and anything else do not. An ALLOWLIST of writing statuses, so a fourth status added later arrives denied. Set-returning so a policy can say `organisation_id in (select ...)` and have it hoisted into one InitPlan per statement. LIVE AS OF PHASE 7 TASK A: the "no subscription row" escape (20260828140000/20260828150000) is removed -- every organisation now carries a subscription row from birth (public.create_organisation()) or from this migration''s backfill, so an organisation absent from that row set denies every CRM write. rls_phase2_crm.sql § N is what proves it, both while it was inert and now that it is live.';

revoke all on function private.crm_write_organisations() from public, anon, authenticated, service_role;
grant execute on function private.crm_write_organisations() to authenticated;

-- ===========================================================================
-- REQUIREMENT 2: THE SAME ESCAPE IN private.custom_field_limit(), REMOVED IN
-- THE SAME CHANGE, WITH THE INVARIANT ASSERTED RATHER THAN ASSUMED.
-- ===========================================================================
-- REWRITTEN language sql -> language plpgsql: the SQL version could not raise,
-- and raising is the point -- see this migration's header for why silently
-- falling through to the Free branch (0) is the wrong fix here, unlike in
-- crm_write_organisations() above.
--
-- The join is tightened from LEFT to INNER on organisation_subscriptions:
-- under the LEFT join, an organisation with no row would simply not be
-- FOUND, and "not found" has to be told apart from "the organisation itself
-- does not exist" (still a legitimate caller shape --
-- private.custom_field_slot_available() is the only caller and already
-- establishes existence before trusting this function's NULL, per its own
-- header) from "the organisation exists but the Phase 7 invariant is
-- violated" (a bug, not a caller shape, and the one case that must raise
-- rather than return anything).
create or replace function private.custom_field_limit(p_org_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_found boolean;
begin
  select
    case
      when s.status = 'active'
        or (
          s.status = 'past_due'
          and pg_catalog.now()
              < s.current_period_end
                + pg_catalog.make_interval(days => private.past_due_grace_days())
        )
        then p.custom_field_limit
      else (
        select f.custom_field_limit
        from public.subscription_plans f
        where f.key = 'free'
      )
    end,
    true
  into v_limit, v_found
  from public.organisation_subscriptions s
  left join public.subscription_plans p on p.key = s.plan_id
  where s.organisation_id = p_org_id;

  if v_found then
    return v_limit;
  end if;

  -- No row was found. Either p_org_id names no organisation at all --
  -- fail-open territory this function has never been trusted to answer alone
  -- (private.custom_field_slot_available() establishes existence first, and
  -- is the only caller in the schema) -- or it names one that exists but
  -- carries no subscription row, which Requirement 1 makes structurally
  -- impossible from this migration forward. Told apart so the second case
  -- fails LOUD rather than silently: not Free's 0 (would zero every
  -- organisation''s custom fields the day this ever fired for real), not
  -- unlimited (would reopen the exact escape this migration closes).
  if exists (select 1 from public.organisations o where o.id = p_org_id) then
    raise exception
      'custom_field_limit: organisation % exists but carries no organisation_subscriptions row -- this should be impossible after Phase 7 Task A (public.create_organisation() writes one, and the backfill in 20260908000000 covers every organisation that predates it)',
      p_org_id
      using errcode = 'XX000';
  end if;

  return null;
end;
$$;

comment on function private.custom_field_limit(uuid) is
  'How many LIVE custom field definitions an organisation may hold PER ENTITY TYPE, from its current plan. NULL means unlimited (Pro) or "no such organisation" (fail-open territory: no caller may use this without first establishing the organisation exists -- private.custom_field_slot_available() is the only caller and does exactly that). LIVE AS OF PHASE 7 TASK A: the "no subscription row => unlimited" escape (20260829010500) is removed. It is NOT replaced by "no subscription row => Free''s 0" either -- Free''s limit is 0, so that would zero every organisation''s custom fields the instant the invariant below was ever violated, which is the same defect in the opposite polarity. Instead: an organisation that EXISTS but carries no subscription row RAISES (errcode XX000), because Requirement 1''s backfill plus public.create_organisation() writing one at birth makes that state structurally impossible from this migration forward -- a raise here is a dead branch in normal operation and a loud failure the day that invariant is ever violated, which is the correct failure mode for an inconsistency rather than a plan choice. Status branches mirror private.crm_write_organisations() clause for clause, grace window included, and are an ALLOWLIST so a fourth status arrives denied. Free''s 0 is read out of subscription_plans, not hardcoded. lib/crm/custom-fields.ts''s customFieldLimit() is the TypeScript half; tests/integration/crm/custom-field-limit-matches-db.test.ts drives this deployed function against it.';

revoke all on function private.custom_field_limit(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.custom_field_limit(uuid) to authenticated;

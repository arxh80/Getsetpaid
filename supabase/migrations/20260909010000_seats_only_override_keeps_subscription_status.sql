-- ============================================================================
-- SEATS-ONLY BILLING OVERRIDES NO LONGER BYPASS THE SUBSCRIPTION'S OWN STATUS
-- (Phase 7 Task 4, fix round 1 -- review finding I1)
--
-- 20260909000000's private.effective_organisation_plan() computed status_ok
-- with `coalesce(bo.id is not null, false)` as its first disjunct: ANY active
-- billing override -- INCLUDING one that names only a seat count and no tier
-- (override_tier is null) -- bypassed the real subscription's status. So a
-- seats-only override granted to an organisation whose subscription is
-- cancelled (or past_due beyond grace) silently revived the org's full
-- paid-tier CRM/finance/network writes at the RLS enforcement layer, while:
--
--   (a) the TypeScript half (lib/entitlements/policy.ts's
--       resolveEntitlements()) bypasses status only `if (override?.tier)` --
--       a seats-only override there falls through to the status branches and
--       resolves Free, so the two halves DISAGREED in a reachable state, the
--       exact property the binding-test requirement exists to guarantee; and
--   (b) everything written about seats-only overrides (the function's own
--       comment, ActiveBillingOverride.seats's doc, DECISIONS-QUEUE Q106)
--       says they have NO functional effect today -- no gate in this schema
--       enforces a seat ceiling.
--
-- The fix: the status bypass is now conditional on the override actually
-- NAMING A TIER (`bo.override_tier is not null`), matching the TypeScript
-- rule and the documented intent. A tier-naming override still bypasses
-- status entirely -- a comp must work regardless of billing health, the
-- deliberate semantics 20260909000000's header argues for and the review
-- accepted. A seats-only override goes back to being what it was documented
-- as: carried through seat_count for audit/future use, deciding nothing.
--
-- ADDITIVE, NOT AN EDIT: 20260909000000 is committed and pushed, so the
-- corrected function ships as `create or replace` here -- the same precedent
-- 20260908040000 (Task 3's fix round) set. Everything except the status_ok
-- expression and the comment is verbatim from 20260909000000.
--
-- Pinned by tests/integration/entitlements/billing-override-matches-db.test.ts
-- ("SEATS-ONLY override + CANCELLED subscription"), which drives this deployed
-- function and asserts resolveEntitlements() agrees that both halves DENY.
-- ============================================================================

create or replace function private.effective_organisation_plan(p_org_id uuid)
returns table (
  has_subscription   boolean,
  plan_id            text,
  status_ok          boolean,
  override_active    boolean,
  seat_count         integer,
  crm_writes         boolean,
  network_publish    boolean,
  custom_field_limit integer,
  finance_module     boolean,
  storage_limit_gb   integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.organisation_id is not null as has_subscription,
    coalesce(bo.override_tier, s.plan_id) as plan_id,
    -- THE FIX (review I1): only an override that NAMES A TIER bypasses the
    -- subscription's own status. `bo.override_tier is not null` is false both
    -- when no override row matched the LEFT JOIN and when the active override
    -- is seats-only -- exactly resolveEntitlements()'s `if (override?.tier)`.
    bo.override_tier is not null
      or coalesce(s.status = 'active', false)
      or coalesce(
           s.status = 'past_due'
           and pg_catalog.now() < s.current_period_end
               + pg_catalog.make_interval(days => private.past_due_grace_days()),
           false
         ) as status_ok,
    bo.id is not null as override_active,
    coalesce(bo.override_seats, s.seat_count) as seat_count,
    p.crm_writes,
    p.network_publish,
    p.custom_field_limit,
    p.finance_module,
    p.storage_limit_gb
  from (select p_org_id as organisation_id) probe
  left join public.organisation_subscriptions s
    on s.organisation_id = probe.organisation_id
  left join lateral private.active_billing_override(probe.organisation_id) bo
    on true
  left join public.subscription_plans p
    on p.key = coalesce(bo.override_tier, s.plan_id);
$$;

comment on function private.effective_organisation_plan(uuid) is
  'THE SQL HALF''S SINGLE EFFECTIVE-TIER RESOLUTION POINT (Task 4''s brief: "route them through ONE effective-tier function per half ... do not fork the resolution logic per call site"). Consulted by private.crm_write_organisations(), private.custom_field_limit(), private.finance_module_organisations() and private.network_publish_organisations() -- none of them join organisation_subscriptions/subscription_plans directly any more. plan_id is the OVERRIDDEN tier when private.active_billing_override() returns a row naming one, else the subscription''s own plan_id. status_ok is true when an active override NAMES A TIER (bypassing the subscription''s own status -- an override exists specifically to grant a tier''s features regardless of billing state; corrected by 20260909010000, review finding I1: a SEATS-ONLY override does NOT bypass status, matching lib/entitlements/policy.ts''s resolveEntitlements() and the documented "seats have no functional effect today") OR when the real subscription is active/past_due-in-grace. ALWAYS RETURNS EXACTLY ONE ROW for any p_org_id -- has_subscription (not "row found") is what a caller checks to tell "no subscription row" apart from every capability column simply being null. seat_count is carried through for completeness/audit purposes ONLY: no gate in this schema enforces a seat ceiling today (organisation_subscriptions.seat_count itself is not consumed by any policy either), so overriding it has no functional effect -- queued as DECISIONS-QUEUE Q106 rather than invented scope.';

-- `create or replace` preserves existing grants, but the pair is reissued
-- verbatim so this file states the function's whole access story on its own,
-- same as 20260909000000 did.
revoke all on function private.effective_organisation_plan(uuid) from public, anon, authenticated, service_role;
grant execute on function private.effective_organisation_plan(uuid) to authenticated;

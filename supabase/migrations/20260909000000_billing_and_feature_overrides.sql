-- Phase 7 Task 4: billing overrides + per-org feature overrides.
--
-- CLAUDE.md § Superuser dashboard:
--   "Billing overrides (manual tier/seat change, comps, refunds): require
--    step-up re-auth, a mandatory reason field (goes into the audit record),
--    and notify the org admin automatically. Comps/overrides are time-boxed
--    and auto-revert to the org's actual paid tier when the period ends --
--    never a silent permanent edit."
--   "Per-org feature overrides (early access, custom gating): scoped per org
--    per flag, with a mandatory expiry date -- no open-ended overrides."
--
-- ===========================================================================
-- SHAPE: A SEPARATE TABLE, NEVER A MUTATION OF organisation_subscriptions
-- ===========================================================================
-- organisation_subscriptions carries the org's REAL, paying-customer plan.
-- Writing an override tier into that row IS the "silent permanent edit" the
-- spec forbids -- there would be nothing left recording what the org actually
-- pays for once the override lapses, and "auto-revert" would require some
-- second mechanism to remember the value it just overwrote. So the override
-- lives in its own table, and EFFECTIVE tier resolution (the four SQL gates
-- below, and lib/entitlements/policy.ts on the TypeScript side) consults
-- override-then-subscription. Auto-revert is READ-TIME EXPIRY -- the
-- established no-scheduler pattern this codebase already uses for Q88 network
-- presence (private.organisation_network_presence_active(), 20260908031000):
-- once expires_at passes, the row simply stops being returned by
-- private.active_billing_override() below, and resolution falls back to the
-- subscription with no write, no cron and nothing to forget.
--
-- ===========================================================================
-- ONE EFFECTIVE-TIER FUNCTION, NOT FOUR COPIES OF THE OVERRIDE LOOKUP
-- ===========================================================================
-- private.crm_write_organisations(), private.custom_field_limit(),
-- private.finance_module_organisations() and
-- private.network_publish_organisations() each independently join
-- organisation_subscriptions/subscription_plans today. Task 4's brief:
-- "route them through ONE effective-tier function per half ... do not fork
-- the resolution logic per call site." The override LOOKUP (which row is
-- currently active: not revoked, started, not yet expired, most recent) is
-- exactly the logic a future call site could fork, so it lives in exactly one
-- function -- private.active_billing_override() -- and exactly one function
-- combines it with the subscription row into the shape every gate needs:
-- private.effective_organisation_plan(). Each of the four gates below calls
-- THAT, not organisation_subscriptions directly. They still each apply their
-- OWN capability column (crm_writes / custom_field_limit / finance_module /
-- network_publish) to the result, because a single generic "resolve
-- capability X" function would need dynamic SQL to pick a column by name,
-- which this schema deliberately avoids elsewhere (private.entity_is_
-- manageable() and its TypeScript mirror PERMISSION_FOR_ENTITY dispatch on a
-- fixed case/table for the identical reason).
--
-- private.finance_module_organisations() and
-- private.network_publish_organisations() ALSO still carry the "no
-- subscription row => not yet gated" escape Phase 7 Task A deliberately left
-- in place (their own migrations' headers). That escape is unconditional and
-- orthogonal to overrides -- an organisation with no subscription row has
-- nothing to override -- so it is preserved VERBATIM as
-- `not e.has_subscription or (...)` rather than folded into the shared
-- function, which would have made the shared function's contract different
-- for two callers than for the other two.
--
-- private.crm_write_organisations() and private.custom_field_limit() have NO
-- such escape (Task A removed it): every organisation is guaranteed a
-- subscription row from birth or from that migration's backfill, so
-- `effective_organisation_plan()`'s crm_writes/custom_field_limit columns are
-- simply null (fail closed) when has_subscription is false, exactly
-- reproducing Task A's behaviour.
--
-- ===========================================================================
-- WHY AN OVERRIDE BYPASSES SUBSCRIPTION STATUS ENTIRELY
-- ===========================================================================
-- private.effective_organisation_plan()'s `status_ok` is true the instant an
-- override is active, REGARDLESS of whether the underlying subscription is
-- active/past_due/cancelled. That is deliberate: the whole point of a
-- superuser comp is to grant a tier's features to an organisation whose
-- billing state would otherwise deny them -- a goodwill extension to a
-- cancelled account, a Pro trial for a Starter customer negotiating a
-- contract, a fix for a payment processor issue. An override that only
-- worked while the subscription was ALSO healthy would not be an override at
-- all. Once it expires or is revoked, resolution falls straight back to
-- whatever the real subscription says, with no special-casing needed.
--
-- ===========================================================================
-- DOWNGRADE SAFETY: AN OVERRIDE THAT LOWERS THE TIER BEHAVES LIKE A REAL
-- DOWNGRADE, BECAUSE IT IS THE SAME MECHANISM
-- ===========================================================================
-- CLAUDE.md: "Downgrading a subscription makes features read-only or
-- limited; it must never silently delete data." An override naming a LOWER
-- tier than the org's real plan is not a special case here -- it flows
-- through the identical `p.finance_module` / `p.custom_field_limit` /
-- `p.network_publish` reads the real plan would produce, off the overridden
-- plan's row in subscription_plans. Nothing in this migration deletes a row
-- when an override narrows a capability, because nothing in the four gates
-- it touches ever did: they are all READ-TIME entitlement checks, and a
-- write that a narrower tier now refuses simply refuses -- existing rows
-- (financial_entries, custom_field_values, network_profiles) are untouched,
-- exactly as an ordinary subscription downgrade already proves in
-- rls_phase5_finance.sql / rls_phase6_network.sql. supabase/tests/
-- rls_phase7_overrides.sql § OD re-measures this directly for an override
-- specifically, rather than trusting the analogy.
--
-- ===========================================================================
-- FEATURE OVERRIDES: THE ALLOWLIST SHAPE (queued, DECISIONS-QUEUE Q105)
-- ===========================================================================
-- The brief: "add a flag_key allowlist (CHECK or lookup) seeded with e.g.
-- 'early_access_preview' so arbitrary strings can't accumulate." A CHECK
-- constraint is chosen over a lookup table: at MVP there is exactly one flag,
-- nothing reads the allowlist except this one constraint and the mirroring
-- RPC-level check, and a lookup table buys extensibility (a flag catalogue
-- with descriptions, a superuser UI listing "known flags") that nothing in
-- this phase needs yet. Queued as Q105 with this as the shipped default: the
-- day a second real flag needs a description or a self-service picker rather
-- than a migration, promote it to a table the way subscription_plans already
-- is one.
--
-- AT MVP NO FEATURE FLAG GATES ANYTHING REAL -- per the brief ("gate nothing
-- existing"). private.active_feature_override() and its TypeScript mirror
-- hasActiveFeatureOverride() are wired to exactly ONE consumer, an "Early
-- access preview" badge on the workspace home
-- (app/(app)/[orgSlug]/page.tsx) that renders only when the org's own
-- 'early_access_preview' override is active -- proving grant -> read ->
-- render end to end without touching any shipped feature's behaviour.
--
-- ===========================================================================
-- THE GUARD: REUSING TASK 3's GATE-2 SHAPE, AS DEFENSE IN DEPTH RATHER THAN
-- A FIX FOR A HOLE THAT EXISTS TODAY
-- ===========================================================================
-- Task 3's two-gate pattern (20260908040000) existed because a PRE-EXISTING,
-- more permissive policy on public.organisations (organisations_update_
-- manage_organisation) could already reach the lifecycle columns through its
-- own ungated WITH CHECK -- the trigger was the gate that did not depend on
-- getting every co-existing policy right. These two tables are BRAND NEW:
-- there is no other INSERT/UPDATE policy on either of them today, so Gate 1
-- alone (the superuser policy + the transition marker) already closes every
-- reachable path. The trigger is added anyway, because the brief asks for
-- the shape to be reused and because its value is exactly what Task 3's
-- comment says: it is policy-INDEPENDENT, so it keeps holding if a later
-- phase adds a THIRD policy to either table without reading this file. The
-- marker mechanism is its own (app.override_transition), not the lifecycle
-- one (app.lifecycle_correlation_id) -- the two features are unrelated
-- operations and sharing a GUC would make one feature's transaction boundary
-- leak into the other's.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE TWO TABLES
-- ---------------------------------------------------------------------------

create table public.organisation_billing_overrides (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations (id) on delete cascade,
  -- The overridden tier. References subscription_plans(key) so an invalid
  -- tier is an FK violation, not a typo that silently resolves to nothing.
  override_tier    text references public.subscription_plans (key),
  override_seats   integer check (override_seats is null or override_seats >= 1),
  reason           text not null check (pg_catalog.btrim(reason) <> ''),
  granted_by       uuid not null references auth.users (id),
  starts_at        timestamptz not null default pg_catalog.now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users (id),
  revoked_reason   text,
  created_at       timestamptz not null default pg_catalog.now(),
  constraint organisation_billing_overrides_names_something
    check (override_tier is not null or override_seats is not null),
  constraint organisation_billing_overrides_window
    check (expires_at > starts_at),
  constraint organisation_billing_overrides_revocation_reason
    check ((revoked_at is null) = (revoked_reason is null))
);

comment on table public.organisation_billing_overrides is
  'Superuser billing overrides (CLAUDE.md § Superuser dashboard): a time-boxed, audited override of an organisation''s EFFECTIVE tier and/or seat count, distinct from its real organisation_subscriptions row -- writing the override tier into that row instead would be the "silent permanent edit" the spec forbids. At most one row per organisation is ever ACTIVE (revoked_at is null, starts_at <= now() < expires_at) at a time -- public.grant_billing_override() supersedes rather than stacks. Auto-revert is READ-TIME EXPIRY: private.active_billing_override() simply stops returning an expired row, so expiry needs no scheduled job. Writable only through the audited superuser RPCs below (organisation_billing_overrides_guard + the RLS policies'' transition-marker term). expires_at is NOT NULL per the brief -- there is no open-ended billing override.';

create index organisation_billing_overrides_org_idx
  on public.organisation_billing_overrides (organisation_id, expires_at desc);

-- CLAUDE.md § Non-negotiable rules: "Index every foreign key." organisation_id
-- is covered by the composite index above (leading column); these three are
-- not, and schema_invariants.sql § D3 checks every FK in `public`, not just
-- the tenant-scoped ones.
create index organisation_billing_overrides_tier_idx
  on public.organisation_billing_overrides (override_tier);
create index organisation_billing_overrides_granted_by_idx
  on public.organisation_billing_overrides (granted_by);
create index organisation_billing_overrides_revoked_by_idx
  on public.organisation_billing_overrides (revoked_by);

-- EXPLICIT GRANTS -- the default-privileges baseline for a new table in this
-- schema gives `authenticated` NOTHING (schema_invariants.sql § D7), so every
-- table that role must reach at all needs its own grant, same as
-- 20260904000000 does for the three network tables. NO DELETE: revocation is
-- a column write, never a row removal (this table's own comment).
revoke all on public.organisation_billing_overrides from public, anon, authenticated, service_role;
grant select, insert, update on public.organisation_billing_overrides to authenticated;

alter table public.organisation_billing_overrides enable row level security;


create table public.organisation_feature_overrides (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations (id) on delete cascade,
  -- ALLOWLIST (this migration's header, Q105): one flag exists at MVP.
  -- Extend this CHECK, in an additive migration, the day a second one ships.
  flag_key         text not null check (flag_key in ('early_access_preview')),
  reason           text not null check (pg_catalog.btrim(reason) <> ''),
  granted_by       uuid not null references auth.users (id),
  starts_at        timestamptz not null default pg_catalog.now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users (id),
  revoked_reason   text,
  created_at       timestamptz not null default pg_catalog.now(),
  constraint organisation_feature_overrides_window
    check (expires_at > starts_at),
  constraint organisation_feature_overrides_revocation_reason
    check ((revoked_at is null) = (revoked_reason is null))
);

comment on table public.organisation_feature_overrides is
  'Superuser per-org feature overrides (CLAUDE.md § Superuser dashboard): scoped per organisation per flag_key, mandatory expiry (no open-ended overrides). flag_key is an ALLOWLIST (Q105) -- extend the CHECK constraint to add a flag rather than accepting an arbitrary string. At most one row per (organisation, flag_key) is ever ACTIVE at a time -- public.grant_feature_override() supersedes rather than stacks. At MVP this gates nothing shipped; the one consumer (an "Early access preview" badge on the workspace home) exists to prove the wiring, per the brief. Writable only through the audited superuser RPCs below.';

create index organisation_feature_overrides_org_idx
  on public.organisation_feature_overrides (organisation_id, flag_key, expires_at desc);

create index organisation_feature_overrides_granted_by_idx
  on public.organisation_feature_overrides (granted_by);
create index organisation_feature_overrides_revoked_by_idx
  on public.organisation_feature_overrides (revoked_by);

revoke all on public.organisation_feature_overrides from public, anon, authenticated, service_role;
grant select, insert, update on public.organisation_feature_overrides to authenticated;

alter table public.organisation_feature_overrides enable row level security;


-- ---------------------------------------------------------------------------
-- 2. THE TRANSITION MARKER -- Task 3's Gate-2 shape, its OWN GUC
--    (app.override_transition), independent of the lifecycle feature's.
--    DEFINED BEFORE THE RLS POLICIES BELOW BECAUSE THEY REFERENCE IT: a
--    policy body is resolved at CREATE POLICY time, so the function it names
--    must already exist.
-- ---------------------------------------------------------------------------

create or replace function private.begin_override_transition()
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if not (
    private.has_platform_permission('manage_billing')
    or private.has_platform_permission('manage_feature_overrides')
  ) then
    raise exception 'begin_override_transition: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;
  perform pg_catalog.set_config('app.override_transition', 'true', true);
end;
$$;

comment on function private.begin_override_transition() is
  'OPENS one billing/feature-override write. Sets the transaction-scoped (is_local) marker private.override_transition_in_progress() reads, which is the second term of every INSERT/UPDATE policy on the two override tables -- so a raw PostgREST PATCH/POST from the superuser''s own browser, which never calls this function, matches nothing. Guarded here too (not just by the calling RPC) because it is reachable from any SECURITY INVOKER context, however this migration''s RPCs evolve. Must be paired with private.end_override_transition() -- an is_local GUC stands to the end of the TRANSACTION regardless of the call stack''s own SET clauses (measured and documented at length by 20260908030000 for the identical lifecycle marker).';

revoke all on function private.begin_override_transition() from public, anon, service_role;
grant execute on function private.begin_override_transition() to authenticated;

create or replace function private.end_override_transition()
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.set_config('app.override_transition', '', true);
end;
$$;

comment on function private.end_override_transition() is
  'CLOSES the write private.begin_override_transition() opened. Called as the last statement of every grant/revoke RPC below. Not optional: without it, the superuser''s NEXT statement in the same transaction would still satisfy the override tables'' INSERT/UPDATE policies.';

revoke all on function private.end_override_transition() from public, anon, service_role;
grant execute on function private.end_override_transition() to authenticated;

create or replace function private.override_transition_in_progress()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.current_setting('app.override_transition', true) = 'true';
$$;

comment on function private.override_transition_in_progress() is
  'True iff private.begin_override_transition() has been called in this transaction and private.end_override_transition() has not since closed it. The sanctioned-path marker for both override tables'' INSERT/UPDATE policies.';

revoke all on function private.override_transition_in_progress() from public, anon, service_role;
grant execute on function private.override_transition_in_progress() to authenticated;


-- ---------------------------------------------------------------------------
-- 3. THE GUARD TRIGGER -- Task 3's Gate 2, generic over both tables via
--    TG_TABLE_NAME. Policy-independent: it consults no policy, only the
--    marker above, so it keeps holding if a later phase adds a third policy
--    to either table without reading this file.
-- ---------------------------------------------------------------------------

create or replace function private.override_table_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- row_security_active() is false exactly for the roles that bypass RLS
  -- (`postgres`, `service_role`) -- migrations, DBA repair and every psql/e2e
  -- fixture that seeds an override directly are unaffected; nothing reachable
  -- through PostgREST is exempt. Explicit ::regclass cast: a text argument
  -- reaching a regclass-typed parameter through implicit function-argument
  -- resolution is not guaranteed the way a literal is (20260908040000 passes
  -- a literal; this trigger is generic over two tables and has to build the
  -- name at runtime).
  if not pg_catalog.row_security_active(
    (tg_table_schema || '.' || tg_table_name)::regclass
  ) then
    return coalesce(new, old);
  end if;

  if not private.override_transition_in_progress() then
    raise exception '% is writable only through the audited superuser override RPCs', tg_table_name
      using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;

comment on function private.override_table_guard() is
  'THE SECOND, POLICY-INDEPENDENT GATE on organisation_billing_overrides and organisation_feature_overrides (Task 3''s Gate-2 shape, reused as defense in depth -- see this migration''s header for why these brand-new tables do not already have the hole Task 3''s version closed). Raises 42501 on any INSERT/UPDATE from a client-path caller that did not go through private.begin_override_transition(). Exempts rolbypassrls callers (`postgres`, `service_role`) via row_security_active(), the same exemption 20260908040000 measured and documented for is_superuser''s failure on this stack.';

drop trigger if exists organisation_billing_overrides_guard on public.organisation_billing_overrides;
create trigger organisation_billing_overrides_guard
  before insert or update on public.organisation_billing_overrides
  for each row execute function private.override_table_guard();

drop trigger if exists organisation_feature_overrides_guard on public.organisation_feature_overrides;
create trigger organisation_feature_overrides_guard
  before insert or update on public.organisation_feature_overrides
  for each row execute function private.override_table_guard();


-- ---------------------------------------------------------------------------
-- 4. RLS -- readable by any active member of the organisation (the same
--    breadth as organisation_subscriptions_select_member: every role already
--    sees its own org's plan, seat count and billing status, so seeing an
--    override that changes them for a while is no larger a disclosure), plus
--    the platform superuser cross-tenant. WRITABLE ONLY BY THE SUPERUSER RPCs.
--
-- WHY "ANY ACTIVE MEMBER" AND NOT "ORG ADMIN ONLY", DESPITE THE BRIEF SAYING
-- "org admin sees own org's overrides read-only" IN ITS TEST-LIST LANGUAGE.
-- lib/entitlements/policy.ts's getOrganisationEntitlements() is called for
-- EVERY role, not just Owner/Admin -- a Marketing user's own session decides
-- whether it may publish to the network by querying its own organisation's
-- effective entitlements, and that query has to see an active override or the
-- override would silently not apply for anyone but an admin's own page loads.
-- The brief's "admins see it" is satisfied by the SURFACING requirement
-- (item 4: "visible to the org's admins in-app") -- app/(app)/[orgSlug]/
-- page.tsx renders the early-access badge for every member and the billing-
-- override clock for Owner/Admin only (lib/entitlements/billing-override-
-- summary.ts), both built ON TOP of this broader read, gating what they SHOW
-- rather than narrowing what the row policy allows. This mirrors the exact
-- reasoning
-- Q103 already established for organisations.lifecycle_reason: RLS filters
-- ROWS, not COLUMNS, and RESTRICTING who can see a comp is a UI decision, not
-- a policy one, once every role's own entitlement resolution already needs
-- the row's existence.
-- ---------------------------------------------------------------------------

create policy organisation_billing_overrides_select_member
  on public.organisation_billing_overrides for select to authenticated
  using ( (select private.is_active_member(organisation_id)) );

create policy organisation_billing_overrides_select_platform
  on public.organisation_billing_overrides for select to authenticated
  using ( (select private.has_platform_permission('manage_billing')) );

comment on policy organisation_billing_overrides_select_platform on public.organisation_billing_overrides is
  'PERMITS the platform superuser, at aal2 (has_platform_permission), to read every organisation''s billing overrides -- the /super/billing list, and the prerequisite for the UPDATE below to match rows at all (Postgres applies SELECT policies to an UPDATE''s row-matching; the superuser is a member of no organisation, so without this every revoke would silently match zero rows -- the same trap organisation_subscriptions_select_platform_billing and organisations_select_platform_lifecycle both document).';

create policy organisation_billing_overrides_insert_platform
  on public.organisation_billing_overrides for insert to authenticated
  with check (
    (select private.has_platform_permission('manage_billing'))
    and (select private.override_transition_in_progress())
  );

create policy organisation_billing_overrides_update_platform
  on public.organisation_billing_overrides for update to authenticated
  using (
    (select private.has_platform_permission('manage_billing'))
    and (select private.override_transition_in_progress())
  )
  with check (
    (select private.has_platform_permission('manage_billing'))
    and (select private.override_transition_in_progress())
  );

comment on policy organisation_billing_overrides_insert_platform on public.organisation_billing_overrides is
  'Writable only from inside public.grant_billing_override() / revoke_billing_override(): has_platform_permission says WHO, private.override_transition_in_progress() says THROUGH WHAT (true only inside a transaction opened by private.begin_override_transition(), which only those two RPCs call). No INSERT/UPDATE/DELETE policy exists for any other role -- an org''s own Owner or Admin can SELECT their overrides and cannot touch this table at all. private.override_table_guard() is the second, policy-independent gate on the same two operations (Task 3''s Gate-2 shape, reused as defense in depth per this migration''s header).';

comment on policy organisation_billing_overrides_update_platform on public.organisation_billing_overrides is
  'See organisation_billing_overrides_insert_platform''s comment -- identical shape, for UPDATE (the revoke path and the grant RPC''s own supersede-on-grant step).';

-- No DELETE policy on this table, for any role. Revocation is a column write
-- (revoked_at/revoked_by/revoked_reason), not a row removal -- the same
-- append-only discipline CLAUDE.md's audit rules already apply to
-- audit_events, so a revoked override's full history (who, when, why) stays
-- readable rather than disappearing.


create policy organisation_feature_overrides_select_member
  on public.organisation_feature_overrides for select to authenticated
  using ( (select private.is_active_member(organisation_id)) );

create policy organisation_feature_overrides_select_platform
  on public.organisation_feature_overrides for select to authenticated
  using ( (select private.has_platform_permission('manage_feature_overrides')) );

create policy organisation_feature_overrides_insert_platform
  on public.organisation_feature_overrides for insert to authenticated
  with check (
    (select private.has_platform_permission('manage_feature_overrides'))
    and (select private.override_transition_in_progress())
  );

create policy organisation_feature_overrides_update_platform
  on public.organisation_feature_overrides for update to authenticated
  using (
    (select private.has_platform_permission('manage_feature_overrides'))
    and (select private.override_transition_in_progress())
  )
  with check (
    (select private.has_platform_permission('manage_feature_overrides'))
    and (select private.override_transition_in_progress())
  );

-- No DELETE policy here either, for the same reason.


-- ---------------------------------------------------------------------------
-- 5. THE SHARED OVERRIDE-LOOKUP FUNCTIONS
-- ---------------------------------------------------------------------------

create or replace function private.organisation_id_for_slug(p_slug text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id
  from public.organisations o
  where o.slug = pg_catalog.btrim(pg_catalog.lower(p_slug));
$$;

comment on function private.organisation_id_for_slug(text) is
  'Slug -> organisation id, or null. Shared preamble for the four override RPCs below -- the operator has no directory of uuids, same reasoning as public.request_impersonation() and the three lifecycle RPCs.';

revoke all on function private.organisation_id_for_slug(text) from public, anon, authenticated, service_role;
grant execute on function private.organisation_id_for_slug(text) to authenticated;


create or replace function private.active_billing_override(p_org_id uuid)
returns table (
  id             uuid,
  override_tier  text,
  override_seats integer,
  expires_at     timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.override_tier, o.override_seats, o.expires_at
  from public.organisation_billing_overrides o
  where o.organisation_id = p_org_id
    and o.revoked_at is null
    and o.starts_at <= pg_catalog.now()
    and o.expires_at > pg_catalog.now()
  order by o.created_at desc
  limit 1;
$$;

comment on function private.active_billing_override(uuid) is
  'THE ONE PLACE "is there a currently-active billing override" is decided: not revoked, started, not yet expired (READ-TIME EXPIRY -- no scheduler clears an expired row, it simply stops matching this query). Returns at most one row -- public.grant_billing_override() supersedes any existing active override rather than letting two stack, so "most recent" is a tie-breaker that should never actually break a tie. SECURITY DEFINER so private.effective_organisation_plan() below can call it regardless of the caller''s own RLS-scoped visibility. lib/entitlements/policy.ts''s getOrganisationEntitlements() mirrors this exact predicate against organisation_billing_overrides under the caller''s own RLS (organisation_billing_overrides_select_member) -- tests/integration/entitlements/billing-override-matches-db.test.ts binds the two.';

revoke all on function private.active_billing_override(uuid) from public, anon, authenticated, service_role;
grant execute on function private.active_billing_override(uuid) to authenticated;


create or replace function private.active_feature_override(p_org_id uuid, p_flag_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organisation_feature_overrides o
    where o.organisation_id = p_org_id
      and o.flag_key = p_flag_key
      and o.revoked_at is null
      and o.starts_at <= pg_catalog.now()
      and o.expires_at > pg_catalog.now()
  );
$$;

comment on function private.active_feature_override(uuid, text) is
  'Is flag_key CURRENTLY active (not revoked, started, not yet expired) for this organisation? Read-time expiry, same shape as private.active_billing_override(). Gates nothing shipped at MVP -- see this migration''s header -- lib/entitlements/feature-overrides.ts''s hasActiveFeatureOverride() is the TypeScript mirror its one consumer (the workspace home''s early-access badge) calls.';

revoke all on function private.active_feature_override(uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.active_feature_override(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. THE ONE EFFECTIVE-TIER FUNCTION EVERY GATE BELOW CALLS
--
-- Always returns exactly one row for any p_org_id (the `(select p_org_id)`
-- seed makes the two LEFT JOINs optional), with has_subscription telling a
-- real "no subscription row" apart from every column simply being null.
-- ---------------------------------------------------------------------------

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
    coalesce(bo.id is not null, false)
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
  'THE SQL HALF''S SINGLE EFFECTIVE-TIER RESOLUTION POINT (Task 4''s brief: "route them through ONE effective-tier function per half ... do not fork the resolution logic per call site"). Consulted by private.crm_write_organisations(), private.custom_field_limit(), private.finance_module_organisations() and private.network_publish_organisations() -- none of them join organisation_subscriptions/subscription_plans directly any more. plan_id is the OVERRIDDEN tier when private.active_billing_override() returns a row, else the subscription''s own plan_id. status_ok is true when an override is active (BYPASSING the subscription''s own status -- see this migration''s header for why: an override exists specifically to grant a tier''s features regardless of billing state) OR when the real subscription is active/past_due-in-grace. ALWAYS RETURNS EXACTLY ONE ROW for any p_org_id -- has_subscription (not "row found") is what a caller checks to tell "no subscription row" apart from every capability column simply being null. seat_count is carried through for completeness/audit purposes ONLY: no gate in this schema enforces a seat ceiling today (organisation_subscriptions.seat_count itself is not consumed by any policy either), so overriding it has no functional effect yet -- queued as a known gap in task-4-report.md rather than invented scope.';

revoke all on function private.effective_organisation_plan(uuid) from public, anon, authenticated, service_role;
grant execute on function private.effective_organisation_plan(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 7. THE FOUR GATES, REWRITTEN TO CALL IT
-- ---------------------------------------------------------------------------

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
  join lateral private.effective_organisation_plan(m.organisation_id) e on true
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and e.crm_writes
    and e.status_ok;
$$;

comment on function private.crm_write_organisations() is
  'Subscription entitlement (CLAUDE.md § Permissions, second term) for CRM writes: the organisations in which auth.uid() is an active member of a not-soft-deleted organisation AND private.effective_organisation_plan() says crm_writes and status_ok. SINCE PHASE 7 TASK 4: routed through private.effective_organisation_plan() rather than joining organisation_subscriptions/subscription_plans inline, so an active billing override''s tier is consulted automatically -- e.status_ok is true while an override is active regardless of the real subscription''s status, and e.crm_writes then reads off the OVERRIDDEN plan. No "no subscription row" escape (Task A removed it, and effective_organisation_plan()''s has_subscription=false yields a null crm_writes here, which fails closed exactly as before). lib/entitlements/policy.ts''s resolveEntitlements() is the TypeScript mirror; tests/integration/crm/crm-write-access-matches-db.test.ts and tests/integration/entitlements/billing-override-matches-db.test.ts both bind against this deployed function.';

revoke all on function private.crm_write_organisations() from public, anon, authenticated, service_role;
grant execute on function private.crm_write_organisations() to authenticated;


create or replace function private.custom_field_limit(p_org_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_has_subscription boolean;
  v_limit            integer;
begin
  select
    e.has_subscription,
    case
      when e.status_ok then e.custom_field_limit
      else (select f.custom_field_limit from public.subscription_plans f where f.key = 'free')
    end
  into v_has_subscription, v_limit
  from private.effective_organisation_plan(p_org_id) e;

  if v_has_subscription then
    return v_limit;
  end if;

  -- No subscription row. Either p_org_id names no organisation at all
  -- (fail-open territory this function has never been trusted to answer
  -- alone -- private.custom_field_slot_available() establishes existence
  -- first) or it names one that exists but carries no subscription row,
  -- which Phase 7 Task A made structurally impossible from that migration
  -- forward. Unchanged from Task A's own raise -- this migration only moved
  -- WHERE the has_subscription flag comes from, not what it means.
  if exists (select 1 from public.organisations o where o.id = p_org_id) then
    raise exception
      'custom_field_limit: organisation % exists but carries no organisation_subscriptions row -- this should be impossible after Phase 7 Task A',
      p_org_id
      using errcode = 'XX000';
  end if;

  return null;
end;
$$;

comment on function private.custom_field_limit(uuid) is
  'How many LIVE custom field definitions an organisation may hold PER ENTITY TYPE, from its EFFECTIVE plan. NULL means unlimited (Pro, including an override naming Pro) or "no such organisation". SINCE PHASE 7 TASK 4: routed through private.effective_organisation_plan(), so an active billing override''s tier decides the limit exactly as it decides crm_writes/finance_module/network_publish -- an override to Pro makes this unlimited even on a Starter subscription; an override that lapses reverts to the real plan''s limit with no write (existing custom_field_definitions rows beyond the reverted limit are NOT deleted -- private.custom_field_slot_available()/private.enforce_custom_field_limit() only ever block a NEW insert, the same "downgrade never deletes" behaviour a real tier downgrade already has). Raises (XX000) when an organisation EXISTS but has_subscription is false -- Task A''s invariant, unchanged. Status branches mirror private.crm_write_organisations() (through the same shared function). lib/crm/custom-fields.ts''s customFieldLimit() is the TypeScript half; tests/integration/crm/custom-field-limit-matches-db.test.ts and tests/integration/entitlements/billing-override-matches-db.test.ts bind this deployed function.';

revoke all on function private.custom_field_limit(uuid) from public, anon, authenticated, service_role;
grant execute on function private.custom_field_limit(uuid) to authenticated;


create or replace function private.finance_module_organisations()
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
  join lateral private.effective_organisation_plan(m.organisation_id) e on true
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (
      -- THE ESCAPE, RETAINED VERBATIM (Phase 7 Task A left it in place
      -- deliberately -- see 20260908000000's header). Orthogonal to
      -- overrides: an organisation with no subscription row has nothing to
      -- override, so this disjunct is untouched by this migration.
      not e.has_subscription
      or (e.status_ok and e.finance_module)
    );
$$;

comment on function private.finance_module_organisations() is
  'Subscription entitlement for the FINANCE MODULE. SINCE PHASE 7 TASK 4: routed through private.effective_organisation_plan(), so a billing override naming Pro grants finance_module regardless of the real subscription''s status, and one naming a lower tier denies it exactly as a real downgrade would (existing financial_entries rows are untouched -- view_finance is not entitlement-gated, per Q67). The "no subscription row => not yet gated" escape (Task A) is preserved verbatim as its own disjunct, unrelated to overrides. lib/crm/finance-access.ts''s entitlementsPermitFinance() is the TypeScript mirror.';

revoke all on function private.finance_module_organisations() from public, anon, authenticated, service_role;
grant execute on function private.finance_module_organisations() to authenticated;


create or replace function private.network_publish_organisations()
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
  join lateral private.effective_organisation_plan(m.organisation_id) e on true
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (
      not e.has_subscription
      or (e.status_ok and e.network_publish)
    );
$$;

comment on function private.network_publish_organisations() is
  'Subscription entitlement for NETWORK PUBLISHING. SINCE PHASE 7 TASK 4: routed through private.effective_organisation_plan(), same shape as private.finance_module_organisations() -- an override naming Starter or Pro grants network_publish regardless of the real subscription''s status; one naming Free denies it, exactly as a real downgrade would, with no network_profiles row deleted. The "no subscription row" escape is preserved verbatim, unrelated to overrides. lib/network/access.ts''s entitlementsPermitNetworkPublish() is the TypeScript mirror.';

revoke all on function private.network_publish_organisations() from public, anon, authenticated, service_role;
grant execute on function private.network_publish_organisations() to authenticated;


-- ---------------------------------------------------------------------------
-- 7b. THE AUDIT WRITER -- the SECURITY DEFINER half the four SECURITY
-- INVOKER RPCs below need.
--
-- MEASURED, NOT ASSUMED. private.log_audit_event() is "granted to no client
-- role -- callers are other SECURITY DEFINER functions" (its own comment,
-- 20260826154304). Each RPC below is SECURITY INVOKER on purpose (the same
-- reasoning 20260908030000's header gives for the lifecycle RPCs: the INSERT/
-- UPDATE must run through the RLS policies above, or those policies are dead
-- code beside a definer that bypasses them) -- which means a direct call to
-- log_audit_event() from inside one of them runs AS THE CALLER
-- (`authenticated`), who holds no EXECUTE grant on it. Confirmed by running
-- it: `ERROR: permission denied for function log_audit_event`. This function
-- is the thin, guarded, SECURITY DEFINER bridge -- the exact "thin public
-- entry point, private writer" shape private.log_organisation_lifecycle_
-- event() already uses for the lifecycle RPCs, simplified: there is no
-- cascade here needing a summary of counts, just one audit row per
-- grant/revoke.
-- ---------------------------------------------------------------------------
create or replace function private.log_override_event(
  p_action          text,
  p_target_type     text,
  p_organisation_id uuid,
  p_target_id       uuid,
  p_after           jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not (
    private.has_platform_permission('manage_billing')
    or private.has_platform_permission('manage_feature_overrides')
  ) then
    raise exception 'log_override_event: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_action not in ('organisation.billing_override_granted',
                      'organisation.billing_override_revoked',
                      'organisation.feature_override_granted',
                      'organisation.feature_override_revoked') then
    raise exception 'log_override_event: unknown action %', p_action
      using errcode = '22023';
  end if;

  return private.log_audit_event(
    p_action          => p_action,
    p_target_type     => p_target_type,
    p_organisation_id => p_organisation_id,
    p_target_id       => p_target_id,
    p_after           => p_after
  );
end;
$$;

comment on function private.log_override_event(text, text, uuid, uuid, jsonb) is
  'The SECURITY DEFINER bridge the four override RPCs use to reach private.log_audit_event() (granted to no client role) from their own SECURITY INVOKER bodies -- the same "thin public entry point, private writer" shape private.log_organisation_lifecycle_event() uses for the lifecycle RPCs, without that function''s summary-count logic (there is no cascade here). Guarded on has_platform_permission and restricted to four known actions, which is what makes granting EXECUTE to `authenticated` safe.';

revoke all on function private.log_override_event(text, text, uuid, uuid, jsonb) from public, anon, service_role;
grant execute on function private.log_override_event(text, text, uuid, uuid, jsonb) to authenticated;


-- ---------------------------------------------------------------------------
-- 8. THE FOUR RPCs
-- ---------------------------------------------------------------------------

create or replace function public.grant_billing_override(
  p_organisation_slug text,
  p_override_tier     text,
  p_override_seats    integer,
  p_reason            text,
  p_expires_at        timestamptz
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_id     uuid;
begin
  if not private.has_platform_permission('manage_billing') then
    raise exception 'grant_billing_override: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'grant_billing_override: a reason is required' using errcode = '22023';
  end if;

  if p_override_tier is null and p_override_seats is null then
    raise exception 'grant_billing_override: override at least the tier or the seat count'
      using errcode = '22023';
  end if;

  if p_expires_at is null or p_expires_at <= pg_catalog.now() then
    raise exception 'grant_billing_override: expiry must be a date and time in the future'
      using errcode = '22023';
  end if;

  v_org_id := private.organisation_id_for_slug(p_organisation_slug);
  if v_org_id is null then
    raise exception 'grant_billing_override: no organisation with that slug'
      using errcode = '22023';
  end if;

  perform private.begin_override_transition();

  -- At most one ACTIVE billing override per organisation: a second grant
  -- supersedes the first rather than stacking, so "the effective tier" never
  -- has to choose among several live rows.
  update public.organisation_billing_overrides
  set revoked_at     = pg_catalog.now(),
      revoked_by     = (select auth.uid()),
      revoked_reason = 'Superseded by a new billing override.'
  where organisation_id = v_org_id
    and revoked_at is null
    and expires_at > pg_catalog.now();

  insert into public.organisation_billing_overrides
    (organisation_id, override_tier, override_seats, reason, granted_by, expires_at)
  values
    (v_org_id, p_override_tier, p_override_seats, pg_catalog.btrim(p_reason),
     (select auth.uid()), p_expires_at)
  returning id into v_id;

  perform private.log_override_event(
    p_action          => 'organisation.billing_override_granted',
    p_target_type     => 'organisation_billing_override',
    p_organisation_id => v_org_id,
    p_target_id       => v_id,
    p_after           => pg_catalog.jsonb_build_object(
      'override_tier',  p_override_tier,
      'override_seats', p_override_seats,
      'reason',         pg_catalog.btrim(p_reason),
      'expires_at',     p_expires_at)
  );

  perform private.end_override_transition();
  return v_id;
end;
$$;

comment on function public.grant_billing_override(text, text, integer, text, timestamptz) is
  'Grants (or replaces) a time-boxed billing override on one organisation''s EFFECTIVE tier and/or seat count. Superuser only, at aal2 (has_platform_permission); the application adds step-up re-authentication on top (lib/admin/overrides.ts), CLAUDE.md''s "require step-up re-auth ... any high-risk admin/superuser function". Mandatory reason (22023 if blank), mandatory future expiry (22023 if past or null), and at least one of tier/seats named. SECURITY INVOKER: the INSERT/UPDATE go through the RLS policies above, which are the enforcement. Auto-revert is read-time expiry -- private.active_billing_override() simply stops returning this row once expires_at passes, with nothing scheduled.';

revoke all on function public.grant_billing_override(text, text, integer, text, timestamptz) from public, anon, service_role;
grant execute on function public.grant_billing_override(text, text, integer, text, timestamptz) to authenticated;


create or replace function public.revoke_billing_override(
  p_override_id uuid,
  p_reason      text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if not private.has_platform_permission('manage_billing') then
    raise exception 'revoke_billing_override: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'revoke_billing_override: a reason is required' using errcode = '22023';
  end if;

  perform private.begin_override_transition();

  update public.organisation_billing_overrides
  set revoked_at     = pg_catalog.now(),
      revoked_by     = (select auth.uid()),
      revoked_reason = pg_catalog.btrim(p_reason)
  where id = p_override_id
    and revoked_at is null
  returning organisation_id into v_org_id;

  if v_org_id is null then
    raise exception 'revoke_billing_override: no active override with that id'
      using errcode = '22023';
  end if;

  perform private.log_override_event(
    p_action          => 'organisation.billing_override_revoked',
    p_target_type     => 'organisation_billing_override',
    p_organisation_id => v_org_id,
    p_target_id       => p_override_id,
    p_after           => pg_catalog.jsonb_build_object('reason', pg_catalog.btrim(p_reason))
  );

  perform private.end_override_transition();
  return v_org_id;
end;
$$;

comment on function public.revoke_billing_override(uuid, text) is
  'Ends a billing override BEFORE its natural expiry (e.g. the operator granted it in error, or the underlying issue resolved sooner than expected). Superuser only, mandatory reason, audited. Refuses (22023) an id that does not exist or is already revoked/expired-with-a-revocation -- so a refusal is a refusal rather than a 204 that changed nothing.';

revoke all on function public.revoke_billing_override(uuid, text) from public, anon, service_role;
grant execute on function public.revoke_billing_override(uuid, text) to authenticated;


create or replace function public.grant_feature_override(
  p_organisation_slug text,
  p_flag_key          text,
  p_reason            text,
  p_expires_at        timestamptz
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_id     uuid;
begin
  if not private.has_platform_permission('manage_feature_overrides') then
    raise exception 'grant_feature_override: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'grant_feature_override: a reason is required' using errcode = '22023';
  end if;

  -- Pre-validated here (with a readable message) as well as by the table's
  -- own CHECK constraint (which would otherwise surface as a bare 23514).
  if p_flag_key is null or p_flag_key not in ('early_access_preview') then
    raise exception 'grant_feature_override: unknown flag_key %', p_flag_key
      using errcode = '22023';
  end if;

  if p_expires_at is null or p_expires_at <= pg_catalog.now() then
    raise exception 'grant_feature_override: expiry must be a date and time in the future'
      using errcode = '22023';
  end if;

  v_org_id := private.organisation_id_for_slug(p_organisation_slug);
  if v_org_id is null then
    raise exception 'grant_feature_override: no organisation with that slug'
      using errcode = '22023';
  end if;

  perform private.begin_override_transition();

  -- At most one ACTIVE override per (organisation, flag_key).
  update public.organisation_feature_overrides
  set revoked_at     = pg_catalog.now(),
      revoked_by     = (select auth.uid()),
      revoked_reason = 'Superseded by a new feature override.'
  where organisation_id = v_org_id
    and flag_key = p_flag_key
    and revoked_at is null
    and expires_at > pg_catalog.now();

  insert into public.organisation_feature_overrides
    (organisation_id, flag_key, reason, granted_by, expires_at)
  values
    (v_org_id, p_flag_key, pg_catalog.btrim(p_reason), (select auth.uid()), p_expires_at)
  returning id into v_id;

  perform private.log_override_event(
    p_action          => 'organisation.feature_override_granted',
    p_target_type     => 'organisation_feature_override',
    p_organisation_id => v_org_id,
    p_target_id       => v_id,
    p_after           => pg_catalog.jsonb_build_object(
      'flag_key',   p_flag_key,
      'reason',     pg_catalog.btrim(p_reason),
      'expires_at', p_expires_at)
  );

  perform private.end_override_transition();
  return v_id;
end;
$$;

comment on function public.grant_feature_override(text, text, text, timestamptz) is
  'Grants (or replaces) a time-boxed per-org feature-flag override. Superuser only, at aal2, mandatory reason, mandatory future expiry -- no open-ended overrides (CLAUDE.md § Superuser dashboard). flag_key is checked against the same allowlist as the table''s CHECK constraint before either is reached, for a readable 22023 instead of a bare 23514.';

revoke all on function public.grant_feature_override(text, text, text, timestamptz) from public, anon, service_role;
grant execute on function public.grant_feature_override(text, text, text, timestamptz) to authenticated;


create or replace function public.revoke_feature_override(
  p_override_id uuid,
  p_reason      text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if not private.has_platform_permission('manage_feature_overrides') then
    raise exception 'revoke_feature_override: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'revoke_feature_override: a reason is required' using errcode = '22023';
  end if;

  perform private.begin_override_transition();

  update public.organisation_feature_overrides
  set revoked_at     = pg_catalog.now(),
      revoked_by     = (select auth.uid()),
      revoked_reason = pg_catalog.btrim(p_reason)
  where id = p_override_id
    and revoked_at is null
  returning organisation_id into v_org_id;

  if v_org_id is null then
    raise exception 'revoke_feature_override: no active override with that id'
      using errcode = '22023';
  end if;

  perform private.log_override_event(
    p_action          => 'organisation.feature_override_revoked',
    p_target_type     => 'organisation_feature_override',
    p_organisation_id => v_org_id,
    p_target_id       => p_override_id,
    p_after           => pg_catalog.jsonb_build_object('reason', pg_catalog.btrim(p_reason))
  );

  perform private.end_override_transition();
  return v_org_id;
end;
$$;

comment on function public.revoke_feature_override(uuid, text) is
  'Ends a feature override before its natural expiry. Superuser only, mandatory reason, audited. Refuses (22023) an id that does not exist or is already revoked.';

revoke all on function public.revoke_feature_override(uuid, text) from public, anon, service_role;
grant execute on function public.revoke_feature_override(uuid, text) to authenticated;

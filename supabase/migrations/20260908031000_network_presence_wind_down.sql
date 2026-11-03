-- Phase 7 (Superuser dashboard), Task 3: THE NETWORK HALF of the organisation
-- lifecycle -- how long a wound-down workspace stays in the directory.
--
-- ===========================================================================
-- THE RULING
-- ===========================================================================
-- FOUNDER Q88 (2026-09-07): suspension keeps the organisation's network
-- presence UNTIL THE END OF THE CURRENT SUBSCRIPTION PERIOD.
-- QUEUED DEFAULT Q92 (proceeding, founder may reverse): a fully wound-down
-- organisation -- past the 60-day retention window -- has its published
-- profiles LEAVE THE DIRECTORY.
-- QUEUED DEFAULT Q101 (new, this task): DELETION ends network presence AT
-- ONCE. Q88 is a ruling about suspension, and a workspace the operator has
-- deleted is not a workspace waiting out a billing period it already paid for.
--
-- ===========================================================================
-- WHAT PHASE 6 ACTUALLY MEASURED, AND WHY THIS IS A CHANGE
-- ===========================================================================
-- CLAUDE.md § Architecture records it plainly: "a suspended organisation's
-- published profile stays visible to a counterparty AND to the suspended
-- organisation's own members (Q88, measured in Task 5)". That was measured
-- against soft-delete with no period-end term anywhere -- the profile stayed
-- visible FOREVER, not until period end, because nothing in the directory path
-- consulted a clock. This migration is the clock.
--
-- The own-members half is deliberately NOT changed. Q6 (suspension is
-- read-only, it does not hide a customer's own data) is the older and stronger
-- ruling, and a suspended customer losing sight of their own published profile
-- would be exactly the outcome Q6 exists to prevent. So the new term is
-- disjoined with private.is_active_member(), which has no deleted_at clause:
-- a counterparty stops seeing the profile at period end; its own members never
-- do.
--
-- ===========================================================================
-- WHY THIS IS A READ RULE AND NOT AN "UNPUBLISH" WRITE
-- ===========================================================================
-- Q92's words are "unpublish on wind-down", and the obvious implementation is
-- a batch UPDATE flipping every profile of a wound-down organisation from
-- 'published' to 'draft'. That is rejected, for three reasons:
--
--   1. It is a SILENT DATA CHANGE the customer did not make, to the customer's
--      own rows, at a moment they cannot see it -- against CLAUDE.md
--      § Non-negotiable rules ("never silently delete data" applies to
--      destroying state, not only to rows) and against the reinstatement
--      guarantee this task exists to provide: after a reactivate the customer
--      would find every profile mysteriously unpublished.
--   2. It needs a scheduler nothing in this product has. The 60-day boundary
--      and the period-end boundary are both crossed by the CLOCK, not by an
--      event, so a write-based rule is wrong the moment the job is late; a
--      read-based rule is correct at every instant with nothing running.
--   3. It is the cascade-audit problem from FOLLOW-UPS.md, reintroduced for no
--      gain -- N profile rows, N audit rows, at a moment nobody is watching.
--
-- The read rule delivers exactly what the ruling asks (the profiles leave the
-- directory, at the right instant) and is free to reverse (they come back on
-- reinstatement, because the state does).
--
-- ===========================================================================
-- WHERE THE TERM GOES: THE POLICY, NOT THE VIEW
-- ===========================================================================
-- public.network_directory and public.network_connected_profiles are
-- `security_invoker = true` and their dependency set is asserted from
-- pg_depend by rls_phase6_network.sql § ND (N2) -- joining another table into
-- one of them is the edit that assertion exists to catch. So the rule goes
-- into network_profiles_select_published_directory, the cross-tenant SELECT
-- policy the views read through. The views are untouched, N2 still holds, and
-- there is ONE gate rather than two that can drift, which is the reasoning
-- 20260904004000 already gives for security_invoker in the first place.
--
-- ADDITIVE. `alter policy` is the supported way to change a policy expression.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- THE PREDICATE
--
-- SECURITY DEFINER: it is called from a policy on public.network_profiles and
-- reads public.organisations and public.organisation_subscriptions, neither of
-- which the calling counterparty can read for a foreign tenant. An INVOKER
-- function here would return false for every foreign profile and empty the
-- directory.
--
-- THE SUBSCRIPTION ROW IS ASSUMED TO EXIST, and since Phase 7 Task A
-- (20260908000000) it always does -- public.create_organisation() writes one
-- and the backfill gave one to every organisation that predated it. If one is
-- somehow missing, current_period_end is NULL, both comparisons are NULL, and
-- the answer is FALSE: the profile leaves the directory. That is the
-- fail-closed direction for a cross-tenant read.
--
-- THE BACKFILL CAVEAT, RECORDED WHERE IT IS READ (Task A ledger note M2):
-- for organisations that existed before 20260908000000, current_period_end was
-- backfilled to `migration time + 30 days` -- a placeholder, not a real
-- billing date, because no payment processor is wired yet (CLAUDE.md § Open
-- decisions). So for those organisations THIS FUNCTION'S FIRST TERM IS
-- MEASURING A FICTION, and a suspended one of them loses network presence 30
-- days after that migration rather than at a real period end. It is
-- documented, not a bug, and it stops being fiction the day billing is
-- integrated and current_period_end starts being written by the processor.
-- ---------------------------------------------------------------------------
create or replace function private.organisation_network_presence_active(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organisations o
    left join public.organisation_subscriptions s
      on s.organisation_id = o.id
    where o.id = p_org_id
      and (
        -- Live. The ordinary case, and the only one that is not a clock.
        o.lifecycle_state = 'active'
        -- Suspended: Q88's grace. BOTH clocks must still be running -- the
        -- paid period the ruling names, and the 60-day retention window that
        -- is the outer bound on the whole wind-down (Q92). They are not the
        -- same date: an annual plan suspended just after a renewal has a
        -- period end eleven months out and a retention deadline sixty days
        -- out, and the ruling that the organisation is wound down at sixty
        -- days is the stronger one.
        or (
          o.lifecycle_state = 'suspended'
          and pg_catalog.now() < s.current_period_end
          and pg_catalog.now() < o.retention_expires_at
        )
        -- Deleted: nothing. Q101.
      )
  );
$$;

comment on function private.organisation_network_presence_active(uuid) is
  'Does this organisation still appear in the network directory TO OTHER TENANTS? Founder ruling Q88: a SUSPENDED organisation keeps its network presence until the end of its current subscription period -- and, per queued default Q92, no longer than the 60-day retention window, which for an annual plan can expire first and is the outer bound on the whole wind-down. A DELETED organisation loses presence at once (queued default Q101: Q88 is a ruling about suspension, and a deleted workspace is not waiting out a paid period). An ACTIVE one always has it. SECURITY DEFINER because it is called from a policy on public.network_profiles and reads two tables the foreign counterparty cannot read; a missing subscription row makes both comparisons NULL and the answer FALSE, which is the fail-closed direction for a cross-tenant read. IT DOES NOT AFFECT THE ORGANISATION''S OWN MEMBERS -- the policy disjoins it with private.is_active_member(), because founder decision Q6 (suspension does not hide a customer''s own data) is the older and stronger ruling. CAVEAT: for organisations that predate 20260908000000, current_period_end was backfilled to migration-time + 30 days and is a placeholder, not a billing date.';

revoke all on function private.organisation_network_presence_active(uuid) from public, anon, authenticated, service_role;
grant execute on function private.organisation_network_presence_active(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- THE ONE CROSS-TENANT READ POLICY IN THE SCHEMA, with the clock added.
--
-- The three original terms are unchanged, byte for byte, and the fourth is
-- appended. The two functions are called BARE, not wrapped in `(select ...)`:
-- both are correlated on the row's own organisation_id, so there is no
-- InitPlan for the planner to hoist them into and the wrapper would be
-- misleading decoration (contrast organisations_select_platform_lifecycle in
-- 20260908030000, which IS uncorrelated and IS wrapped).
-- ---------------------------------------------------------------------------
alter policy "network_profiles_select_published_directory"
  on public.network_profiles
  using (
    status = 'published'
    and deleted_at is null
    and exists (select 1 from public.organisation_memberships m
                 where m.user_id = (select auth.uid()) and m.status = 'active')
    and (
      private.organisation_network_presence_active(organisation_id)
      or private.is_active_member(organisation_id)
    )
  );

comment on policy "network_profiles_select_published_directory" on public.network_profiles is
  'THE ONE POLICY IN THIS SCHEMA THAT PERMITS A CROSS-TENANT READ. PERMITS: every active member of every organisation to read this row, when it is published, live, AND the publishing organisation still has network presence. DOES NOT PERMIT: an unauthenticated caller (there is no anon grant on this table -- N6 -- and this policy additionally requires an active membership, so Q70''s "no public, logged-out profiles" has two independent controls); reading a draft or soft-deleted profile of another tenant. SINCE PHASE 7 TASK 3 (20260908031000) IT ALSO CARRIES THE WIND-DOWN CLOCK: private.organisation_network_presence_active() implements founder ruling Q88 (a suspended organisation keeps its presence until its subscription period ends, and no longer than the 60-day retention window) and queued default Q101 (a deleted one loses it at once). That term is DISJOINED with private.is_active_member(), so the publishing organisation''s OWN members never lose sight of their own published profiles however wound down the workspace is -- founder decision Q6, which is older and stronger. AND IT STILL DOES NOT CONSTRAIN WHICH COLUMNS ARE LEGIBLE -- that is public.network_directory''s job, and application code must NEVER select from this table for a foreign organisation.';

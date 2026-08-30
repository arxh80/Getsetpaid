-- Phase 2 (Core CRM), Task 2 fix round 2: implement the past_due grace window
-- the founder already decided, which fix round 1's entitlement gate contradicted.
--
-- ===========================================================================
-- THE CORRECTION, AND HOW IT HAPPENED
-- ===========================================================================
-- 20260828140000 shipped private.crm_write_organisations() with
-- `s.status = 'active' and p.crm_writes`, and its header called the treatment
-- of 'past_due' "the conservative reading" of a question CLAUDE.md does not
-- answer, raising it in DECISIONS-QUEUE as Q7.
--
-- THAT WAS WRONG. The question was not open. lib/entitlements/policy.ts states
-- the decision explicitly:
--
--   "STATUS GATING (founder decision, 2026-08-28): 'active' grants the plan's
--    entitlements outright. 'past_due' keeps them for a 3-DAY GRACE WINDOW,
--    then falls back to Free. 'cancelled' falls back to Free immediately, with
--    no grace at all."
--
-- with the rationale that 'cancelled' is something the customer chose while
-- 'past_due' is something that happened TO them, and "taking a paying
-- customer's features away the same hour their card bounced punishes them for
-- their bank's timing".
--
-- So the application layer granted three days and the database refused them.
-- The database wins -- that is the entire point of pushing entitlement into
-- RLS -- which means the founder's decision was, at the layer that enforces
-- anything, not implemented. This migration implements it.
--
-- Two process notes, because the interesting part is not the SQL:
--   * The decision shipped in PR #2, after Foundation closed and before Phase 2
--     started, so it is in neither the plan nor DECISIONS-QUEUE. That is why it
--     was missed.
--   * It was still missable-with-effort rather than invisible: `grep -ri
--     past_due lib/` finds it in seconds. Writing a new gate over a term that
--     already had a resolver in `lib/` without reading that resolver first is
--     the actual mistake, and it is the same class as fix round 1's IMP-3 --
--     asserting a property instead of checking it.
--
-- ===========================================================================
-- THE CONSTANT LIVES IN TWO LANGUAGES, SO A TEST BINDS THEM
-- ===========================================================================
-- `3` is already `PAST_DUE_GRACE_DAYS` in lib/entitlements/policy.ts. It now
-- also has to exist in SQL, because the database is where the decision is
-- enforced. Two copies of a rule with nothing holding them together is how
-- this gets broken in six months -- which is exactly the problem this project
-- has solved twice already, and the same solution applies a third time:
--
--   permissions      public.has_permission vs private.permitted_organisations
--                    -> rls_phase2_crm.sql § M, a live equality sweep
--   MFA roles        private.role_requires_mfa vs MFA_REQUIRED_ROLES
--                    -> rls_foundation.sql K19/K20
--   tier matrix      subscription_plans rows vs TIER_MATRIX
--                    -> tests/integration/entitlements/tiers-match-db.test.ts
--
-- So the number is extracted into private.past_due_grace_days() rather than
-- inlined into the gate, and
-- tests/integration/entitlements/past-due-grace-matches-db.test.ts reads it out
-- of a live Postgres and compares it to PAST_DUE_GRACE_DAYS -- and then goes
-- further, comparing the two implementations' BOUNDARY DECISIONS across a
-- range of timestamps, because equal constants in unequal comparisons would
-- still be a drift.
--
-- IT IS IN `private`, NOT `public`, and the test reaches it over a direct
-- Postgres connection (tests/integration/rls/support/env.ts already exposes
-- DB_URL, and the RLS fixtures already use `pg`). Publishing a
-- three-returning function as a PostgREST RPC for a test's convenience would
-- be adding API surface to make testing easier, which is the wrong trade.
--
-- ===========================================================================
-- FAIL-CLOSED, AND WHY NO EXTRA CLAUSE IS NEEDED TO GET IT
-- ===========================================================================
-- lib/entitlements/policy.ts's isWithinPastDueGrace() fails closed on an
-- unparseable timestamp: "could not determine" must never be the branch that
-- keeps paid features switched on.
--
-- The SQL side gets the same property from three-valued logic rather than from
-- a guard clause. `now() < NULL + interval '3 days'` is NULL, not true; a NULL
-- conjunct makes the whole WHERE clause not-true; a row whose predicate is
-- not-true is not returned by the set-returning function; and
-- `organisation_id in (select <set without it>)` is false. So an unreadable
-- period end denies.
--
-- `current_period_end` is `NOT NULL` in the schema, so this is unreachable
-- today and the interesting cases are the DERIVED ones -- a period end inside
-- the window versus far in the past. All three are asserted rather than
-- reasoned about (rls_phase2_crm.sql N14/N14b/N14c/N14d), because reasoning
-- about SQL semantics instead of measuring them is a mistake this task has
-- already made twice.

create or replace function private.past_due_grace_days()
returns integer
language sql
immutable
security invoker
set search_path = ''
as $$
  select 3;
$$;

comment on function private.past_due_grace_days() is
  'How many days a past_due subscription keeps its paid entitlements before falling back to Free. Founder decision, 2026-08-28, recorded in lib/entitlements/policy.ts, whose exported PAST_DUE_GRACE_DAYS is the TypeScript half of this same constant. THE TWO ARE BOUND BY A TEST, not by a comment: tests/integration/entitlements/past-due-grace-matches-db.test.ts reads this function out of a live Postgres, compares it to PAST_DUE_GRACE_DAYS, and then compares the two implementations'' boundary decisions across a range of timestamps -- equal constants inside unequal comparisons would still be drift. Change one, change both; the test is what tells you that you did not. Lives in `private` deliberately: publishing an RPC that returns 3 to make a test easier would be adding API surface for the wrong reason.';

revoke all on function private.past_due_grace_days() from public, anon, authenticated, service_role;
grant execute on function private.past_due_grace_days() to authenticated;

-- ---------------------------------------------------------------------------
-- crm_write_organisations() -- REPLACED, now mirroring the app layer's
-- three-way status gate instead of the two-way one it shipped with.
--
-- The escape branch and everything else about this function are unchanged; see
-- 20260828140000's header for why `s.organisation_id is null` is there and why
-- the whole gate is deliberately inert until Phase 7 backfills.
--
-- THE THREE BRANCHES, MATCHING lib/entitlements/policy.ts's
-- resolveEntitlements() clause for clause:
--
--   active                        -> the plan's entitlements outright
--   past_due, inside the window   -> the plan's entitlements, for 3 days from
--                                    current_period_end
--   past_due, window expired      -> Free (no CRM writes)
--   cancelled                     -> Free at once, no grace
--   anything else                 -> Free (the `else` of an allowlist)
--
-- Note the last line: this is an ALLOWLIST of statuses that write, not a
-- denylist of statuses that do not. organisation_subscriptions.status is
-- CHECK-constrained to three values today; if a fourth is ever added, it
-- arrives denied rather than arriving as an accidental grant. Same reasoning
-- as private.audit_crm_payload()'s allowlist in 20260828141000.
--
-- GRACE IS MEASURED FROM current_period_end, WHICH IS A PROXY, and
-- lib/entitlements/policy.ts says so at length: the honest clock starts when
-- the subscription actually entered past_due, and no column records that.
-- In the ordinary case they coincide -- a renewal is attempted at period end
-- and fails, so period end IS when the trouble started -- and where they
-- diverge the proxy is conservative in the customer's favour. WHEN A PAYMENT
-- PROCESSOR IS WIRED (Phase 7), add `past_due_since` or `grace_expires_at` and
-- measure from it, HERE AS WELL AS IN policy.ts. Both halves, one change.
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
  left join public.organisation_subscriptions s
    on s.organisation_id = m.organisation_id
  left join public.subscription_plans p
    on p.key = s.plan_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (
      -- No subscription row => not yet billed => not yet gated. Phase 7
      -- removes this branch in the same migration that backfills the rows.
      s.organisation_id is null
      or (
        p.crm_writes
        and (
          s.status = 'active'
          -- The founder's 3-day grace window. NULL-safe by three-valued logic:
          -- a NULL period end makes this comparison NULL, which is not true,
          -- which denies. See the header.
          or (
            s.status = 'past_due'
            and pg_catalog.now()
                < s.current_period_end
                  + pg_catalog.make_interval(days => private.past_due_grace_days())
          )
        )
      )
    );
$$;

comment on function private.crm_write_organisations() is
  'Subscription entitlement (CLAUDE.md § Permissions, second term): the organisations in which auth.uid() is an active member of a not-soft-deleted organisation AND the organisation''s plan permits CRM writes. Mirrors lib/entitlements/policy.ts''s resolveEntitlements() status gate clause for clause -- ''active'' writes; ''past_due'' writes for private.past_due_grace_days() days measured from current_period_end (founder decision, 2026-08-28); ''cancelled'' and anything else do not. An ALLOWLIST of writing statuses, so a fourth status added later arrives denied. Set-returning so a policy can say `organisation_id in (select ...)` and have it hoisted into one InitPlan per statement. DELIBERATELY INERT TODAY: create_organisation() writes no subscription row, so `s.organisation_id is null` -- "not yet billed, therefore not yet gated" -- matches every existing organisation, and without that branch this gate would deny every CRM write in the product. Phase 7 removes the branch and backfills in one migration; rls_phase2_crm.sql § N is what proves the machinery works while it is inert.';

revoke all on function private.crm_write_organisations() from public, anon, authenticated, service_role;
grant execute on function private.crm_write_organisations() to authenticated;

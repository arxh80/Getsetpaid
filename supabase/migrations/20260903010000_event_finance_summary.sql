-- Phase 5 (Finance), Task 2: public.event_finance_summary.
--
-- A per-event budget-vs-actuals aggregate for the finance panel on the event
-- detail page. Gross / expense computed at QUERY TIME from the live finance
-- lines, per status, so the summary is never a stored column that can drift
-- from the rows it summarises (PRD § 6.8). `net` is NOT a column here: it is
-- `gross - expense`, computed in the app/render from the two columns per
-- status, so there is no fourth aggregate to fall out of step.
--
-- ===========================================================================
-- THE CATEGORY -> SUMMARY MAPPING (stated here, mirrored in a TS unit test:
-- lib/crm/finance-summary.ts + tests/unit/crm/finance-summary.test.ts)
-- ===========================================================================
--   gross   = Σ income                    -- money IN
--   expense = Σ (fee + cost)              -- money OUT: an artist FEE and any
--                                            other COST are both outgoings for
--                                            the promoter.
--   net     = gross - expense             -- computed in the app, per status.
-- A cost and an income are told apart by `category`, never by the sign of
-- `amount_minor` (which is non-negative, financial_entries_amount_minor_check).
--
-- ===========================================================================
-- security_invoker = true IS THE ENTIRE ACCESS CONTROL
-- ===========================================================================
-- The view carries NO policy of its own. `security_invoker` means the base
-- table read below runs under the CALLER'S policies, so a row is in this view
-- exactly when the caller could `select` its financial_entries under
-- `financial_entries_select_view_finance` (20260903003000). A caller WITHOUT
-- view_finance therefore sees NO rows -> the app renders the summary as
-- all-zeros ONLY after it has separately established the caller holds
-- view_finance (hasPermission), and if not, does not render the panel at all
-- (Constraint 12: hide the UI AND the data is RLS-refused). This mirrors
-- public.activity_events (20260829040000) exactly: a security_invoker view
-- that grants nothing and inherits the base table's controls.
--
-- ===========================================================================
-- MULTI-CURRENCY GUARD (MVP)
-- ===========================================================================
-- `currency` is CHECK-pinned to 'GBP' (20260903000000, Q66), so this view does
-- NOT group by currency and the four sums are all in pence of one currency.
-- WHEN the multi-currency migration drops that CHECK, this view MUST add
-- `currency` to the SELECT and the GROUP BY, and the panel must render one
-- summary per currency -- otherwise sums across currencies would be added as
-- if they were one. Recorded so the GBP-only assumption is not silently
-- load-bearing.
--
-- ===========================================================================
-- SCHEMA-INVARIANT ACCOUNTING
-- ===========================================================================
-- This is a VIEW (relkind 'v'), not a table (relkind 'r'), so it is outside
-- every table-shaped invariant in supabase/tests/schema_invariants.sql: D1/D2
-- (the 26-table roster and RLS-on-every-table) and D5 (grant<->policy on those
-- 26) all count `relkind='r'` only, so a new view changes none of their
-- expected numbers. This is the same accounting public.activity_events gets --
-- it is not in schema_invariants either; its grant/security_invoker surface is
-- asserted in the RLS suite (rls_phase2_crm.sql X1-X3), not in the table
-- invariants. No schema_invariants change is owed for this migration.
--
-- ADDITIVE. `create or replace view` is the additive form for a view; the
-- covering aggregate index (financial_entries_event_summary_idx,
-- 20260903000000) already exists for exactly this read.

create or replace view public.event_finance_summary
  with (security_invoker = true) as
select
  fe.organisation_id,
  fe.event_id,
  -- budgeted column
  coalesce(sum(fe.amount_minor) filter (where fe.status = 'budgeted' and fe.category = 'income'), 0)::bigint            as budgeted_gross_minor,
  coalesce(sum(fe.amount_minor) filter (where fe.status = 'budgeted' and fe.category in ('fee', 'cost')), 0)::bigint   as budgeted_expense_minor,
  -- actual column
  coalesce(sum(fe.amount_minor) filter (where fe.status = 'actual' and fe.category = 'income'), 0)::bigint             as actual_gross_minor,
  coalesce(sum(fe.amount_minor) filter (where fe.status = 'actual' and fe.category in ('fee', 'cost')), 0)::bigint    as actual_expense_minor
from public.financial_entries fe
where fe.deleted_at is null
group by fe.organisation_id, fe.event_id;

comment on view public.event_finance_summary is
  'Per-event budget-vs-actuals aggregate for the finance panel (PRD § 6.8). Query-time sums of live financial_entries per status: gross = Σ income, expense = Σ (fee + cost); net = gross - expense is computed in the app, not stored here, so it cannot drift. security_invoker: the base read runs under the caller''s policies, so a row is present exactly when the caller could select its financial_entries under financial_entries_select_view_finance -- a caller without view_finance gets no rows, and the app renders all-zeros only after separately confirming view_finance (else it does not render the panel). GBP-only at MVP: currency is CHECK-pinned, so this does NOT group by currency; the multi-currency migration must add currency to the SELECT and GROUP BY and the panel must render per-currency.';

-- SELECT to authenticated and nothing else, the same empty-ACL surface as
-- public.activity_events: a view is not auto-updatable through an aggregate +
-- GROUP BY, so writes are refused by Postgres itself and not merely ungranted.
grant select on public.event_finance_summary to authenticated;

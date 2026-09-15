-- ===========================================================================
-- PHASE 7 TASK 7 -- NARROW `authenticated`'s UPDATE ON public.incident_alerts
-- TO THE TWO COLUMNS THE RESOLUTION FLOW ACTUALLY WRITES.
-- ===========================================================================
-- DECISIONS-QUEUE Q125, closed here rather than in Phase 8.
--
-- WHAT WAS WRONG, STATED PRECISELY -- it is narrower than Q125's first draft
-- implied, and wider than "nothing".
--
-- `authenticated` held TABLE-level UPDATE on public.incident_alerts. The row
-- policy `incident_alerts_update_platform` gates both USING and WITH CHECK on
-- private.has_platform_permission('view_platform_health'), so NO member's
-- session has ever passed it: this was never member-writable, and the Task 7
-- permission matrix measures that directly, principal by principal, and finds
-- it closed.
--
-- What a table-level grant DID leave open is narrower and slower-acting: any
-- column added to this table by any later migration becomes writable from the
-- single aal2 platform superuser's own browser session THE MOMENT IT EXISTS,
-- with only private.incident_alert_resolution_guard()'s explicit immutable
-- list standing in the way -- a list the author of that future column has to
-- be REMEMBERED into. That already happened once: `account_notified_at`
-- (20260916001000) had to be added to the guard by hand, and the queue entry
-- exists because somebody noticed, not because anything failed.
--
-- WHY THIS IS THE RIGHT SHAPE, AND WHY IT IS A NO-OP TODAY.
--
-- The only client writer of this table is lib/admin/health-actions.ts, which
-- updates exactly `resolved_at` and `resolved_by` (both branches -- resolve
-- stamps them, reopen nulls them) and then selects `id`. A column-level grant
-- over those two therefore changes no behaviour and no test, and it inverts
-- the failure mode for every column this table gains after today: a forgotten
-- column is outside the grant and fails CLOSED with 42501, instead of being
-- inside it and depending on the guard's list having been updated.
--
-- The guard STAYS. This makes it defence in depth rather than the sole gate,
-- which is the whole point -- two independent controls, neither of which is
-- the other's excuse.
--
-- GRANTS, NOT POLICIES, AND THAT IS THE REASON THIS IS WORTH A MIGRATION.
-- `BYPASSRLS` bypasses POLICIES and not GRANTS (Task 5's finding I3 was
-- exactly that confusion), so a policy is the wrong place to look for the
-- last line of defence against a role that does not consult policies. The
-- grant is.
--
-- NOT TOUCHED: `service_role`'s own narrow grants on this table
-- (20260909070000: select, plus update on `notified_at`; 20260916001000 added
-- `account_notified_at`). Those are the email-delivery seam, they are already
-- column-level, and this statement names `authenticated` alone.
-- ===========================================================================

revoke update on public.incident_alerts from authenticated;
grant update (resolved_at, resolved_by) on public.incident_alerts to authenticated;

-- The policy's own comment is where a reader looks for "who may write this
-- table", so it says what the grant now does as well. Re-issued additively --
-- the shipped migration that created it is immutable (the 20260904007000
-- precedent).
comment on policy incident_alerts_update_platform on public.incident_alerts is
  'The ONE client write path into public.incident_alerts: the platform superuser at aal2 (private.has_platform_permission(''view_platform_health'')) flipping an alert''s resolution flag from /super/health. THREE controls, deliberately independent. (1) THE POLICY, here, on both USING and WITH CHECK, so no member''s session matches a row at all. (2) THE GRANT: since 20260919000000 `authenticated` holds UPDATE on `resolved_at` and `resolved_by` ONLY -- not the table -- so a column added by a later migration is outside the grant and fails closed with 42501 rather than becoming writable the moment it exists (DECISIONS-QUEUE Q125). Grants matter separately from policies because BYPASSRLS bypasses policies and not grants. (3) private.incident_alert_resolution_guard(), an AFTER/BEFORE-trigger check that refuses every other column without consulting any policy, and additionally requires resolved_by to be the resolving caller. service_role keeps its own column-level select/update seam for the email delivery stamp (20260909070000, 20260916001000) and is untouched by this. The resolution itself is audited by trigger (incident_alert.resolved / .reopened, 20260909080000), so a raw PATCH is covered too.';

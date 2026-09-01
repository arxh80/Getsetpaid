-- Phase 5 (Finance), Task 1d: the three RLS policies on
-- public.financial_entries.
--
-- 20260903000000 shipped the table with `enable row level security` and ZERO
-- policies (the safe order, "RLS on before access") and opened a named
-- interval: schema_invariants.sql D4, D5 and D11b have been red since. THIS
-- FILE CLOSES IT. Those assertions already carry the post-Task-1d numbers
-- (D4 `0`, D5 `0`, D11b `41`); a reviewer checks they went GREEN.
--
-- ADDITIVE. `create policy`, never `alter` -- there is nothing to alter, these
-- three are new. `create or replace policy` does not exist in PostgreSQL
-- (42601 on the pinned 17.6).
--
-- THREE POLICIES, NOT FOUR. SELECT, INSERT, UPDATE. No DELETE policy because
-- there is no DELETE grant -- soft delete is an UPDATE of `deleted_at`, restore
-- is the same UPDATE in reverse, and SELECT must keep reaching soft-deleted
-- rows so the deleted/restore views load. D5 asserts the grant/policy
-- biconditional both ways, so a DELETE policy with no grant is as red as the
-- reverse.
--
-- ===========================================================================
-- THREE INDEPENDENT SERVER-SIDE GATES, ONE PER TERM
-- ===========================================================================
-- Finance is the most restricted write surface in the product. A finance write
-- is refused unless ALL of:
--
--   ROLE    manage_finance -> private.permitted_organisations('manage_finance')
--   TIER    finance_module -> private.finance_module_organisations()  (Pro)
--   MFA     aal2           -> folded INTO permitted_organisations, because
--                            role_requires_mfa('finance') is true, so the key
--                            is simply not held below aal2. No separate term.
--
-- The set form only (Constraint 2), never public.has_permission( -- the
-- subquery has no row correlation, so the planner hoists it to one InitPlan per
-- statement. Task 4's structural guard asserts the three write policies name
-- `finance_module_organisations` and `permitted_organisations('manage_finance')`
-- and NOT `has_permission(`.
--
-- ===========================================================================
-- WHERE EACH GATE GOES, AND WHY
-- ===========================================================================
-- Following 20260828140500 (which fixed the placement on all 25 existing CRM
-- write policies) and 20260901011000 (events):
--
--   SELECT   view_finance only. NO finance_module term -- reads survive a
--            Pro->Starter downgrade read-only (Q67: a downgrade must never
--            hide a customer's existing data). NO deleted_at term -- the
--            application filters; the deleted/restore views and single loaders
--            read soft-deleted rows. NO record-scope disjunction -- no role
--            holding view_finance is record-scoped, and there is no
--            owner_user_id to scope on.
--   INSERT   manage_finance + finance_module, both in WITH CHECK (the only
--            clause an INSERT has). finance_module in WITH CHECK so a
--            Starter-tier refusal is a loud 42501, not a silent 0-row accept.
--            Plus an inline `exists` that the parent event is LIVE and
--            same-tenant.
--   UPDATE   manage_finance in USING; WITH CHECK adds finance_module, the
--            live-parent `exists`, and entity_org_unchanged('financial_entry',
--            ...). The tier term is in WITH CHECK ONLY, deliberately NOT USING:
--            in USING a Starter-tier refusal would become PostgREST's 204 No
--            Content, indistinguishable from success. Soft-delete and restore
--            are both this UPDATE.
--
-- ===========================================================================
-- THE LIVE-PARENT `exists` IS INLINE, AND READS public.events AS THE CALLER
-- ===========================================================================
-- A finance line may not be added to or moved onto a SOFT-DELETED or
-- cross-tenant event. The subquery is written out in the policy (not hidden
-- behind a helper, which would be a per-row SubPlan -- 20260828121000 measured
-- 12830ms -> 19.6ms for the inline form) and reads public.events under the
-- caller's own events_select_view_crm policy, which finance/owner/admin hold
-- (they all hold view_crm). `e.organisation_id = financial_entries.organisation_id`
-- is the tenant-correlation term schema_invariants D11 asserts structurally --
-- it and financial_entries_event_fkey are each other's only backstop.
--
-- NO event-side manage_events check: writing a finance LINE is a finance act,
-- gated by manage_finance, not by whether the caller may edit the event. The
-- parent check is only "live and same-tenant", read through view_crm.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SELECT -- view_finance
-- ---------------------------------------------------------------------------
create policy "financial_entries_select_view_finance"
  on public.financial_entries for select to authenticated
  using ( organisation_id in (select private.permitted_organisations('view_finance')) );

comment on policy "financial_entries_select_view_finance" on public.financial_entries is
  'PERMITS: reading financial entries of an organisation the caller holds view_finance in (owner, admin, finance). DOES NOT PERMIT: reading another tenant''s finance under any role; reading at all for a role without view_finance (a Booker, Marketing, Read Only -- Task 4''s Booker-cannot-read test); reading below aal2 for owner/admin/finance, whose keys are MFA-gated (20260827210000) -- the read gate closes for them with no separate term here. DELIBERATELY DOES NOT HIDE SOFT-DELETED ROWS (no deleted_at term): the restore path and the deleted view both read them; the application filters. NOT entitlement-gated (no finance_module term): reads survive a Pro->Starter downgrade read-only (Q67), so a downgraded org keeps seeing its finance history.';

-- ---------------------------------------------------------------------------
-- INSERT -- manage_finance + finance_module + live same-tenant parent
-- ---------------------------------------------------------------------------
create policy "financial_entries_insert_manage_finance"
  on public.financial_entries for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_finance'))
    and organisation_id in (select private.finance_module_organisations())
    and exists (
      select 1 from public.events e
      where e.id = financial_entries.event_id
        and e.organisation_id = financial_entries.organisation_id
        and e.deleted_at is null
    )
  );

comment on policy "financial_entries_insert_manage_finance" on public.financial_entries is
  'PERMITS: adding a finance line to a LIVE, same-tenant event, when the caller holds manage_finance (owner/admin/finance) at aal2 AND the plan has finance_module (Pro). Three independent gates. DOES NOT PERMIT: a Starter-tier org (42501 from the finance_module term, a loud refusal not a silent 0); a role without manage_finance; a caller below aal2 (the key is MFA-gated, so not held); a line on a soft-deleted event (`e.deleted_at is null`); a line filed against another tenant''s event (42501 here, and 23503 from financial_entries_event_fkey for any writer RLS does not apply to). The finance_module term is INERT today (20260903001000): finance_module_organisations() exempts organisations with no subscription row, which is every organisation.';

-- ---------------------------------------------------------------------------
-- UPDATE -- manage_finance (USING); WITH CHECK adds tier, live parent, org-pin
-- ---------------------------------------------------------------------------
create policy "financial_entries_update_manage_finance"
  on public.financial_entries for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_finance'))
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_finance'))
    and organisation_id in (select private.finance_module_organisations())
    and private.entity_org_unchanged('financial_entry', id, organisation_id)
    and exists (
      select 1 from public.events e
      where e.id = financial_entries.event_id
        and e.organisation_id = financial_entries.organisation_id
        and e.deleted_at is null
    )
  );

comment on policy "financial_entries_update_manage_finance" on public.financial_entries is
  'PERMITS: editing, soft-deleting (deleted_at := now()) and restoring (deleted_at := null) a finance line the caller may write -- all three are UPDATEs; there is no DELETE policy or grant. Requires manage_finance (USING and WITH CHECK) at aal2, finance_module (WITH CHECK, the Pro gate), and a live same-tenant parent event. DOES NOT PERMIT: any of it on a Starter-tier org -- the finance_module term is in WITH CHECK ONLY, deliberately, so a downgrade refusal is a 42501 rather than PostgREST''s 204 No Content (which is indistinguishable from success); moving the line to another organisation, which private.entity_org_unchanged(''financial_entry'', ...) refuses by comparing the NEW organisation_id against the statement-start snapshot -- the tenant-to-tenant transfer a two-org admin could otherwise do in one statement, and the ONLY thing pinning it since financial_entries has no owner column; editing a line whose parent event has been soft-deleted (`e.deleted_at is null`). The finance_module term is INERT today (20260903001000).';

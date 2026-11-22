-- ===========================================================================
-- A WORKSPACE WITH NO SUBSCRIPTION ROW GETS FREE'S ENTITLEMENTS, IN SQL AS IN
-- TYPESCRIPT. Three gates still carried Phase 7 Task A's "not yet billed =>
-- not yet gated" escape (`not e.has_subscription or ...`), so a row-less
-- workspace had the finance module, network publishing and card payments in
-- the database while lib/entitlements/policy.ts's resolveEntitlements() gave
-- it Free. create_organisation() has written a row at birth since Task A and
-- no client role can delete one, so the escape only ever opened for a
-- hand-repaired row: it now fails closed, like crm_write_organisations().
-- The TypeScript gates that mirrored the escape (lib/crm/finance-access.ts,
-- lib/network/access.ts) drop it in the same change. Each body is rebuilt from its live definition (20260909000000,
-- 20261110002000); the only change is the escape's removal.
-- ===========================================================================

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
    and e.status_ok and e.finance_module;
$$;
comment on function private.finance_module_organisations() is
  'Subscription entitlement for the FINANCE MODULE: the organisations in which auth.uid() is an active member of a not-soft-deleted organisation whose effective plan (private.effective_organisation_plan(), so an active billing override applies) has finance_module with status_ok. No subscription row means no entitlement (20261120000000 removed the "not yet billed" escape), as lib/crm/finance-access.ts''s entitlementsPermitFinance() now reads it too.';
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
    and e.status_ok and e.network_publish;
$$;
comment on function private.network_publish_organisations() is
  'Subscription entitlement for NETWORK PUBLISHING, same shape as private.finance_module_organisations(): the effective plan''s network_publish with status_ok. No subscription row means no entitlement (20261120000000), as lib/network/access.ts''s entitlementsPermitNetworkPublish() now reads it too.';
revoke all on function private.network_publish_organisations() from public, anon, authenticated, service_role;
grant execute on function private.network_publish_organisations() to authenticated;

create or replace function private.invoice_is_payable_online(p_inv public.invoices)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- The live account id when the invoice can be paid by card now, else null.
  select a.stripe_account_id
    from public.invoice_stripe_accounts a
   where p_inv.status = 'issued'
     and p_inv.gross_minor > 0
     and a.organisation_id = p_inv.organisation_id
     and a.ended_at is null and a.charges_enabled
     and exists (select 1
                   from public.organisations o
                  cross join lateral private.effective_organisation_plan(o.id) e
                  where o.id = p_inv.organisation_id and o.deleted_at is null
                    and e.status_ok and e.finance_module)
$$;
comment on function private.invoice_is_payable_online(public.invoices) is
  'The live Stripe account id when this invoice can be paid by card now (issued, a total to charge, the workspace''s link live with charges enabled, the workspace open and its effective plan carrying the finance module with status_ok; no subscription row means no), else null. Reads the invoice''s own workspace through private.effective_organisation_plan(), not the per-caller private.finance_module_organisations(), because nobody is signed in on the pay page. The single gate behind invoice_pay_page and begin_invoice_card_payment.';
revoke all on function private.invoice_is_payable_online(public.invoices) from public, anon, authenticated, service_role;

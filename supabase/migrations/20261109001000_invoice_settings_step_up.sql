-- ===========================================================================
-- Invoice settings are stepped up IN THE DATABASE (Invoices part 1 x Phase 10
-- Task 6, G13).
--
-- Saving the settings can redirect where a customer pays (the bank details), so
-- it is a gated write like the others: public.save_invoice_settings() consumes
-- a single-use, five-minute `invoice_settings` token that only the app's server
-- can mint (public.mint_step_up_token(), after a passed checkStepUp()). Until
-- now the step-up was app-side only, so a direct PostgREST call skipped it.
--
-- Two changes: the closed purpose list gains `invoice_settings`, and the one
-- function is rebuilt from its live definition (20261107004000) plus the one
-- consume line. CREATE OR REPLACE keeps its grants and comment.
-- ===========================================================================

alter table private.step_up_tokens drop constraint step_up_tokens_purpose_known;
alter table private.step_up_tokens add constraint step_up_tokens_purpose_known check (purpose in (
  'organisation_lifecycle', 'closure_decision', 'workspace_close',
  'override', 'impersonation', 'retention_settings', 'legal_document',
  'dsr_rejection', 'account_erasure', 'workspace_export', 'invoice_settings'));

create or replace function public.save_invoice_settings(
  p_org                 uuid,
  p_business_name       text,
  p_business_address    text,
  p_vat_number          text,
  p_bank_account_name   text,
  p_bank_sort_code      text,
  p_bank_account_number text,
  p_number_prefix       text,
  p_payment_terms_days  integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_old     public.invoice_settings;
  v_new     public.invoice_settings;
  v_changed text[];
  v_bank    text[];
begin
  if v_uid is null then
    raise exception 'save_invoice_settings: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  if p_org is null or not public.has_permission(p_org, 'manage_finance') then
    raise exception 'save_invoice_settings: the caller may not manage finance in this workspace'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = p_org) then
    raise exception 'save_invoice_settings: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;

  -- After the permission and plan refusals, so a refused caller never spends a
  -- token; before the write, so a saved change always had a fresh step-up.
  perform private.consume_step_up('invoice_settings');

  select * into v_old from public.invoice_settings s where s.organisation_id = p_org for update;

  begin
    insert into public.invoice_settings (organisation_id, business_name, business_address, vat_number,
                                         bank_account_name, bank_sort_code, bank_account_number,
                                         number_prefix, payment_terms_days)
    values (p_org, p_business_name, p_business_address, p_vat_number,
            p_bank_account_name, p_bank_sort_code, p_bank_account_number,
            p_number_prefix, p_payment_terms_days)
    on conflict (organisation_id) do update
      set business_name       = excluded.business_name,
          business_address    = excluded.business_address,
          vat_number          = excluded.vat_number,
          bank_account_name   = excluded.bank_account_name,
          bank_sort_code      = excluded.bank_sort_code,
          bank_account_number = excluded.bank_account_number,
          number_prefix       = excluded.number_prefix,
          payment_terms_days  = excluded.payment_terms_days
    returning * into v_new;
  exception when check_violation or not_null_violation then
    raise exception 'save_invoice_settings: a setting is invalid'
      using errcode = '22023', hint = 'invoice_settings_invalid';
  end;

  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
    from pg_catalog.unnest(array['bank_account_name', 'bank_account_number', 'bank_sort_code',
                                 'business_address', 'business_name', 'number_prefix',
                                 'payment_terms_days', 'vat_number']) k
   where (pg_catalog.to_jsonb(v_new) -> k) is distinct from (pg_catalog.to_jsonb(v_old) -> k);
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_bank
    from pg_catalog.unnest(v_changed) k
   where k in ('bank_account_name', 'bank_account_number', 'bank_sort_code');

  -- Column NAMES only, never values, in both rows.
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.log_audit_event(
      p_action          => 'invoice_settings.changed',
      p_target_type     => 'invoice_settings',
      p_organisation_id => p_org,
      p_target_id       => p_org,
      p_after           => pg_catalog.jsonb_build_object('changed', pg_catalog.to_jsonb(v_changed)));
  end if;
  if pg_catalog.cardinality(v_bank) > 0 then
    perform private.log_audit_event(
      p_action          => 'invoice_settings.bank_details_changed',
      p_target_type     => 'invoice_settings',
      p_organisation_id => p_org,
      p_target_id       => p_org,
      p_after           => pg_catalog.jsonb_build_object('changed', pg_catalog.to_jsonb(v_bank)));
  end if;
  return pg_catalog.cardinality(v_bank) > 0;
end;
$$;

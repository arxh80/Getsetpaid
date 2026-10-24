-- ===========================================================================
-- INVOICES PART 1 -- TASK 5: ISSUE.
-- public.issue_invoice(): in ONE transaction, lock the draft, re-check
-- membership, manage_finance and the Pro entitlement, refuse an incomplete
-- draft or incomplete settings, lock the settings row FOR UPDATE, refuse a
-- pulled finance entry already on a live invoice (Q255 default (a)),
-- recompute every line under the seller's current VAT status, take
-- next_number, write number / dates / totals / snapshot, flip to issued,
-- audit {status, number} (name-only: no amount, CLAUDE.md § Non-negotiable
-- rules). Two concurrent issues in one workspace serialise on the settings
-- row and get consecutive numbers (invoice_issue_concurrency_probe.sh); a
-- rolled-back issue consumes no number (rls_invoices.sql IS10-IS12).
-- ===========================================================================

create or replace function public.issue_invoice(p_invoice_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_inv    public.invoices;
  v_set    public.invoice_settings;
  v_number text;
  v_issue  date;
  v_supply date;
  v_due    date;
begin
  if v_uid is null then
    raise exception 'issue_invoice: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;

  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  -- One refusal for "not yours" and "not there": no existence oracle.
  if not found or not public.has_permission(v_inv.organisation_id, 'manage_finance') then
    raise exception 'issue_invoice: the caller may not issue this invoice'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = v_inv.organisation_id) then
    raise exception 'issue_invoice: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;
  if v_inv.status <> 'draft' or v_inv.deleted_at is not null then
    raise exception 'issue_invoice: only a live draft can be issued'
      using errcode = '22023', hint = 'invoice_not_a_draft';
  end if;
  if pg_catalog.num_nonnulls(v_inv.recipient_company_id, v_inv.recipient_contact_id) <> 1 then
    raise exception 'issue_invoice: choose a recipient first'
      using errcode = '22023', hint = 'invoice_needs_a_recipient';
  end if;
  -- Q251 (plan decision 7): a recipient deleted after drafting refuses the
  -- issue; the draft stays live and editable.
  if (v_inv.recipient_company_id is not null
      and not exists (select 1 from public.companies c
                       where c.id = v_inv.recipient_company_id
                         and c.organisation_id = v_inv.organisation_id and c.deleted_at is null))
     or (v_inv.recipient_contact_id is not null
      and not exists (select 1 from public.contacts c
                       where c.id = v_inv.recipient_contact_id
                         and c.organisation_id = v_inv.organisation_id and c.deleted_at is null)) then
    raise exception 'issue_invoice: the recipient has been deleted'
      using errcode = '22023', hint = 'invoice_recipient_deleted';
  end if;
  if v_inv.recipient_address is null or pg_catalog.btrim(v_inv.recipient_address) = '' then
    raise exception 'issue_invoice: a VAT invoice shows the recipient''s address'
      using errcode = '22023', hint = 'invoice_needs_recipient_address';
  end if;
  if not exists (select 1 from public.invoice_lines l where l.invoice_id = p_invoice_id) then
    raise exception 'issue_invoice: an invoice needs at least one line'
      using errcode = '22023', hint = 'invoice_has_no_lines';
  end if;

  select * into v_set from public.invoice_settings s
   where s.organisation_id = v_inv.organisation_id for update;
  if not found or v_set.business_name is null or v_set.business_address is null then
    raise exception 'issue_invoice: the workspace''s invoice settings are incomplete'
      using errcode = '22023', hint = 'invoice_settings_incomplete';
  end if;

  -- Q255 default (a): an entry billed on a live (issued or paid) invoice is not
  -- billed again; a void one frees it. AFTER the settings lock, so a second
  -- issue that waited on it reads the first one's commit (READ COMMITTED takes
  -- a fresh snapshot per statement).
  if exists (select 1
               from public.invoice_lines l
               join public.invoice_lines o
                 on o.financial_entry_id = l.financial_entry_id and o.invoice_id <> l.invoice_id
               join public.invoices oi on oi.id = o.invoice_id
              where l.invoice_id = p_invoice_id
                and oi.status in ('issued', 'paid') and oi.deleted_at is null) then
    raise exception 'issue_invoice: a finance entry on this draft is already on a live invoice'
      using errcode = '22023', hint = 'invoice_entry_already_invoiced';
  end if;

  -- Recompute under the seller's CURRENT VAT status (still a draft, so the
  -- line freeze admits it).
  update public.invoice_lines l
     set vat_rate = case when v_set.vat_number is null then 'none' else l.vat_rate end,
         (net_minor, vat_minor) = (
           select a.net_minor, a.vat_minor
             from private.invoice_line_amounts(
                    l.quantity, l.unit_price_minor,
                    case when v_set.vat_number is null then 'none' else l.vat_rate end) a)
   where l.invoice_id = p_invoice_id;

  v_number := private.format_invoice_number(v_set.number_prefix, v_set.next_number);
  update public.invoice_settings s set next_number = s.next_number + 1
   where s.organisation_id = v_inv.organisation_id;

  v_issue  := (pg_catalog.now() at time zone 'Europe/London')::date;
  v_supply := coalesce(v_inv.supply_date, v_issue);
  v_due    := v_issue + v_set.payment_terms_days;

  begin
    update public.invoices i
       set status = 'issued',
           number = v_number,
           issue_date = v_issue,
           supply_date = v_supply,
           due_date = v_due,
           (net_minor, vat_minor, gross_minor) = (
             select coalesce(sum(l.net_minor), 0), coalesce(sum(l.vat_minor), 0),
                    coalesce(sum(l.net_minor + l.vat_minor), 0)
               from public.invoice_lines l where l.invoice_id = i.id),
           snapshot = private.build_invoice_snapshot(i.id, v_number, v_issue, v_supply, v_due)
     where i.id = p_invoice_id;
  exception when unique_violation then
    raise exception 'issue_invoice: % is already used in this workspace', v_number
      using errcode = '23505', hint = 'invoice_number_taken';
  end;

  perform private.log_audit_event(
    p_action          => 'invoice.issued',
    p_target_type     => 'invoice',
    p_organisation_id => v_inv.organisation_id,
    p_target_id       => p_invoice_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'draft'),
    p_after           => pg_catalog.jsonb_build_object('status', 'issued', 'number', v_number));
  return v_number;
end;
$$;

comment on function public.issue_invoice(uuid) is
  'Issues a live draft: re-checks manage_finance and the Pro entitlement, refuses an incomplete draft or incomplete settings, locks invoice_settings FOR UPDATE, refuses a pulled finance entry already on a live issued/paid invoice (Q255), recomputes the lines under the seller''s current VAT status, takes next_number (consecutive under concurrency; a rollback consumes none), sets the UK-local issue date, supply date and due date, writes the snapshot, flips to issued and audits invoice.issued as {status, number}. Returns the number.';

revoke all on function public.issue_invoice(uuid) from public, anon, authenticated, service_role;
grant execute on function public.issue_invoice(uuid) to authenticated;

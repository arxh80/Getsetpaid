-- ===========================================================================
-- INVOICES PART 1 -- TASK 4: DRAFTS.
-- public.save_invoice_draft() creates or replaces a draft and its lines in
-- one transaction, with the line amounts computed by
-- private.invoice_line_amounts() (the one source of the numbers);
-- public.delete_invoice_draft() soft-deletes one. Both SECURITY DEFINER (no
-- client role can write the tables), both re-check, in this order, a session,
-- manage_finance (which folds in aal2 and suspension), and the Pro
-- entitlement. Not audited: drafts are working copies (plan decision 10).
-- A workspace that is not VAT registered gets every line as 'none'.
-- ===========================================================================

create or replace function public.save_invoice_draft(
  p_org                  uuid,
  p_invoice_id           uuid,
  p_recipient_company_id uuid,
  p_recipient_contact_id uuid,
  p_event_id             uuid,
  p_recipient_address    text,
  p_supply_date          date,
  p_notes                text,
  p_lines                jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid := p_invoice_id;
  v_vat text;
  v_bad integer;
begin
  if v_uid is null then
    raise exception 'save_invoice_draft: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  if p_org is null or not public.has_permission(p_org, 'manage_finance') then
    raise exception 'save_invoice_draft: the caller may not manage finance in this workspace'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = p_org) then
    raise exception 'save_invoice_draft: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;

  if p_lines is null or pg_catalog.jsonb_typeof(p_lines) <> 'array'
     or pg_catalog.jsonb_array_length(p_lines) > 100 then
    raise exception 'save_invoice_draft: lines must be an array of at most 100'
      using errcode = '22023', hint = 'invoice_lines_invalid';
  end if;
  -- Quantity text is checked by shape, never silently rounded by the cast.
  select pg_catalog.count(*) into v_bad
    from pg_catalog.jsonb_array_elements(p_lines) e
   where pg_catalog.jsonb_typeof(e) <> 'object'
      or coalesce(e ->> 'quantity', '') !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$';
  if v_bad > 0 then
    raise exception 'save_invoice_draft: a line is invalid'
      using errcode = '22023', hint = 'invoice_line_invalid';
  end if;

  if p_recipient_company_id is not null and p_recipient_contact_id is not null then
    raise exception 'save_invoice_draft: an invoice has one recipient'
      using errcode = '22023', hint = 'invoice_one_recipient';
  end if;
  if (p_recipient_company_id is not null
      and not exists (select 1 from public.companies c
                       where c.id = p_recipient_company_id and c.organisation_id = p_org
                         and c.deleted_at is null))
     or (p_recipient_contact_id is not null
      and not exists (select 1 from public.contacts c
                       where c.id = p_recipient_contact_id and c.organisation_id = p_org
                         and c.deleted_at is null)) then
    raise exception 'save_invoice_draft: the recipient is not a live record of this workspace'
      using errcode = '22023', hint = 'invoice_recipient_not_live';
  end if;
  if p_event_id is not null
     and not exists (select 1 from public.events e
                      where e.id = p_event_id and e.organisation_id = p_org and e.deleted_at is null) then
    raise exception 'save_invoice_draft: the event is not a live event of this workspace'
      using errcode = '22023', hint = 'invoice_event_not_live';
  end if;
  -- A pulled line names a live INCOME entry of this workspace, on this
  -- invoice's event (so a draft with no event cannot pull a line).
  select pg_catalog.count(*) into v_bad
    from pg_catalog.jsonb_array_elements(p_lines) e
   where e ->> 'financial_entry_id' is not null
     and not exists (
       select 1 from public.financial_entries fe
        where fe.id = (e ->> 'financial_entry_id')::uuid
          and fe.organisation_id = p_org
          and fe.deleted_at is null
          and fe.category = 'income'
          and fe.event_id is not distinct from p_event_id);
  if v_bad > 0 then
    raise exception 'save_invoice_draft: a pulled line no longer names an invoiceable income entry'
      using errcode = '22023', hint = 'invoice_entry_not_invoiceable';
  end if;

  select s.vat_number into v_vat from public.invoice_settings s where s.organisation_id = p_org;

  if v_id is null then
    insert into public.invoices (organisation_id, recipient_company_id, recipient_contact_id, event_id,
                                 recipient_address, supply_date, notes, created_by)
    values (p_org, p_recipient_company_id, p_recipient_contact_id, p_event_id,
            p_recipient_address, p_supply_date, p_notes, v_uid)
    returning id into v_id;
  else
    update public.invoices i
       set recipient_company_id = p_recipient_company_id,
           recipient_contact_id = p_recipient_contact_id,
           event_id = p_event_id,
           recipient_address = p_recipient_address,
           supply_date = p_supply_date,
           notes = p_notes
     where i.id = v_id and i.organisation_id = p_org and i.status = 'draft' and i.deleted_at is null;
    if not found then
      raise exception 'save_invoice_draft: that is not an editable draft of this workspace'
        using errcode = '22023', hint = 'invoice_not_an_editable_draft';
    end if;
    delete from public.invoice_lines l where l.invoice_id = v_id;
  end if;

  begin
    insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity,
                                      unit_price_minor, vat_rate, net_minor, vat_minor, financial_entry_id)
    select p_org, v_id, e.ord::integer, e.line ->> 'description', (e.line ->> 'quantity')::numeric(12,2),
           (e.line ->> 'unit_price_minor')::bigint,
           case when v_vat is null then 'none' else e.line ->> 'vat_rate' end,
           a.net_minor, a.vat_minor, (e.line ->> 'financial_entry_id')::uuid
      from pg_catalog.jsonb_array_elements(p_lines) with ordinality as e(line, ord)
     cross join lateral private.invoice_line_amounts(
       (e.line ->> 'quantity')::numeric(12,2),
       (e.line ->> 'unit_price_minor')::bigint,
       case when v_vat is null then 'none' else e.line ->> 'vat_rate' end) a;
  exception when check_violation or not_null_violation or invalid_text_representation
                 or numeric_value_out_of_range then
    raise exception 'save_invoice_draft: a line is invalid'
      using errcode = '22023', hint = 'invoice_line_invalid';
  end;

  update public.invoices i
     set (net_minor, vat_minor, gross_minor) =
         (select coalesce(sum(l.net_minor), 0), coalesce(sum(l.vat_minor), 0),
                 coalesce(sum(l.net_minor + l.vat_minor), 0)
            from public.invoice_lines l where l.invoice_id = v_id)
   where i.id = v_id;

  return v_id;
end;
$$;

comment on function public.save_invoice_draft(uuid, uuid, uuid, uuid, uuid, text, date, text, jsonb) is
  'Creates (p_invoice_id null) or replaces a DRAFT invoice and all its lines in one transaction, computing every amount with private.invoice_line_amounts(). Requires a session, manage_finance (aal2, not suspended) and the Pro entitlement. A recipient, event and pulled finance entry must be live records of p_org; a pulled entry must be income on the invoice''s event. An unregistered seller''s lines are stored as vat_rate none. Refuses with the hints listed in 20261107001000.';

revoke all on function public.save_invoice_draft(uuid, uuid, uuid, uuid, uuid, text, date, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_invoice_draft(uuid, uuid, uuid, uuid, uuid, text, date, text, jsonb)
  to authenticated;

create or replace function public.delete_invoice_draft(p_invoice_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'delete_invoice_draft: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select i.organisation_id into v_org from public.invoices i where i.id = p_invoice_id;
  -- One refusal for "not yours" and "not there": no existence oracle.
  if v_org is null or not public.has_permission(v_org, 'manage_finance') then
    raise exception 'delete_invoice_draft: the caller may not manage finance in this workspace'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = v_org) then
    raise exception 'delete_invoice_draft: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;
  update public.invoices i set deleted_at = pg_catalog.now()
   where i.id = p_invoice_id and i.status = 'draft' and i.deleted_at is null;
  if not found then
    raise exception 'delete_invoice_draft: that is not an editable draft'
      using errcode = '22023', hint = 'invoice_not_an_editable_draft';
  end if;
end;
$$;

comment on function public.delete_invoice_draft(uuid) is
  'Soft-deletes a live DRAFT invoice. Requires a session, manage_finance and the Pro entitlement in the invoice''s own workspace. An issued invoice is voided, never deleted.';

revoke all on function public.delete_invoice_draft(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_invoice_draft(uuid) to authenticated;

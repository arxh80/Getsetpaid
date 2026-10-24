-- ===========================================================================
-- INVOICES PART 1 -- TASK 6: MARK PAID, VOID, AND THE FINANCE LINK.
-- Income is recorded NET of VAT: VAT collected is owed to HMRC, not income.
-- "The remaining lines" are those with no financial_entry_id (plan decision
-- 5), so a pulled line whose entry is already actual is never booked twice.
-- An invoice whose event is soft-deleted is marked paid without touching
-- finance (plan decision 6). Void keeps the number and reverses exactly what
-- mark-paid recorded (invoice_lines.entry_flipped, invoices.paid_entry_id).
-- Mark-paid flips only an entry that is still live budgeted income on the
-- invoice's event (Q257); its amount is kept, not reset to the line's (Q258).
-- All three RPCs that lock pulled entries do it in id order (no deadlock).
-- Audit payloads are name-only (CLAUDE.md § Non-negotiable rules): status,
-- number and measured counts, never paid_on, an amount or the void reason.
-- The erasure re-point of paid_by / voided_by is private.erase_account()'s
-- derived walk; private.invoices_freeze() admits no other target
-- (rls_invoices.sql § IE).
-- ===========================================================================

create or replace function public.mark_invoice_paid(p_invoice_id uuid, p_paid_on date)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_inv     public.invoices;
  v_live    boolean := false;
  v_flipped uuid[] := '{}';
  v_rest    bigint := 0;
  v_entry   uuid;
  v_today   date := (pg_catalog.now() at time zone 'Europe/London')::date;
begin
  if v_uid is null then
    raise exception 'mark_invoice_paid: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  -- One refusal for "not yours" and "not there": no existence oracle.
  if not found or not public.has_permission(v_inv.organisation_id, 'manage_finance') then
    raise exception 'mark_invoice_paid: the caller may not change this invoice'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = v_inv.organisation_id) then
    raise exception 'mark_invoice_paid: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;
  if v_inv.status <> 'issued' then
    raise exception 'mark_invoice_paid: only an issued invoice can be marked paid'
      using errcode = '22023', hint = 'invoice_not_issued';
  end if;
  if p_paid_on is null or p_paid_on > v_today or p_paid_on < v_inv.issue_date then
    raise exception 'mark_invoice_paid: the payment date must be between the issue date and today'
      using errcode = '22023', hint = 'invoice_paid_on_out_of_range';
  end if;

  if v_inv.event_id is not null then
    select e.deleted_at is null into v_live
      from public.events e
     where e.id = v_inv.event_id and e.organisation_id = v_inv.organisation_id;
  end if;

  if coalesce(v_live, false) then
    -- Row locks in id order, the order issue_invoice's FOR SHARE takes, so
    -- the two can never deadlock over a pair of entries.
    perform 1 from public.financial_entries fe
     where fe.id in (select l.financial_entry_id from public.invoice_lines l
                      where l.invoice_id = p_invoice_id)
     order by fe.id
       for update;
    -- Only an entry that is still live budgeted income on the invoice's event
    -- is flipped (issue's live-income rule). One deleted, re-categorised or
    -- moved since the issue goes unbooked (Q257), and one already actual is
    -- left alone, so void never reverts what mark-paid did not do.
    with flipped as (
      update public.financial_entries fe
         set status = 'actual'
       where fe.organisation_id = v_inv.organisation_id
         and fe.status = 'budgeted'
         and fe.deleted_at is null
         and fe.category = 'income'
         and fe.event_id = v_inv.event_id
         and fe.id in (select l.financial_entry_id from public.invoice_lines l
                        where l.invoice_id = p_invoice_id and l.financial_entry_id is not null)
      returning fe.id)
    select coalesce(pg_catalog.array_agg(f.id), '{}') into v_flipped from flipped f;

    -- Still 'issued', so the line freeze admits a change to entry_flipped alone.
    update public.invoice_lines l set entry_flipped = true
     where l.invoice_id = p_invoice_id and l.financial_entry_id = any (v_flipped);

    select coalesce(sum(l.net_minor), 0) into v_rest
      from public.invoice_lines l
     where l.invoice_id = p_invoice_id and l.financial_entry_id is null;

    if v_rest > 0 then
      insert into public.financial_entries (organisation_id, event_id, category, status, amount_minor,
                                            currency, occurred_on, description, created_by)
      values (v_inv.organisation_id, v_inv.event_id, 'income', 'actual', v_rest,
              'GBP', p_paid_on, 'Invoice ' || v_inv.number, v_uid)
      returning id into v_entry;
    end if;
  end if;

  update public.invoices i
     set status = 'paid', paid_on = p_paid_on, paid_by = v_uid, paid_entry_id = v_entry
   where i.id = p_invoice_id;

  perform private.log_audit_event(
    p_action          => 'invoice.marked_paid',
    p_target_type     => 'invoice',
    p_organisation_id => v_inv.organisation_id,
    p_target_id       => p_invoice_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'issued'),
    p_after           => pg_catalog.jsonb_build_object(
                           'status', 'paid', 'number', v_inv.number,
                           'entries_flipped', pg_catalog.cardinality(v_flipped),
                           'income_entry_created', v_entry is not null));
end;
$$;

comment on function public.mark_invoice_paid(uuid, date) is
  'Marks an ISSUED invoice paid on p_paid_on (issue date .. UK today). With a live event: flips each pulled budgeted entry to actual (recorded in invoice_lines.entry_flipped) and books the net of the lines with no financial_entry_id as one actual income entry (invoices.paid_entry_id). Requires manage_finance and the Pro entitlement; audits invoice.marked_paid as {status, number, entries_flipped, income_entry_created} (name-only: no date, no amount).';
revoke all on function public.mark_invoice_paid(uuid, date) from public, anon, authenticated, service_role;
grant execute on function public.mark_invoice_paid(uuid, date) to authenticated;

create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_inv      public.invoices;
  v_reason   text := pg_catalog.btrim(p_reason);
  v_reverted integer := 0;
  v_removed  boolean := false;
begin
  if v_uid is null then
    raise exception 'void_invoice: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  -- One refusal for "not yours" and "not there": no existence oracle.
  if not found or not public.has_permission(v_inv.organisation_id, 'manage_finance') then
    raise exception 'void_invoice: the caller may not change this invoice'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = v_inv.organisation_id) then
    raise exception 'void_invoice: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;
  if v_inv.status not in ('issued', 'paid') then
    raise exception 'void_invoice: only an issued or paid invoice can be voided'
      using errcode = '22023', hint = 'invoice_not_voidable';
  end if;
  if v_reason is null or v_reason = '' or pg_catalog.char_length(v_reason) > 500 then
    raise exception 'void_invoice: a reason of at most 500 characters is required'
      using errcode = '22023', hint = 'invoice_void_reason_required';
  end if;

  if v_inv.status = 'paid' then
    -- Row locks in id order, as mark_invoice_paid and issue_invoice take them.
    perform 1 from public.financial_entries fe
     where fe.id = v_inv.paid_entry_id
        or fe.id in (select l.financial_entry_id from public.invoice_lines l
                      where l.invoice_id = p_invoice_id and l.entry_flipped)
     order by fe.id
       for update;
    update public.financial_entries fe
       set status = 'budgeted'
     where fe.organisation_id = v_inv.organisation_id
       and fe.status = 'actual'
       and fe.id in (select l.financial_entry_id from public.invoice_lines l
                      where l.invoice_id = p_invoice_id and l.entry_flipped);
    get diagnostics v_reverted = row_count;
    if v_inv.paid_entry_id is not null then
      update public.financial_entries fe
         set deleted_at = pg_catalog.now()
       where fe.id = v_inv.paid_entry_id
         and fe.organisation_id = v_inv.organisation_id
         and fe.deleted_at is null;
      v_removed := found;
    end if;
  end if;

  update public.invoices i
     set status = 'void', voided_at = pg_catalog.now(), voided_by = v_uid, void_reason = v_reason
   where i.id = p_invoice_id;

  perform private.log_audit_event(
    p_action          => 'invoice.voided',
    p_target_type     => 'invoice',
    p_organisation_id => v_inv.organisation_id,
    p_target_id       => p_invoice_id,
    p_before          => pg_catalog.jsonb_build_object('status', v_inv.status),
    p_after           => pg_catalog.jsonb_build_object(
                           'status', 'void', 'number', v_inv.number, 'previous_status', v_inv.status,
                           'entries_reverted', v_reverted, 'income_entry_removed', v_removed));
end;
$$;

comment on function public.void_invoice(uuid, text) is
  'Voids an issued or paid invoice with a reason (1-500 chars). Keeps the number. From paid, reverses exactly what mark_invoice_paid recorded: flipped entries back to budgeted, the created income entry soft-deleted. Requires manage_finance and the Pro entitlement; audits invoice.voided as {status, number, previous_status, entries_reverted, income_entry_removed} (the reason is not in the payload).';
revoke all on function public.void_invoice(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.void_invoice(uuid, text) to authenticated;

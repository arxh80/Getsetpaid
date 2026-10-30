-- ===========================================================================
-- INVOICES PART 1 -- TASK 11: SEND. (Renumbered 20261107006000, as Tasks 3-10 were.)
-- The budget is spent by sendInvoiceAction BEFORE the Brevo call (the uploads
-- shape: there is no client INSERT on invoice_sends to meter at, and a
-- trigger here would meter after the email had already gone). The send is
-- recorded AFTER Brevo accepted it, through public.record_invoice_send(),
-- which re-checks manage_finance and the Pro entitlement and audits
-- invoice.sent with the number only -- the recipient's address is personal
-- data and stays in invoice_sends, out of the audit log.
-- ===========================================================================
insert into public.rate_limit_policies (category, subject_scope, max_requests, window_seconds, description)
values ('invoice_send', 'user', 30, 3600,
        'Invoice emails sent per user (Invoices part 1). Consumed by sendInvoiceAction before the Brevo call; outbound mail to an arbitrary address is a spam vector.');

create or replace function public.record_invoice_send(p_invoice_id uuid, p_to_email text, p_provider_message_id text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_org    uuid;
  v_status text;
  v_number text;
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'record_invoice_send: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select i.organisation_id, i.status, i.number into v_org, v_status, v_number
    from public.invoices i where i.id = p_invoice_id;
  if v_org is null or not public.has_permission(v_org, 'manage_finance') then
    raise exception 'record_invoice_send: the caller may not send this invoice'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = v_org) then
    raise exception 'record_invoice_send: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;
  if v_status not in ('issued', 'paid') then
    raise exception 'record_invoice_send: only an issued or paid invoice is sent'
      using errcode = '22023', hint = 'invoice_not_sendable';
  end if;
  if p_to_email is null or pg_catalog.char_length(p_to_email) > 254
     or p_to_email !~ '^[^\s@]+@[^\s@.]+\.[^\s@]+$' then
    raise exception 'record_invoice_send: that is not an email address'
      using errcode = '22023', hint = 'invoice_send_email_invalid';
  end if;
  insert into public.invoice_sends (organisation_id, invoice_id, to_email, sent_by, provider_message_id)
  values (v_org, p_invoice_id, p_to_email, v_uid, pg_catalog.left(p_provider_message_id, 200))
  returning id into v_id;
  perform private.log_audit_event(
    p_action          => 'invoice.sent',
    p_target_type     => 'invoice',
    p_organisation_id => v_org,
    p_target_id       => p_invoice_id,
    p_after           => pg_catalog.jsonb_build_object('number', v_number));
  return v_id;
end;
$$;
comment on function public.record_invoice_send(uuid, text, text) is
  'Records an invoice email Brevo accepted: issued or paid only, manage_finance + Pro. Appends invoice_sends and audits invoice.sent (number only, never the address).';
revoke all on function public.record_invoice_send(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.record_invoice_send(uuid, text, text) to authenticated;

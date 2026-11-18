-- ===========================================================================
-- INVOICES PART 3 -- TASK 3: THE RECEIVER'S ONLY READ PATH.
-- A definer view like public.network_directory: its WHERE is the row gate
-- (a live delivery to a workspace where the caller holds view_finance, and
-- the server request mark), its column list is the column gate, and both are
-- pinned in rls_invoice_deliveries.sql § DV. Never join a private table into
-- it. `id` and `organisation_id` are the delivery id and the RECEIVING
-- workspace (plan decision 1), so lib/list/query.ts's tenant clause applies
-- unchanged.
-- ===========================================================================

create view public.received_invoices
  with (security_invoker = false, security_barrier = true) as
select
  d.id,
  d.to_organisation_id                    as organisation_id,
  d.delivered_at,
  i.id                                    as invoice_id,
  i.snapshot -> 'seller' ->> 'name'       as sender_name,
  i.number,
  i.status,
  i.issue_date,
  i.due_date,
  i.currency,
  i.net_minor,
  i.vat_minor,
  i.gross_minor,
  i.paid_on,
  pg_catalog.jsonb_set(i.snapshot, '{recipient,email}', 'null'::jsonb) as snapshot,
  (i.status = 'issued' and exists (
     select 1 from public.invoice_stripe_accounts a
      where a.organisation_id = i.organisation_id
        and a.ended_at is null
        and a.charges_enabled))           as card_payment_enabled
from public.invoice_deliveries d
join public.invoices i
  on i.id = d.invoice_id
 and i.organisation_id = d.from_organisation_id
where d.withdrawn_at is null
  and d.to_organisation_id in (select private.permitted_organisations('view_finance'))
  and private.request_is_from_server();

comment on view public.received_invoices is
  'Invoices part 3: THE ONLY RECEIVER READ PATH. One row per live delivery into a workspace where the caller holds view_finance (any tier), only on a server-marked request. Definer view (security_invoker off, security_barrier on), like public.network_directory. Columns pinned in rls_invoice_deliveries.sql § DV2: never event_id, notes outside the snapshot, recipient ids, paid_entry_id, void_reason, actor columns, invoice_sends, invoice_lines.financial_entry_id or any Stripe identifier. Dependencies pinned from pg_depend (DV3/DV4). id is the delivery, organisation_id the receiving workspace. snapshot has recipient.email blanked (the sender''s private CRM contact email, which the PDF never prints); the key stays because parseSnapshot reads it. Pinned in § DV18.';

revoke all on public.received_invoices from public, anon, authenticated, service_role;
grant select on public.received_invoices to authenticated;

create function public.audit_received_invoice_download(p_delivery_id uuid)
returns void
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
begin
  if v_uid is null then
    raise exception 'audit_received_invoice_download: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select d.to_organisation_id, i.status, i.number into v_org, v_status, v_number
    from public.invoice_deliveries d
    join public.invoices i on i.id = d.invoice_id and i.organisation_id = d.from_organisation_id
   where d.id = p_delivery_id and d.withdrawn_at is null;
  if v_org is null or not public.has_permission(v_org, 'view_finance') then
    raise exception 'audit_received_invoice_download: the caller may not read this invoice'
      using errcode = '42501', hint = 'forbidden';
  end if;
  perform private.log_audit_event(
    p_action          => 'invoice.received_pdf_downloaded',
    p_target_type     => 'invoice_delivery',
    p_organisation_id => v_org,
    p_target_id       => p_delivery_id,
    p_after           => pg_catalog.jsonb_build_object('number', v_number, 'status', v_status));
end;
$$;
comment on function public.audit_received_invoice_download(uuid) is
  'Invoices part 3: writes invoice.received_pdf_downloaded in the RECEIVING workspace for a live delivery the caller may read (view_finance there, any tier). Called by the received PDF route before it renders (plan decision 7).';
revoke all on function public.audit_received_invoice_download(uuid) from public, anon, authenticated, service_role;
grant execute on function public.audit_received_invoice_download(uuid) to authenticated;

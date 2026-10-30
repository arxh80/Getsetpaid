-- ===========================================================================
-- INVOICES PART 1 -- TASK 10 (renumbered 20261107005000, as Tasks 3-7 were): THE PDF DOWNLOAD IS AUDITED.
-- The PDF route renders from the immutable snapshot on demand and stores
-- nothing; it calls this BEFORE rendering a byte -- no audit, no PDF. Reads
-- are not tier-gated (spec § Permissions: after a downgrade "view and
-- download stay"), so view_finance alone, in the invoice's own workspace.
-- ===========================================================================
create or replace function public.audit_invoice_download(p_invoice_id uuid)
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
    raise exception 'audit_invoice_download: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select i.organisation_id, i.status, i.number into v_org, v_status, v_number
    from public.invoices i where i.id = p_invoice_id;
  if v_org is null or not public.has_permission(v_org, 'view_finance') then
    raise exception 'audit_invoice_download: the caller may not read this invoice'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if v_status = 'draft' then
    raise exception 'audit_invoice_download: a draft has no PDF'
      using errcode = '22023', hint = 'invoice_not_issued';
  end if;
  perform private.log_audit_event(
    p_action          => 'invoice.pdf_downloaded',
    p_target_type     => 'invoice',
    p_organisation_id => v_org,
    p_target_id       => p_invoice_id,
    p_after           => pg_catalog.jsonb_build_object('number', v_number, 'status', v_status));
end;
$$;
comment on function public.audit_invoice_download(uuid) is
  'Writes invoice.pdf_downloaded for an issued, paid or void invoice the caller may read (view_finance, not tier-gated). Called by the PDF route before it renders anything.';
revoke all on function public.audit_invoice_download(uuid) from public, anon, authenticated, service_role;
grant execute on function public.audit_invoice_download(uuid) to authenticated;

-- ===========================================================================
-- A CARD PAYER CANNOT BE CHARGED TWICE BY CLICKING PAY TWICE.
-- Every click minted a new Checkout Session, and an earlier one stayed payable
-- for Stripe's 24 hours, so two tabs could take two payments. begin now also
-- returns the invoice's latest stamped session from the last 24 hours;
-- lib/invoices/pay.ts sends the payer back to it while Stripe says it is open.
-- Rebuilt from 20261110002000; the only change is that one column. A return
-- type cannot be altered in place, so drop and create, with the same grants.
-- ===========================================================================

drop function public.begin_invoice_card_payment(uuid);

create function public.begin_invoice_card_payment(p_invoice_id uuid)
returns table (account text, number text, gross_minor bigint, fee_minor bigint, pay_session_id uuid,
               previous_stripe_session_id text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv      public.invoices;
  v_account  text;
  v_session  uuid;
  v_previous text;
begin
  -- The lock serialises concurrent clicks, so each counts the others' rows.
  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  if found then
    v_account := private.invoice_is_payable_online(v_inv);
  end if;
  if v_account is null then
    raise exception 'begin_invoice_card_payment: this invoice cannot be paid by card'
      using errcode = '22023', hint = 'invoice_not_payable_online';
  end if;
  if (select pg_catalog.count(*) from public.invoice_pay_sessions s
       where s.invoice_id = v_inv.id and s.created_at > pg_catalog.now() - interval '1 hour') >= 20 then
    raise exception 'begin_invoice_card_payment: too many payment sessions for this invoice this hour'
      using errcode = '54000', hint = 'invoice_pay_rate_limited';
  end if;

  -- 24 hours: how long Stripe keeps a Checkout Session payable by default.
  select s.stripe_session_id into v_previous
    from public.invoice_pay_sessions s
   where s.invoice_id = v_inv.id and s.stripe_session_id is not null
     and s.created_at > pg_catalog.now() - interval '24 hours'
   order by s.created_at desc
   limit 1;

  insert into public.invoice_pay_sessions (organisation_id, invoice_id)
  values (v_inv.organisation_id, v_inv.id)
  returning id into v_session;

  return query
    select v_account, v_inv.number, v_inv.gross_minor,
           private.application_fee_minor(v_inv.gross_minor, (select f.application_fee_bps from public.stripe_platform_settings f)),
           v_session, v_previous;
end;
$$;
comment on function public.begin_invoice_card_payment(uuid) is
  'service_role only: the pay page''s POST. Locks the invoice, refuses unless it is payable by card now (invoice_not_payable_online, 22023) or 20 sessions already exist for it in the last hour (invoice_pay_rate_limited, 54000), writes one counted invoice_pay_sessions row and returns the live account id, the number, the gross, the application fee (platform setting, in minor units), the row id, and the invoice''s latest Stripe Checkout Session id stamped in the last 24 hours (null when none), so the caller can send the payer back to a session that is still open instead of opening a second one.';
revoke all on function public.begin_invoice_card_payment(uuid) from public, anon, authenticated, service_role;
grant execute on function public.begin_invoice_card_payment(uuid) to service_role;

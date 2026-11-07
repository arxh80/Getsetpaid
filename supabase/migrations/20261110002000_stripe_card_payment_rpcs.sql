-- ===========================================================================
-- INVOICES PART 2 -- TASK 4: PAYING. The pay page's two reads/writes, the
-- Checkout session counter, and the webhook's card-payment writes. All
-- service_role only: the payer is anonymous and Stripe is a server, so nobody
-- is ever on the session (spec docs/superpowers/specs/2026-11-05-invoices-
-- stripe-design.md; plan decisions 1, 4, 5 and 7).
--
--   private.invoice_is_payable_online(invoices)  the ONE gate: the live account id, or null
--   invoice_pay_page(invoice)                    what the page may say; every refusal is payable=false
--   begin_invoice_card_payment(invoice)          the account, the fee and a counted session row
--   attach_invoice_pay_session(session, cs_...)  stamps the Stripe session on that row
--   record_stripe_checkout_completed(...)        a paid checkout: book it, or flag it
--   record_stripe_charge_refunded(...)           a refund: flagged for the Owner, never applied
--   stripe_account_deauthorized / _updated       Task 3's two, now idempotent on the event id
--
-- Every write by the webhook is sessionless, so private.log_audit_event()
-- (which wants auth.uid()) cannot be used: audit rows are inserted directly
-- with the Q130 tombstone as actor, name-only (a status and an invoice number,
-- never an account, payment intent, amount or email).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE GATE. Pro is read from the invoice's OWN workspace through the one
--    effective-tier function: private.finance_module_organisations() answers
--    for auth.uid(), and nobody is on this session. A workspace that left Pro
--    cannot disconnect Stripe in the app (the end RPC needs Pro), so this is
--    what stops it being charged.
-- ---------------------------------------------------------------------------
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
                    and (not e.has_subscription or (e.status_ok and e.finance_module)))
$$;
comment on function private.invoice_is_payable_online(public.invoices) is
  'The live Stripe account id when this invoice can be paid by card now (issued, a total to charge, the workspace''s link live with charges enabled, the workspace open and on a plan with the finance module), else null. Reads the invoice''s own workspace through private.effective_organisation_plan(), not the per-caller private.finance_module_organisations(), because nobody is signed in on the pay page. The single gate behind invoice_pay_page and begin_invoice_card_payment.';
revoke all on function private.invoice_is_payable_online(public.invoices) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. THE PAY PAGE
-- ---------------------------------------------------------------------------
create or replace function public.invoice_pay_page(p_invoice_id uuid)
returns table (payable boolean, seller_name text, number text, gross_minor bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices;
begin
  select * into v_inv from public.invoices i where i.id = p_invoice_id;
  -- Unknown and draft look the same, and differ from a known-but-unpayable
  -- invoice only by the seller's name: the spec's two refusal sentences.
  if not found or v_inv.status = 'draft' then
    return query select false, null::text, null::text, null::bigint;
    return;
  end if;
  if private.invoice_is_payable_online(v_inv) is null then
    return query select false, v_inv.snapshot -> 'seller' ->> 'name', null::text, null::bigint;
    return;
  end if;
  return query select true, v_inv.snapshot -> 'seller' ->> 'name', v_inv.number, v_inv.gross_minor;
end;
$$;
comment on function public.invoice_pay_page(uuid) is
  'service_role only: what the public pay page may show for an invoice id. payable is false for every refusal (unknown, draft, paid, void, no live charging link, a workspace off Pro or closed); seller_name is null for an unknown id or a draft; number and gross_minor are null unless payable.';
revoke all on function public.invoice_pay_page(uuid) from public, anon, authenticated, service_role;
grant execute on function public.invoice_pay_page(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. BEGIN A CHECKOUT: the gate, the hourly budget, the fee, the counted row
-- ---------------------------------------------------------------------------
create or replace function public.begin_invoice_card_payment(p_invoice_id uuid)
returns table (account text, number text, gross_minor bigint, fee_minor bigint, pay_session_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv     public.invoices;
  v_account text;
  v_session uuid;
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

  insert into public.invoice_pay_sessions (organisation_id, invoice_id)
  values (v_inv.organisation_id, v_inv.id)
  returning id into v_session;

  return query
    select v_account, v_inv.number, v_inv.gross_minor,
           private.application_fee_minor(v_inv.gross_minor, (select f.application_fee_bps from public.stripe_platform_settings f)),
           v_session;
end;
$$;
comment on function public.begin_invoice_card_payment(uuid) is
  'service_role only: the pay page''s POST. Locks the invoice, refuses unless it is payable by card now (invoice_not_payable_online, 22023) or 20 sessions already exist for it in the last hour (invoice_pay_rate_limited, 54000), writes one counted invoice_pay_sessions row and returns the live account id, the number, the gross, the application fee (platform setting, in minor units) and the row id.';
revoke all on function public.begin_invoice_card_payment(uuid) from public, anon, authenticated, service_role;
grant execute on function public.begin_invoice_card_payment(uuid) to service_role;

create or replace function public.attach_invoice_pay_session(p_pay_session_id uuid, p_stripe_session_id text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  -- Once only: a session id already stamped is never overwritten.
  update public.invoice_pay_sessions s
     set stripe_session_id = p_stripe_session_id
   where s.id = p_pay_session_id and s.stripe_session_id is null
$$;
comment on function public.attach_invoice_pay_session(uuid, text) is
  'service_role only: stamps the Stripe Checkout Session id (cs_...) on the counted row begin_invoice_card_payment wrote. Set once; a stamped row is left as it is.';
revoke all on function public.attach_invoice_pay_session(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.attach_invoice_pay_session(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. A PAID CHECKOUT (checkout.session.completed)
-- ---------------------------------------------------------------------------
create or replace function public.record_stripe_checkout_completed(
  p_event_id       text,
  p_account        text,
  p_invoice_id     uuid,
  p_payment_intent text,
  p_amount_minor   bigint,
  p_currency       text,
  p_paid_at        timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_inv     public.invoices;
  v_paid_on date;
  v_entry   uuid;
  v_outcome text;
  v_found   boolean;
begin
  -- The workspace, from the account it was paid into (a live link first, then an ended one).
  select a.organisation_id into v_org
    from public.invoice_stripe_accounts a
   where a.stripe_account_id = p_account
   order by a.ended_at nulls first
   limit 1;
  if v_org is null then
    return 'unknown_account';
  end if;

  insert into public.stripe_events (id, organisation_id, type)
  values (p_event_id, v_org, 'checkout.session.completed')
  on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  -- Lock first, then test the payment intent: two deliveries of one payment
  -- under different event ids serialise here, and the second sees the first.
  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  v_found := found;
  if exists (select 1 from public.invoice_card_payments p where p.stripe_payment_intent_id = p_payment_intent) then
    return 'duplicate';
  end if;

  if not v_found
     or v_inv.organisation_id <> v_org
     or v_inv.status not in ('issued', 'paid', 'void')
     or not exists (select 1 from public.invoice_stripe_accounts a
                     where a.organisation_id = v_org and a.stripe_account_id = p_account and a.ended_at is null)
     or p_amount_minor is distinct from v_inv.gross_minor
     or p_amount_minor <= 0
     or upper(p_currency) is distinct from v_inv.currency then
    -- Attributed to the invoice's workspace when there is one: that is whose payment it was meant to be.
    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values ('stripe_payment_mismatch', coalesce(v_inv.organisation_id, v_org),
            'A card payment did not match its invoice',
            pg_catalog.jsonb_build_object('invoice_id', p_invoice_id, 'event_id', p_event_id));
    return 'mismatch';
  end if;

  if v_inv.status = 'issued' then
    -- Stripe's clock is the UK date of the payment, never before the issue date.
    v_paid_on := greatest((p_paid_at at time zone 'Europe/London')::date, v_inv.issue_date);
    select b.entry_id into v_entry from private.book_invoice_payment(v_inv.id, v_paid_on, null) b;
    update public.invoices i
       set status = 'paid', paid_on = v_paid_on, paid_via = 'card', paid_entry_id = v_entry
     where i.id = v_inv.id;
    insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id,
                                              amount_minor, currency, outcome)
    values (v_org, v_inv.id, p_event_id, p_payment_intent, p_amount_minor, v_inv.currency, 'applied');
    insert into public.audit_events (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
    values (v_org, private.erased_user_id(), 'invoice.paid_by_card', 'invoice', v_inv.id, pg_catalog.gen_random_uuid(),
            pg_catalog.jsonb_build_object('status', 'paid', 'number', v_inv.number));
    return 'applied';
  end if;

  -- The money arrived but the invoice is already settled: keep it, flag it.
  v_outcome := case v_inv.status when 'paid' then 'after_paid' else 'after_void' end;
  insert into public.invoice_card_payments (organisation_id, invoice_id, stripe_event_id, stripe_payment_intent_id,
                                            amount_minor, currency, outcome)
  values (v_org, v_inv.id, p_event_id, p_payment_intent, p_amount_minor, v_inv.currency, v_outcome);
  insert into public.audit_events (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
  values (v_org, private.erased_user_id(), 'invoice.card_payment_conflict', 'invoice', v_inv.id, pg_catalog.gen_random_uuid(),
          pg_catalog.jsonb_build_object('status', v_inv.status, 'number', v_inv.number));
  return v_outcome;
end;
$$;
comment on function public.record_stripe_checkout_completed(text, text, uuid, text, bigint, text, timestamptz) is
  'service_role only: a paid Stripe Checkout (checkout.session.completed). unknown_account for an account no workspace has (nothing written); duplicate for an event id or payment intent already recorded; mismatch (and a stripe_payment_mismatch incident alert carrying only the invoice and event ids) when the invoice is missing, another workspace''s, a draft, the account is not that workspace''s live link, or the amount or currency differs; applied for an issued invoice (booked through private.book_invoice_payment with no actor, marked paid by card on the UK date of p_paid_at, not before the issue date, audited invoice.paid_by_card as {status, number}); after_paid / after_void for an invoice already settled (the payment is kept, audited invoice.card_payment_conflict as {status, number}).';
revoke all on function public.record_stripe_checkout_completed(text, text, uuid, text, bigint, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.record_stripe_checkout_completed(text, text, uuid, text, bigint, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 5. A REFUND (charge.refunded): flagged for the Owner, never applied
-- ---------------------------------------------------------------------------
create or replace function public.record_stripe_charge_refunded(
  p_event_id       text,
  p_account        text,
  p_payment_intent text,
  p_refunded_minor bigint,
  p_refunded_at    timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_invoice uuid;
  v_inv     public.invoices;
begin
  select a.organisation_id into v_org
    from public.invoice_stripe_accounts a
   where a.stripe_account_id = p_account
   order by a.ended_at nulls first
   limit 1;
  if v_org is null then
    return 'unknown_account';
  end if;

  insert into public.stripe_events (id, organisation_id, type)
  values (p_event_id, v_org, 'charge.refunded')
  on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  -- Stripe sends the cumulative refunded amount; it can never exceed the payment.
  update public.invoice_card_payments p
     set refunded_minor = least(p_refunded_minor, p.amount_minor), refunded_at = p_refunded_at
   where p.stripe_payment_intent_id = p_payment_intent and p.organisation_id = v_org
  returning p.invoice_id into v_invoice;
  if v_invoice is null then
    return 'unknown_payment';
  end if;

  select * into v_inv from public.invoices i where i.id = v_invoice;
  insert into public.audit_events (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
  values (v_org, private.erased_user_id(), 'invoice.card_refund_flagged', 'invoice', v_invoice, pg_catalog.gen_random_uuid(),
          pg_catalog.jsonb_build_object('status', v_inv.status, 'number', v_inv.number));
  return 'flagged';
end;
$$;
comment on function public.record_stripe_charge_refunded(text, text, text, bigint, timestamptz) is
  'service_role only: a Stripe refund (charge.refunded). Sets the payment''s refunded_minor (the cumulative amount, clamped to the payment) and refunded_at and audits invoice.card_refund_flagged as {status, number}; the invoice stays paid (a refund is flagged for the Owner, never applied). unknown_account for an account no workspace has (nothing written); duplicate for an event id already recorded; unknown_payment for a payment intent this workspace never received.';
revoke all on function public.record_stripe_charge_refunded(text, text, text, bigint, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.record_stripe_charge_refunded(text, text, text, bigint, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 6. TASK 3'S TWO WEBHOOK WRITES, NOW IDEMPOTENT ON THE EVENT ID. Rebuilt from
--    the live definitions (identical to 20261110001000); the only additions are
--    p_event_id (first, like the two above) and the stripe_events insert with
--    its duplicate answer (false: nothing applied). An event is recorded only
--    when it found a live link, so an unknown account leaves no row.
-- ---------------------------------------------------------------------------
drop function public.stripe_account_deauthorized(text);
drop function public.stripe_account_updated(text, boolean);

create or replace function public.stripe_account_deauthorized(p_event_id text, p_account text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'stripe_account_deauthorized: written by the webhook, never from a person''s session'
      using errcode = '42501', hint = 'stripe_write_is_server_only';
  end if;
  select a.organisation_id into v_org
    from public.invoice_stripe_accounts a
   where a.stripe_account_id = p_account and a.ended_at is null
     for update;
  if v_org is null then
    return false;
  end if;
  insert into public.stripe_events (id, organisation_id, type)
  values (p_event_id, v_org, 'account.application.deauthorized')
  on conflict (id) do nothing;
  if not found then
    return false;
  end if;
  update public.invoice_stripe_accounts a
     set ended_at = pg_catalog.now(), ended_reason = 'deauthorized'
   where a.organisation_id = v_org;
  -- Sessionless, so private.log_audit_event (which wants auth.uid()) cannot be used.
  insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, after)
  values (v_org, private.erased_user_id(), 'invoice_stripe_account.ended', 'invoice_stripe_account',
          pg_catalog.gen_random_uuid(), pg_catalog.jsonb_build_object('reason', 'deauthorized'));
  return true;
end;
$$;

comment on function public.stripe_account_deauthorized(text, text) is
  'service_role only: Stripe says the workspace revoked GetSetPaid''s access (account.application.deauthorized, event p_event_id). Ends the live link for that account (ended_reason deauthorized), records the event id and audits invoice_stripe_account.ended as {reason} with the Q130 tombstone as actor. True when a live link was ended; false for an account no workspace holds live or an event id already recorded (nothing applied).';
revoke all on function public.stripe_account_deauthorized(text, text) from public, anon, authenticated, service_role;
grant execute on function public.stripe_account_deauthorized(text, text) to service_role;

create or replace function public.stripe_account_updated(p_event_id text, p_account text, p_charges_enabled boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_old boolean;
  v_new boolean := coalesce(p_charges_enabled, false);
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'stripe_account_updated: written by the webhook, never from a person''s session'
      using errcode = '42501', hint = 'stripe_write_is_server_only';
  end if;
  select a.organisation_id, a.charges_enabled into v_org, v_old
    from public.invoice_stripe_accounts a
   where a.stripe_account_id = p_account and a.ended_at is null
     for update;
  if v_org is null then
    return false;
  end if;
  insert into public.stripe_events (id, organisation_id, type)
  values (p_event_id, v_org, 'account.updated')
  on conflict (id) do nothing;
  if not found then
    return false;
  end if;
  -- account.updated is noisy: only a real flip is written, and audited.
  if v_old is distinct from v_new then
    update public.invoice_stripe_accounts a set charges_enabled = v_new where a.organisation_id = v_org;
    -- Sessionless, so private.log_audit_event cannot be used. No notice reads this action.
    insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, after)
    values (v_org, private.erased_user_id(), 'invoice_stripe_account.charges_enabled_changed', 'invoice_stripe_account',
            pg_catalog.gen_random_uuid(), pg_catalog.jsonb_build_object('changed', pg_catalog.jsonb_build_array('charges_enabled')));
  end if;
  return true;
end;
$$;

comment on function public.stripe_account_updated(text, text, boolean) is
  'service_role only: mirrors Stripe''s charges_enabled for the live link on p_account (account.updated, event p_event_id). True when a live link was found and the event was new, false otherwise (no live link, or an event id already recorded: nothing applied). When the stored value actually flips it audits invoice_stripe_account.charges_enabled_changed as {changed: [charges_enabled]} with the Q130 tombstone as actor; a repeat of the same value writes nothing. That action feeds no notice.';
revoke all on function public.stripe_account_updated(text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.stripe_account_updated(text, text, boolean) to service_role;

-- ===========================================================================
-- INVOICES PART 2 -- TASK 2: THE STRIPE TABLES, paid_via, AND THE SHARED
-- BOOKING HELPER (spec docs/superpowers/specs/2026-11-05-invoices-stripe-design.md).
-- No client role writes any table here: the signed-in writes are Task 3's
-- RPCs, the sessionless ones (pay page, webhook) Task 4's service_role RPCs.
-- Plan decisions 1, 2, 3 and 5.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE TABLES
-- ---------------------------------------------------------------------------
create table public.invoice_stripe_accounts (
  organisation_id   uuid primary key references public.organisations (id) on delete cascade,
  stripe_account_id text not null check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  charges_enabled   boolean not null default false,
  linked_by         uuid references auth.users (id),
  linked_at         timestamptz not null default pg_catalog.now(),
  ended_at          timestamptz,
  ended_reason      text check (ended_reason in ('disconnected', 'deauthorized')),
  created_at        timestamptz not null default pg_catalog.now(),
  updated_at        timestamptz not null default pg_catalog.now(),
  constraint invoice_stripe_accounts_end_pair check ((ended_at is null) = (ended_reason is null))
);
create unique index invoice_stripe_accounts_live_account_idx
  on public.invoice_stripe_accounts (stripe_account_id) where ended_at is null;
create index invoice_stripe_accounts_linked_by_idx on public.invoice_stripe_accounts (linked_by);
create trigger set_updated_at before update on public.invoice_stripe_accounts
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();
alter table public.invoice_stripe_accounts enable row level security;
create policy invoice_stripe_accounts_select on public.invoice_stripe_accounts for select to authenticated
  using (organisation_id in (select private.permitted_organisations('view_finance')));
revoke all on public.invoice_stripe_accounts from public, anon, authenticated, service_role;
grant select on public.invoice_stripe_accounts to authenticated;
comment on table public.invoice_stripe_accounts is
  'A workspace''s link to its own Stripe account (Invoices part 2, Standard Connect). One row per workspace; ended_at/ended_reason mark a link that was disconnected or deauthorized, and free the account id for another workspace. Read by view_finance; written only by the SECURITY DEFINER RPCs.';

create table public.stripe_platform_settings (
  id                  boolean primary key default true check (id),
  application_fee_bps integer not null check (application_fee_bps between 0 and 1000)
);
insert into public.stripe_platform_settings (application_fee_bps) values (100);  -- Q279: 1%
alter table public.stripe_platform_settings enable row level security;
revoke all on public.stripe_platform_settings from public, anon, authenticated, service_role;
comment on table public.stripe_platform_settings is
  'One row: the application fee GetSetPaid takes on each card payment, in basis points of the gross (Q279: 100 = 1%). No client role reads or writes it; the Checkout RPC reads it as definer.';

create table public.invoice_pay_sessions (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete cascade,
  invoice_id        uuid not null,
  stripe_session_id text check (stripe_session_id ~ '^cs_[A-Za-z0-9_]+$'),
  created_at        timestamptz not null default pg_catalog.now(),
  foreign key (invoice_id, organisation_id) references public.invoices (id, organisation_id) on delete cascade
);
create index invoice_pay_sessions_invoice_created_idx on public.invoice_pay_sessions (invoice_id, created_at);
create index invoice_pay_sessions_org_idx on public.invoice_pay_sessions (organisation_id);
alter table public.invoice_pay_sessions enable row level security;
revoke all on public.invoice_pay_sessions from public, anon, authenticated, service_role;
comment on table public.invoice_pay_sessions is
  'One row per Stripe Checkout Session created for an invoice, so the pay page can hold its 20-per-hour budget. Counter only; no client role reads or writes it.';

create table public.invoice_card_payments (
  id                       uuid primary key default gen_random_uuid(),
  organisation_id          uuid not null references public.organisations (id) on delete cascade,
  invoice_id               uuid not null,
  stripe_event_id          text not null,
  stripe_payment_intent_id text not null unique check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  amount_minor             bigint not null check (amount_minor > 0),
  currency                 text not null check (currency = 'GBP'),
  outcome                  text not null check (outcome in ('applied', 'after_paid', 'after_void')),
  received_at              timestamptz not null default pg_catalog.now(),
  refunded_minor           bigint not null default 0 check (refunded_minor >= 0 and refunded_minor <= amount_minor),
  refunded_at              timestamptz,
  constraint invoice_card_payments_refund_pair check ((refunded_minor = 0) = (refunded_at is null)),
  foreign key (invoice_id, organisation_id) references public.invoices (id, organisation_id) on delete cascade
);
create index invoice_card_payments_invoice_idx on public.invoice_card_payments (invoice_id);
create index invoice_card_payments_org_idx on public.invoice_card_payments (organisation_id);
alter table public.invoice_card_payments enable row level security;
create policy invoice_card_payments_select on public.invoice_card_payments for select to authenticated
  using (organisation_id in (select private.permitted_organisations('view_finance')));
revoke all on public.invoice_card_payments from public, anon, authenticated, service_role;
grant select on public.invoice_card_payments to authenticated;
comment on table public.invoice_card_payments is
  'One row per Stripe payment received against an invoice: the payment intent, the amount, the outcome (applied | after_paid | after_void) and any refund. Kept out of public.invoices so the invoice freeze is not widened (plan decision 1). Read by view_finance; written only by the SECURITY DEFINER RPCs.';

create table public.stripe_events (
  id              text primary key check (id ~ '^evt_[A-Za-z0-9_]+$'),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  type            text not null,
  received_at     timestamptz not null default pg_catalog.now()
);
create index stripe_events_org_idx on public.stripe_events (organisation_id);
alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from public, anon, authenticated, service_role;
comment on table public.stripe_events is
  'The webhook idempotency ledger: Stripe event ids only, attributed to the workspace whose account sent them (plan decision 5). No client role reads or writes it.';

create table private.stripe_link_states (
  state_hash      bytea primary key,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  expires_at      timestamptz not null,
  used_at         timestamptz
);
create index stripe_link_states_org_idx on private.stripe_link_states (organisation_id);
create index stripe_link_states_user_idx on private.stripe_link_states (user_id);
revoke all on private.stripe_link_states from public, anon, authenticated, service_role;
comment on table private.stripe_link_states is
  'The OAuth state of a Stripe Connect link, as a SHA-256 hash bound to the user and workspace that began it, with a 10-minute expiry (plan decision 3). Private schema: no client role reaches it.';

create or replace function private.application_fee_minor(p_gross bigint, p_bps integer)
returns bigint language sql immutable set search_path = '' as $$
  select (p_gross * p_bps + 5000) / 10000   -- integer division = floor for non-negatives; lib/stripe/fee.ts
$$;
revoke all on function private.application_fee_minor(bigint, integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. invoices.paid_via, THE REBUILT SHAPE, AND THE BACKFILL
--    A card payment has no person, so paid_by cannot stay mandatory
--    whenever paid_on is set (plan decision 2).
-- ---------------------------------------------------------------------------
alter table public.invoices add column paid_via text check (paid_via in ('manual', 'card'));
comment on column public.invoices.paid_via is
  'How an invoice was paid: manual (a person marked it paid; paid_by names them) or card (a Stripe payment; paid_by is null). Set with paid_on and frozen with it.';

-- Every payment recorded so far was marked by hand. The freeze trigger would
-- refuse the update, so it is off for this one statement and back on before
-- the migration (one transaction) ends: no client can see the window.
alter table public.invoices disable trigger invoices_freeze;
update public.invoices set paid_via = 'manual' where paid_on is not null;
alter table public.invoices enable trigger invoices_freeze;

alter table public.invoices drop constraint invoices_paid_shape,
  add constraint invoices_paid_shape check (
    (paid_on is null) = (paid_via is null)
    and (paid_via is distinct from 'manual' or paid_by is not null)
    and (paid_via is distinct from 'card'   or paid_by is null)
    and (paid_via is not null or paid_by is null)
    and (status <> 'paid' or paid_on is not null)
    and (status in ('paid', 'void') or (paid_on is null and paid_entry_id is null)));

-- ---------------------------------------------------------------------------
-- 3. private.invoices_freeze(), rebuilt from its live definition (diffed
--    identical to 20261107000000 first). Only paid_via is added: to v_moving,
--    to the same-status frozen tuple and to the void branch's kept tuple. The
--    erasure re-point stays on paid_by (a card payment has none).
-- ---------------------------------------------------------------------------
create or replace function private.invoices_freeze()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The columns a non-draft row may still change, each only in its own
  -- transition (checked below). Everything else is frozen at issue.
  v_moving constant text[] := array['status', 'paid_on', 'paid_by', 'paid_via', 'paid_entry_id',
                                    'voided_at', 'voided_by', 'void_reason',
                                    'created_by', 'updated_at'];
  v_tomb uuid := private.erased_user_id();
begin
  if tg_op = 'DELETE' then
    -- A draft is soft-deleted and an issued invoice voided; a hard delete is
    -- only ever the workspace purge's cascade, after the workspace row went.
    if old.status <> 'draft' and not private.invoice_workspace_is_gone(old.organisation_id) then
      raise exception 'invoices: an issued invoice is never deleted'
        using errcode = '42501', hint = 'invoice_is_frozen';
    end if;
    return old;
  end if;

  if old.status = 'draft' then
    if new.status not in ('draft', 'issued') then
      raise exception 'invoices: a draft can only be issued'
        using errcode = '42501', hint = 'invoice_transition_not_allowed';
    end if;
    return new;
  end if;

  -- The transition first, so a walk back to draft is named as one (IF5) even
  -- though it also clears the frozen columns.
  if new.status <> old.status
     and not (old.status = 'issued' and new.status = 'paid')
     and not (old.status in ('issued', 'paid') and new.status = 'void') then
    raise exception 'invoices: % -> % is not a transition', old.status, new.status
      using errcode = '42501', hint = 'invoice_transition_not_allowed';
  end if;

  if (pg_catalog.to_jsonb(new) - v_moving) is distinct from (pg_catalog.to_jsonb(old) - v_moving) then
    raise exception 'invoices: an issued invoice''s content is frozen'
      using errcode = '42501', hint = 'invoice_is_frozen';
  end if;

  -- A recorded actor may only ever be re-pointed at the erasure tombstone.
  if (new.created_by is distinct from old.created_by and new.created_by is distinct from v_tomb)
     or (old.paid_by is not null and new.paid_by is distinct from old.paid_by
         and new.paid_by is distinct from v_tomb)
     or (old.voided_by is not null and new.voided_by is distinct from old.voided_by
         and new.voided_by is distinct from v_tomb) then
    raise exception 'invoices: an issued invoice''s actors are frozen'
      using errcode = '42501', hint = 'invoice_is_frozen';
  end if;

  if new.status = old.status then
    if (new.paid_on, new.paid_via, new.paid_entry_id, new.voided_at, new.void_reason)
         is distinct from (old.paid_on, old.paid_via, old.paid_entry_id, old.voided_at, old.void_reason)
       or (old.paid_by is null and new.paid_by is not null)
       or (old.voided_by is null and new.voided_by is not null) then
      raise exception 'invoices: an issued invoice''s content is frozen'
        using errcode = '42501', hint = 'invoice_is_frozen';
    end if;
  elsif old.status = 'issued' and new.status = 'paid' then
    null;  -- the paid columns are set here; invoices_paid_shape holds their shape
  elsif old.status in ('issued', 'paid') and new.status = 'void' then
    if (new.paid_on, new.paid_by, new.paid_via, new.paid_entry_id)
         is distinct from (old.paid_on, old.paid_by, old.paid_via, old.paid_entry_id) then
      raise exception 'invoices: voiding keeps the payment record as it was'
        using errcode = '42501', hint = 'invoice_is_frozen';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.invoices_freeze() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. private.book_invoice_payment(): mark_invoice_paid's finance block (flip
--    the pulled budgeted entries, book the net of the free lines as income),
--    moved here verbatim so the card path (sessionless, Task 4) books exactly
--    what a hand-marked payment does. p_actor is the person who marked it, or
--    null for a card payment (financial_entries.created_by is nullable). It
--    locks the invoice and refuses unless it is issued; the caller writes the
--    invoice's paid columns. No grants: private.
-- ---------------------------------------------------------------------------
create or replace function private.book_invoice_payment(p_invoice_id uuid, p_paid_on date, p_actor uuid)
returns table (flipped integer, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv     public.invoices;
  v_live    boolean := false;
  v_flipped uuid[] := '{}';
  v_rest    bigint := 0;
  v_entry   uuid;
begin
  select * into v_inv from public.invoices i where i.id = p_invoice_id for update;
  if not found or v_inv.status <> 'issued' then
    raise exception 'book_invoice_payment: only an issued invoice can be booked'
      using errcode = '22023', hint = 'invoice_not_issued';
  end if;

  if v_inv.event_id is not null then
    select e.deleted_at is null into v_live
      from public.events e
     where e.id = v_inv.event_id and e.organisation_id = v_inv.organisation_id;
  end if;

  if coalesce(v_live, false) then
    -- Row locks in id order, the order issue_invoice's FOR SHARE takes, so
    -- the two can never deadlock over a pair of entries. NO KEY UPDATE, the
    -- mode the UPDATE below takes anyway: FOR UPDATE would also block the FK
    -- check's KEY SHARE from a concurrent draft save, in that save's order.
    perform 1 from public.financial_entries fe
     where fe.id in (select l.financial_entry_id from public.invoice_lines l
                      where l.invoice_id = p_invoice_id)
     order by fe.id
       for no key update;
    -- Only an entry that is still live budgeted income on the invoice's event
    -- is flipped (issue's live-income rule). One deleted, re-categorised or
    -- moved since the issue goes unbooked (Q257), and one already actual is
    -- left alone, so void never reverts what mark-paid did not do.
    with moved as (
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
    select coalesce(pg_catalog.array_agg(m.id), '{}') into v_flipped from moved m;

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
              'GBP', p_paid_on, 'Invoice ' || v_inv.number, p_actor)
      returning id into v_entry;
    end if;
  end if;

  return query select pg_catalog.cardinality(v_flipped), v_entry;
end;
$$;
comment on function private.book_invoice_payment(uuid, date, uuid) is
  'The finance half of paying an invoice, shared by public.mark_invoice_paid (a person, p_actor) and the sessionless card path (p_actor null): flips each pulled budgeted income entry on the live event to actual and books the net of the lines with no financial_entry_id as one actual income entry. Locks the invoice; refuses unless it is issued (invoice_not_issued). Returns (entries flipped, income entry id or null). The caller sets the invoice''s paid columns.';
revoke all on function private.book_invoice_payment(uuid, date, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. public.mark_invoice_paid(), rebuilt from its live definition (diffed
--    identical to 20261107003000 first). The finance block is now
--    private.book_invoice_payment(); the paid columns gain paid_via = 'manual'.
--    Same signature, same grants.
-- ---------------------------------------------------------------------------
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
  v_count   integer;
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

  select b.flipped, b.entry_id into v_count, v_entry from private.book_invoice_payment(p_invoice_id, p_paid_on, v_uid) b;
  update public.invoices i
     set status = 'paid', paid_on = p_paid_on, paid_by = v_uid, paid_via = 'manual', paid_entry_id = v_entry
   where i.id = p_invoice_id;

  perform private.log_audit_event(
    p_action          => 'invoice.marked_paid',
    p_target_type     => 'invoice',
    p_organisation_id => v_inv.organisation_id,
    p_target_id       => p_invoice_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'issued'),
    p_after           => pg_catalog.jsonb_build_object(
                           'status', 'paid', 'number', v_inv.number,
                           'entries_flipped', v_count,
                           'income_entry_created', v_entry is not null));
end;
$$;

comment on function public.mark_invoice_paid(uuid, date) is
  'Marks an ISSUED invoice paid on p_paid_on (issue date .. UK today), by hand (paid_via = manual). With a live event: flips each pulled budgeted entry to actual (recorded in invoice_lines.entry_flipped) and books the net of the lines with no financial_entry_id as one actual income entry (invoices.paid_entry_id), via private.book_invoice_payment. Requires manage_finance and the Pro entitlement; audits invoice.marked_paid as {status, number, entries_flipped, income_entry_created} (name-only: no date, no amount).';
revoke all on function public.mark_invoice_paid(uuid, date) from public, anon, authenticated, service_role;
grant execute on function public.mark_invoice_paid(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. THE INCIDENT-ALERT ALLOWLIST gains stripe_payment_mismatch (plan
--    decision 7). Latest list: 20261004004000. Mirrored by lib/admin/health.ts.
-- ---------------------------------------------------------------------------
alter table public.incident_alerts
  drop constraint incident_alerts_alert_type_known;

alter table public.incident_alerts
  add constraint incident_alerts_alert_type_known
  check (alert_type in ('rate_limit_tripped',
                        'repeated_login_failures',
                        'upload_quarantined',
                        'dsr_deadline_approaching',
                        'dsr_overdue',
                        'dsr_alert_writer_failed',
                        'retention_run_refused',
                        'stripe_payment_mismatch'));

comment on constraint incident_alerts_alert_type_known on public.incident_alerts is
  'The closed list of incident alert types. Phase 7 Task 5 shipped the first three unnamed; Phase 8 Task 3 added the two data-subject-request deadline alerts and named the constraint; its fix round 1 (20260925002000) added dsr_alert_writer_failed; Phase 8 Task 6 fix round 1 (20261004004000, Q182) added retention_run_refused -- a LIVE retention run that refused or failed for any reason but a switch somebody chose; Invoices part 2 Task 2 (20261110000000) added stripe_payment_mismatch -- a Stripe webhook whose account, amount or currency did not match the invoice it named. Mirrored by lib/admin/health.ts''s INCIDENT_ALERT_TYPE_LABELS, which tests/integration/admin/incident-alert-vocabularies-match-db.test.ts binds to this list.';

-- ---------------------------------------------------------------------------
-- 7. THE CATALOGUES, rebuilt from their live pg_get_functiondef (each diffed
--    identical to its latest defining migration first) with only the Stripe
--    rows added.
-- ---------------------------------------------------------------------------

-- (a) The audit catalogue: the five actions Tasks 3 and 4 write.
--     Latest defining migration: 20261107000000_invoice_tables.sql.
CREATE OR REPLACE FUNCTION private.platform_audit_actions()
 RETURNS SETOF text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- The four irreversible CRM actions (CRM_IRREVERSIBLE_AUDIT_ACTIONS).
    ('contact_company.deleted'),
    ('custom_field_value.deleted'),
    ('records.merged'),
    ('records.merged.fields'),
    ('membership.deleted'),
    -- PLATFORM_AUDIT_ACTIONS, in catalogue order.
    ('organisation.created'),
    ('organisation.updated'),
    ('membership.accepted'),
    ('document_uploaded'),
    ('document_downloaded'),
    ('document_deleted'),
    ('document_quarantined'),
    ('network_profile.published'),
    ('network_profile.unpublished'),
    ('network_profile.visibility_changed'),
    ('network_connection.requested'),
    ('network_connection.accepted'),
    ('network_connection.declined'),
    ('network_connection.withdrawn'),
    ('network_connection.updated'),
    ('audit_log.viewed'),
    ('impersonation.requested'),
    ('impersonation.accepted'),
    ('impersonation.declined'),
    ('impersonation.started'),
    ('impersonation.page_viewed'),
    ('impersonation.ended'),
    ('impersonation.expired'),
    ('organisation.suspended'),
    ('organisation.deleted'),
    ('organisation.reinstated'),
    ('organisation.closed_by_owner'),
    ('organisation.closure_reassigned'),
    ('organisation.closure_deleted'),
    ('organisation.closure_candidates_viewed'),
    ('organisation.billing_override_granted'),
    ('organisation.billing_override_revoked'),
    ('organisation.feature_override_granted'),
    ('organisation.feature_override_revoked'),
    ('platform_health.viewed'),
    ('incident_alert.resolved'),
    ('incident_alert.reopened'),
    ('feedback.submitted'),
    ('feedback.status_changed'),
    ('feedback.screenshot_viewed'),
    ('legal_document.draft_created'),
    ('legal_document.draft_updated'),
    ('legal_document.published'),
    ('legal_document.counsel_review_recorded'),
    ('consent.granted'),
    ('consent.withdrawn'),
    ('data_subject_request.submitted'),
    ('data_subject_request.in_progress'),
    ('data_subject_request.routed'),
    ('data_subject_request.fulfilled'),
    ('data_subject_request.rejected'),
    ('data_subject_request.withdrawn'),
    ('data_subject_request.fulfilment_recorded'),
    ('data_subject_request.note_added'),
    ('data_subject_request.rerouted'),
    ('export_job.requested'),
    ('export_job.downloaded'),
    ('erasure_job.requested'),
    ('account.erased'),
    ('organisation.erased'),
    ('retention_settings.changed'),
    ('retention.swept'),
    ('retention.audit_ceiling_released'),
    ('integration.connected'),
    ('integration.revoked'),
    ('integration.token_stored'),
    ('integration.sync_failed'),
    -- Invoices part 1 (20261107000000; written by Tasks 5, 6, 7, 10, 11).
    ('invoice.issued'),
    ('invoice.sent'),
    ('invoice.marked_paid'),
    ('invoice.voided'),
    ('invoice.pdf_downloaded'),
    ('invoice_settings.changed'),
    ('invoice_settings.bank_details_changed'),
    -- Invoices part 2 (20261110000000; written by Tasks 3 and 4).
    ('invoice.paid_by_card'),
    ('invoice.card_payment_conflict'),
    ('invoice.card_refund_flagged'),
    ('invoice_stripe_account.linked'),
    ('invoice_stripe_account.ended')
$function$;


-- (b) The retention roll: four `cascades`, one `platform_reference` (the class
--     subscription_plans carries).
--     Latest defining migration: 20261109000000_retention_roll_carries_invoices.sql.
CREATE OR REPLACE FUNCTION private.retention_subjects()
 RETURNS TABLE(table_name text, treatment text, class text, reason text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- ---- swept, each by a named class ------------------------------------
    ('audit_events',        'swept', 'audit_total',
     'private.purge_audit_events(), the one sweep that destroys evidence. Hard floor, sanity ceiling, dry run, counts either side.'),
    ('feedback',            'swept', 'feedback',
     'private.sweep_feedback(): the row and its feedback-screenshots object (Q120).'),
    ('rate_limit_counters', 'swept', 'rate_limit_counter',
     'private.sweep_rate_limit_counters(): closed windows nobody came back to (Q110).'),
    ('incident_alerts',     'swept', 'incident_alert',
     'private.sweep_incident_alerts(): RESOLVED alerts only; an open one is never purged at any age (Q117).'),
    ('erasure_jobs',        'swept', 'erasure_job_failed',
     'private.sweep_erasure_jobs(): FAILED rows only. A succeeded row is pseudonymous and is kept for ever as the proof (Q175).'),
    ('export_jobs',         'swept', 'stuck_job',
     'private.reap_stuck_jobs(): a row left `running` is failed, not deleted, so the one-live-job index stops blocking the subject (Q166). The archive bytes are purged by the retention runner from public.retention_object_manifest() (expiry and orphans).'),
    ('documents',           'swept', 'operational',
     'private.sweep_document_bytes(): the BYTES of a soft-deleted document, once its parent record''s class has run out (Q52). The row survives -- see the column comment on documents.bytes_purged_at.'),
    ('organisations',       'swept', 'workspace',
     'private.sweep_expired_workspaces() -> private.erase_organisation(): 60 days after suspension or closure (Q88/Q92/Q102). Everything classified `cascades` below goes with it.'),

    -- ---- goes with its parent --------------------------------------------
    ('export_job_parts',            'cascades', null, 'FK to public.export_jobs, ON DELETE CASCADE: a part row goes with its job. Its OBJECT is named by public.retention_object_manifest() on expiry, and is an orphan once its job is failed or gone.'),
    ('document_links',              'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE.'),
    ('document_versions',           'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE. Dormant (SELECT-only, no write path) until Release 1.1.'),
    ('data_subject_request_notes',  'cascades', null, 'FK to public.data_subject_requests, ON DELETE CASCADE.'),
    ('organisation_memberships',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_subscriptions',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_billing_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_feature_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_values',         'cascades', null,
     'FK to public.organisations cascades, AND private.sweep_custom_field_values() runs first for the polymorphic half no foreign key protects (20260930002000).'),
    ('impersonation_sessions',      'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('event_status_changes',        'cascades', null, 'Composite FK to public.events, ON DELETE CASCADE.'),
    ('artist_fee_history',          'cascades', null, 'Composite FK to public.artists, ON DELETE CASCADE.'),
    ('contact_companies',           'cascades', null, 'Composite FKs to public.contacts and public.companies, ON DELETE CASCADE.'),
    ('artist_representations',      'cascades', null, 'Composite FKs to public.artists and public.agencies, ON DELETE CASCADE.'),
    ('event_lineup',                'cascades', null, 'Composite FKs to public.events and public.artists, ON DELETE CASCADE.'),
    ('task_links',                  'cascades', null, 'Composite FK to public.tasks, ON DELETE CASCADE.'),
    ('meeting_links',               'cascades', null, 'Composite FK to public.meetings, ON DELETE CASCADE.'),
    ('note_links',                  'cascades', null, 'Composite FK to public.notes, ON DELETE CASCADE.'),
    ('network_links',               'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('network_connection_requests', 'cascades', null, 'FKs to public.organisations, ON DELETE CASCADE.'),
    ('network_profiles',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_definitions',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('merges',                      'cascades', null,
     'FK to public.organisations, ON DELETE CASCADE -- and field_resolution is scrubbed first, because it holds the discarded record''s values verbatim.'),
    ('merge_candidates',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),

    -- ---- tenant records: retained with their workspace (Q180) -------------
    ('contacts',          'retained_with_workspace', null, 'A soft-deleted CRM record stays readable to its workspace. Q180 asks whether it should expire on its own.'),
    ('companies',         'retained_with_workspace', null, 'See contacts.'),
    ('artists',           'retained_with_workspace', null, 'See contacts.'),
    ('agencies',          'retained_with_workspace', null, 'See contacts.'),
    ('venues',            'retained_with_workspace', null, 'See contacts.'),
    ('venue_rooms',       'retained_with_workspace', null, 'See contacts.'),
    ('events',            'retained_with_workspace', null, 'See contacts.'),
    ('tasks',             'retained_with_workspace', null, 'See contacts.'),
    ('meetings',          'retained_with_workspace', null, 'See contacts.'),
    ('notes',             'retained_with_workspace', null, 'See contacts.'),
    ('financial_entries', 'retained_with_workspace', null,
     'And the LONGEST class if Q180 is ever taken: seven years, not two. A financial entry is the thing CLAUDE.md''s "7 years for financial records" is about.'),

    -- ---- the person's own records ----------------------------------------
    ('consents',              'never_purged', null,
     'A consent record is the evidence of a lawful basis (UK GDPR Art 7(1)); deleting it destroys the proof that processing was lawful. It goes with the ACCOUNT, in private.erase_account(), and on no clock of its own (Q173).'),
    ('data_subject_requests', 'never_purged', null,
     'The statutory register: the evidence that a request was answered inside 30 days. It SURVIVES the erasure it answered, anonymised (Q173), and is on no clock.'),
    ('profiles',              'cascades', null, 'FK to auth.users, ON DELETE CASCADE -- and private.erase_account() is what makes that happen.'),

    -- ---- the retention job's own bookkeeping (added in 20261003002000) ---
    ('retention_runs',     'never_purged', null,
     'The run log itself. It is the evidence of what the garbage collector deleted and when, and a garbage collector that garbage-collects its own record of what it deleted is the one thing on this list that must not exist. Counts only -- the table has no column that could hold a record -- so it grows by one row per run and nothing else.'),
    ('retention_settings', 'platform_reference', null,
     'One enforced row: the two kill switches. Not a record about anybody.'),

    -- ---- the platform's own ----------------------------------------------
    ('legal_documents',  'never_purged', null,
     'A PUBLISHED legal version is immutable and permanent: it is what the product promised on a given date, and a consent points at it by version.'),
    ('platform_admins',  'platform_reference', null, 'Who the superuser is. One row.'),
    ('permissions',      'platform_reference', null, 'The permission catalogue.'),
    ('roles',            'platform_reference', null, 'The role catalogue.'),
    ('role_permissions', 'platform_reference', null, 'The role/permission matrix.'),
    ('subscription_plans',   'platform_reference', null, 'The tier catalogue.'),
    ('rate_limit_policies',  'platform_reference', null, 'The rate-limit budgets. The COUNTERS are swept; the policies are the catalogue.'),

    -- ---- the notice ledger (added in 20261016000000) ----------------------
    ('private.notification_deliveries', 'cascades', null,
     'One row per connection-request / task-reminder email accepted by Brevo: a notice name, a subject id and a time -- no address, no content. FKs to public.tasks and public.network_connection_requests, ON DELETE CASCADE: a stamp goes with the row it is about, and both of those go with their workspace.'),

    -- ---- the closure-backup marker (added in 20261027000000) -------------
    ('private.closure_backup_reads', 'ephemeral', null,
     'One row per transaction in which public.export_read_page() is reading a closure_backup job (20261025000000, Task 9c C1): a transaction id, the organisation id and the export job id -- no tenant data. Inserted and deleted inside that one call, on both its success and its failure path, so the table is empty at rest (rls_phase8_closure_backup.sql KA7/KM). Nothing to sweep; the FKs also cascade with the workspace and the job.'),

    -- ---- integrations (tables 20261030000000; classes 20261030003000) ---
    ('integration_connections', 'swept', 'integration_connection_revoked',
     'private.sweep_integration_records(): a REVOKED connection, once its class has run from revocation; its token went when it was revoked. A live one goes with its workspace (erase_organisation step 5c deletes the Vault secrets first) or, person-scoped, with its owner''s account (erase_account step 5c) or membership (the membership trigger revokes it).'),
    ('integration_sync_runs',   'swept', 'integration_sync_run',
     'private.sweep_integration_records(): a FINISHED run, once its class has run. Also goes with its connection (composite FK, ON DELETE CASCADE) and its workspace.'),

    -- ---- the first proof of an address (added in 20261104000000) ---------
    ('private.address_first_proofs', 'cascades', null,
     'One row per account whose email address has been proved (Phase 10 Task 20, Q245): a user id, a time and whether the pre-proof password was kept -- no address, no content. FK to auth.users, ON DELETE CASCADE: it goes with the account, in private.erase_account(), and on no clock of its own.'),

    -- ---- step-up tokens (added in 20261108001000) -------------------------
    ('private.step_up_tokens', 'ephemeral', null,
     'One row per step-up the app''s server recorded (Phase 10 Task 6, G13): a user id, a purpose and three times -- no content. Valid five minutes; public.mint_step_up_token() deletes every expired row on each mint, so the table holds minutes of rows at rest. FK to auth.users, ON DELETE CASCADE: it goes with the account.'),

    -- ---- invoices (added in 20261107000000; plan decision 8, Q252) -------
    ('invoices', 'cascades', null,
     'FK to public.organisations, ON DELETE CASCADE. A financial record: a draft is soft-deleted, and an issued, paid or void invoice is never deleted by its workspace (private.invoices_freeze() refuses it), so it lives exactly as long as the workspace. The seven-year financial class applies to it if Q180 is ever taken, as it does to financial_entries (Q252).'),
    ('invoice_lines',    'cascades', null, 'Composite FK to public.invoices, ON DELETE CASCADE.'),
    ('invoice_sends',    'cascades', null, 'Composite FK to public.invoices, ON DELETE CASCADE: the send log goes with its invoice.'),
    ('invoice_settings', 'cascades', null, 'FK to public.organisations, ON DELETE CASCADE: one row of configuration per workspace.'),
    ('invoice_stripe_accounts', 'cascades', null, 'FK to public.organisations, ON DELETE CASCADE: the workspace''s link to its Stripe account.'),
    ('invoice_card_payments',   'cascades', null, 'Composite FK to public.invoices, ON DELETE CASCADE: a card payment record lives as long as its invoice.'),
    ('invoice_pay_sessions',    'cascades', null, 'Composite FK to public.invoices, ON DELETE CASCADE: counts Checkout Sessions for the 20-per-hour limit.'),
    ('stripe_events',           'cascades', null, 'FK to public.organisations, ON DELETE CASCADE: the webhook idempotency ledger, ids only (plan decision 5).'),
    ('stripe_platform_settings','platform_reference', null, 'One row: the application fee in basis points (Q279).'),
    ('private.stripe_link_states', 'cascades', null, 'FKs to public.organisations and auth.users, both ON DELETE CASCADE: the SHA-256 of an OAuth state bound to its user and workspace, a 10-minute expiry, no Stripe identifier and no tenant content. It goes with its workspace or its account.')
$function$;

-- (c) The export catalogue: the account row and the card payments go with the
--     workspace export; the Checkout-session counter and the webhook event
--     ledger are excused. Latest defining migration: 20261107000000_invoice_tables.sql.
CREATE OR REPLACE FUNCTION private.export_catalogue()
 RETURNS TABLE(export_kind text, table_name text, disposition text, reason text, authorisation text, scope_columns text[], key_column text, projection text[])
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
values
  -- =====================================================================
  -- WORKSPACE EXPORT. The customer is the controller; we are the
  -- processor. Every read is `requester_rls`, without exception -- which
  -- is what makes "an Owner's export contains no other member's private
  -- note" true by construction rather than by a rule this file would
  -- otherwise have had to restate and get wrong.
  -- =====================================================================
  ('workspace', 'organisations',                  'exported', null::text, 'requester_rls', array['id'],                    'id', null::text[]),
  ('workspace', 'organisation_memberships',       'exported', null,       'requester_rls', array['organisation_id'],       'id', null),
  ('workspace', 'organisation_subscriptions',     'exported', null,       'requester_rls', array['organisation_id'],       'id', null),
  ('workspace', 'organisation_billing_overrides', 'exported', null,       'requester_rls', array['organisation_id'],       'id', null),
  ('workspace', 'organisation_feature_overrides', 'exported', null,       'requester_rls', array['organisation_id'],       'id', null),
  ('workspace', 'impersonation_sessions',         'exported', null,       'requester_rls', array['target_organisation_id'],'id', null),

  ('workspace', 'companies',                'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'contacts',                 'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'contact_companies',        'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'agencies',                 'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'artists',                  'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'artist_representations',   'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'artist_fee_history',       'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'venues',                   'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'venue_rooms',              'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'custom_field_definitions', 'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'custom_field_values',      'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'merges',                   'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'merge_candidates',         'exported', null, 'requester_rls', array['organisation_id'], 'id', null),

  ('workspace', 'events',               'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'event_lineup',         'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'event_status_changes', 'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'tasks',                'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'meetings',             'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'notes',                'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'documents',            'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'document_versions',    'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'task_links',           'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'meeting_links',        'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'note_links',           'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'document_links',       'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'financial_entries',    'exported', null, 'requester_rls', array['organisation_id'], 'id', null),

  -- network_connection_requests SPANS TWO TENANTS. Both ends are named as
  -- scope columns, and the RLS policy behind the read is the same one the
  -- browser gets -- so "this side's view only" is not a filter this file
  -- invented and could get wrong.
  ('workspace', 'network_profiles',            'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'network_links',               'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'network_connection_requests', 'exported', null, 'requester_rls', array['from_organisation_id','to_organisation_id'], 'id', null),

  -- ---- EXCUSED, four of them, each for a stated reason -----------------
  ('workspace', 'audit_events', 'excused',
   'The platform security record, not the workspace''s own data: superuser-readable by policy (SECURITY.md section 7), with its own retention (30 days hot, 1 year archived), and handing an Owner a cross-member log of everything their colleagues did would create a surveillance surface the product deliberately does not have. A member''s OWN audit rows are in the ACCOUNT export, which is where they are that person''s data.',
   null, null, null, null),
  ('workspace', 'incident_alerts', 'excused',
   'Platform operations. An alert is GetSetPaid''s own signal that something crossed a threshold -- a rate limit, a quarantined upload, a missed statutory deadline -- addressed to the operator, and its details payload carries subject ids from outside this tenant. No member holds a read of it today.',
   null, null, null, null),
  ('workspace', 'feedback', 'excused',
   'Platform-scoped by design (CLAUDE.md, In-app feedback): no submitter can read any row, their own included (Q103), because RLS filters rows and not columns and status / notified_at / organisation_role are GetSetPaid''s rather than theirs. A person''s own submissions are in the ACCOUNT export.',
   null, null, null, null),
  ('workspace', 'export_jobs', 'excused',
   'The register of exports themselves. It is metadata about this feature rather than a record of the business, there is no cross-member read of it (an export of it would hold only the reader''s own jobs), and it necessarily contains the job building the archive -- a record of itself. The reader sees every one of their own on the export page, live.',
   null, null, null, null),
  ('workspace', 'erasure_jobs', 'excused',
   'The register of erasures. A workspace appears on it in exactly one way -- as the subject of its own 60-day purge (Q88/Q92) -- and a record that this workspace is scheduled to be destroyed is the platform''s operational state rather than one of the business''s records. The row holds no content of any kind: `summary` is CHECK-constrained to counts. Phase 8 Task 5 added it, and it is excused for the same reasons export_jobs is.',
   null, null, null, null),
  ('workspace', 'data_subject_requests', 'excused',
   'Another person''s statutory request. The workspace appears on it only as the organisation an operator ROUTED it to (Q160), and the row holds the requester''s identity, their own words and our handling of them -- none of which is the workspace''s data. The requester gets it in their own account export.',
   null, null, null, null),

  -- =====================================================================
  -- ACCOUNT EXPORT. GetSetPaid is the controller.
  -- =====================================================================
  -- PHASE 8 TASK 6. public.retention_settings carries `updated_by`, a uuid
  -- reference to auth.users, which is a row -> user path and therefore in
  -- scope for this census by construction -- it went red the moment the table
  -- existed (XC3), which is what the census is for. It is EXCUSED, and the
  -- reason is as plain as it gets: the row is the retention job's two kill
  -- switches, one per deployment, and "the platform superuser turned the
  -- audit purge off at 3am and said why" is the PLATFORM's operational state.
  -- It is not a record about the person whose id is in that column, and it is
  -- not a record about anybody else either.
  ('account', 'retention_settings', 'excused',
   'The retention job''s kill switches -- one row for the whole deployment, carrying which switches are on, when they were last changed, the operator''s reason and their user id. It is in this census only because that id is a reference to auth.users. It is the platform''s own operational state, not a record about the person who flipped the switch; the audit row for the change (retention_settings.changed) is where that act is recorded, and a superuser''s own audit rows are already in their account export.',
   null, null, null, null),

  ('account', 'profiles',                 'exported', null, 'requester_rls', array['id'],      'id', null),
  ('account', 'organisation_memberships', 'exported', null, 'requester_rls', array['user_id'], 'id', null),
  ('account', 'consents',                 'exported', null, 'requester_rls', array['user_id'], 'id', null),
  ('account', 'data_subject_requests',    'exported', null, 'requester_rls', array['user_id'], 'id', null),

  -- ---- ELEVATED, four of them. Each has NO client read this person could
  -- ---- use, so a requester_rls read would have returned ZERO ROWS and
  -- ---- every assertion about it would still have passed.
  ('account', 'audit_events', 'exported',
   'ELEVATED: public.audit_events is superuser-only by policy, so there is no session that could read these rows under RLS. Read as the definer, filtered to actor_user_id = the requester, and PROJECTED to identifiers, action and timestamps. before and after are withheld -- they carry the changed COLUMN NAMES and structural values of other people''s tenant records, which are not this person''s data and which no client role may read. The manifest records the withholding.',
   'elevated', array['actor_user_id'], 'id',
   array['id','organisation_id','actor_user_id','action','target_type','target_id','correlation_id','created_at']),
  ('account', 'feedback', 'exported',
   'ELEVATED: no submitter can read any feedback row, their own included (Q103), so there is no session that could read these under RLS. Read as the definer, filtered to user_id = the requester, and PROJECTED to what the person wrote and what we did with it. screenshot_key is withheld -- an opaque storage path is not portable data, and the bytes travel as a file in the archive instead -- as are the support-access attribution columns, which are the operator''s record of their own session.',
   'elevated', array['user_id'], 'id',
   array['id','organisation_id','category','message','route','user_agent','status','screenshot_scan_status','during_support_access','created_at']),
  ('account', 'platform_admins', 'exported',
   'ELEVATED: public.platform_admins has NO select policy for any client role, so nothing could read it under RLS. Two columns, both about the requester: that this account is the platform operator, and since when. Filtered to user_id = the requester. The projection names both columns rather than being null -- the whole row IS theirs, so it withholds nothing, and it is written out so that "every elevated row carries a projection" can be a machine-checked rule (private.export_catalogue_is_sound(), 20260928001000) instead of prose. A third column added to this table by a later phase therefore has to be looked at before it is exported.',
   'elevated', array['user_id'], 'user_id', array['user_id','created_at']),
  ('account', 'impersonation_sessions', 'exported',
   'ELEVATED: the workspace-admin read this rests on is a permission IN a workspace, so a person who has left that workspace would silently export nothing -- while the record of support access THEY consented to or refused stays their own act. Filtered to the two columns that name them as the decider; a session they neither accepted nor declined is not theirs and is not returned, and neither is a session in another workspace or one somebody else decided. PROJECTED to the columns describing that decision AND, since 20261009000000 (founder 2026-09-30, Q167 CHANGED), to the operator''s break-glass `reason` and `superuser_user_id`: a person who let GetSetPaid into their workspace, or refused to, is entitled to know why it was asked for and who asked. The operator''s identity is the account id recorded on the session -- the narrowest identifier the row holds; the manifest says what it denotes. No other column was added, and no other operator data (no profile, no email, no other session) is joined in. A CURRENT workspace admin can still read the whole row through impersonation_sessions_select_target_admin; the export is for the person who has LEFT, which is the case this row is elevated for in the first place.',
   'elevated', array['admin_accepted_by','declined_by'], 'id',
   array['id','target_organisation_id','superuser_user_id','reason','status','requested_at','admin_accepted_by','accepted_at','declined_by','declined_at','started_at','expires_at','ended_at']),

  -- ---- EXCUSED ---------------------------------------------------------
  ('account', 'erasure_jobs', 'excused',
   'The register of erasures -- metadata about the process rather than data about the person, and in practice unreachable: a SUCCEEDED account erasure has already deleted the account, so no export of that account can ever contain it. What it could hold is a QUEUED or FAILED job, and the person reads both of those on /account/erase, live, with the reason. It also names the OPERATOR as requested_by when an erasure was started on a statutory request (20260930005000), and a GetSetPaid staff identity on a job register is not this person''s data -- the argument the feedback row makes for its support-access attribution columns. (Q167 as CHANGED by the founder on 2026-09-30 puts the operator into the account export for BREAK-GLASS SESSIONS only, in the impersonation_sessions row; it is not a general rule that staff identities are exported.) Excused rather than projected, because everything left after that projection is already on their own page.',
   null, null, null, null),
  ('account', 'export_jobs', 'excused',
   'The register of exports themselves -- metadata about this feature rather than data about the person, and a record of itself: the job building the archive would be in it. Every one of their own jobs is on /account/exports, live, with its status, its counts and what it withheld.',
   null, null, null, null),
  ('account', 'data_subject_request_notes', 'excused',
   'The operator''s working notes on statutory requests (Q103). The requester has no read of them anywhere in the product -- they are a separate table with no own-rows policy precisely so that there is nothing for a page to decline to render -- and an export that included them would hand back exactly what that split exists to withhold. The only author is the operator.',
   null, null, null, null),
  ('account', 'legal_documents', 'excused',
   'The public legal pages. Every published version is world-readable at /legal/<slug> signed out; the only users it references are the operator who drafted, published or recorded counsel''s review of a version, and that authorship is already in this person''s exported audit rows.',
   null, null, null, null),

  -- ---- EXCUSED: twenty tables whose only reference to a person is an
  -- ---- ownership or attribution column on a WORKSPACE record. This is the
  -- ---- Q132 line and the whole reason there are two exports: the row is
  -- ---- the customer''s data, not the member''s. Each is in the WORKSPACE
  -- ---- export, where its controller can ask for it.
  ('account', 'agencies',                       'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'artists',                        'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'companies',                      'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'contacts',                       'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'documents',                      'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'events',                         'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'event_status_changes',           'excused', 'Workspace record; the account appears only as changed_by. In the workspace export.', null, null, null, null),
  ('account', 'financial_entries',              'excused', 'Workspace record; the account appears only as created_by. In the workspace export.', null, null, null, null),
  ('account', 'meetings',                       'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'merges',                         'excused', 'Workspace record; the account appears only as merged_by. In the workspace export.', null, null, null, null),
  ('account', 'merge_candidates',               'excused', 'Workspace record; the account appears only as resolved_by. In the workspace export.', null, null, null, null),
  ('account', 'network_connection_requests',    'excused', 'Workspace record; the account appears only as requested_by / responded_by, and the row spans two tenants. In the workspace export.', null, null, null, null),
  ('account', 'network_links',                  'excused', 'Workspace record; the account appears only as created_by. In the workspace export.', null, null, null, null),
  ('account', 'network_profiles',               'excused', 'Workspace record; the account appears only as created_by. In the workspace export.', null, null, null, null),
  ('account', 'notes',                          'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export -- where a PRIVATE note is still readable by its author alone, because that export runs under the requester''s own RLS.', null, null, null, null),
  ('account', 'organisation_billing_overrides', 'excused', 'Platform record about a WORKSPACE''s billing; the account appears only as granted_by / revoked_by, which is the operator. In the workspace export.', null, null, null, null),
  ('account', 'organisation_feature_overrides', 'excused', 'Platform record about a WORKSPACE''s feature flags; the account appears only as granted_by / revoked_by, which is the operator. In the workspace export.', null, null, null, null),
  ('account', 'tasks',                          'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'venues',                         'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'incident_alerts',                'excused', 'Platform operations; the account appears only as resolved_by, which is the operator acting on GetSetPaid''s own signal. Excused from both exports.', null, null, null, null),
  -- =====================================================================
  -- PHASE 9 (tables 20261030000000; exported since 20261030003000).
  -- Connection METADATA -- provider, status, scopes, dates, who -- and
  -- the sync history. token_secret_id is PROJECTED OUT BY NAME: it is the
  -- id of a Vault secret, not portable data, and authenticated cannot
  -- select it anyway (20261030001000), so a projection that named it would
  -- make the read refuse rather than leak. The token itself is never a
  -- column. Both workspace reads are requester_rls like every other, so
  -- the export is exactly what the requester reads in the product: an
  -- Owner/Admin (manage_integrations) reads EVERY connection in the
  -- workspace, a colleague's person-scoped mailbox or calendar included --
  -- its metadata, never its token (rls_phase9_integrations.sql IR1a, IX4;
  -- whether that is right is founder question Q234, default as built).
  -- =====================================================================
  ('workspace', 'integration_connections', 'exported', null, 'requester_rls', array['organisation_id'], 'id',
   array['id','organisation_id','provider','owner_user_id','status','scopes','token_expires_at','last_synced_at','created_by','created_at','revoked_at','revoked_by']),
  ('workspace', 'integration_sync_runs',   'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  -- The ACCOUNT export carries the person's OWN person-scoped connections
  -- (owner_user_id = them), read under their own RLS, with the same
  -- projection. A workspace-scoped connection they merely created is the
  -- workspace's record (the Q132 line) and is in the workspace export.
  ('account',   'integration_connections', 'exported', null, 'requester_rls', array['owner_user_id'], 'id',
   array['id','organisation_id','provider','owner_user_id','status','scopes','token_expires_at','last_synced_at','created_by','created_at','revoked_at','revoked_by']),
  -- =====================================================================
  -- INVOICES (20261107000000). Read under the requester's own RLS like
  -- every other workspace table: an Owner, Admin or Finance member
  -- (view_finance) gets them, nobody else. invoice_settings is keyed on
  -- organisation_id, its primary key. The two tables that name a person
  -- are workspace records in the account export (the Q132 line).
  -- =====================================================================
  ('workspace', 'invoice_settings', 'exported', null, 'requester_rls', array['organisation_id'], 'organisation_id', null),
  ('workspace', 'invoices',         'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'invoice_lines',    'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'invoice_sends',    'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('account',   'invoices',      'excused', 'Workspace record; the account appears only as created_by, paid_by or voided_by. In the workspace export.', null, null, null, null),
  ('account',   'invoice_sends', 'excused', 'Workspace record; the account appears only as sent_by. In the workspace export.', null, null, null, null),
  -- =====================================================================
  -- INVOICES PART 2 (20261110000000). The workspace's Stripe link and the
  -- card payments received against its invoices are its own records, read
  -- under the requester's RLS (view_finance) like the invoices themselves.
  -- invoice_stripe_accounts is keyed on organisation_id; the account
  -- appears in it only as linked_by (a workspace record, the Q132 line).
  -- =====================================================================
  ('workspace', 'invoice_stripe_accounts', 'exported', null, 'requester_rls', array['organisation_id'], 'organisation_id', null),
  ('workspace', 'invoice_card_payments',   'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'invoice_pay_sessions', 'excused', 'Operational counter, ids only: one row per Checkout Session created, kept so the pay page can hold its 20-per-hour budget. It holds no record of the business, and no client role can read it.', null, null, null, null),
  ('workspace', 'stripe_events',        'excused', 'Webhook idempotency ledger, ids only: the Stripe event ids already processed. It holds no record of the business, and no client role can read it.', null, null, null, null),
  ('account',   'invoice_stripe_accounts', 'excused', 'Workspace record; the account appears only as linked_by. In the workspace export.', null, null, null, null)
$function$;


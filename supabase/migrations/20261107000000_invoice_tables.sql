-- ===========================================================================
-- INVOICES, PART 1 OF 3 -- TASK 3: THE FOUR TABLES.
-- Spec: docs/superpowers/specs/2026-10-20-invoices-design.md (founder 2026-10-20).
--
-- Four tenant-owned tables. RLS ON and FORCED; authenticated holds SELECT
-- only, anon and service_role nothing. EVERY WRITE IS A SECURITY DEFINER RPC
-- (Tasks 4-7, 10, 11) that re-checks manage_finance and the Pro entitlement --
-- stricter than the spec's "UPDATE only on draft rows" (plan decision 1), and
-- the reason none of the four is in the CRM audit-coverage census (it counts
-- client-writable tables only).
--
-- THE FREEZE: private.invoices_freeze() and private.invoice_lines_freeze()
-- refuse any row-level UPDATE or DELETE of an issued invoice's content from
-- every role, the table owner included. A hard delete is admitted only once
-- the parent public.organisations row is already gone: the workspace purge's
-- cascade (private.invoice_workspace_is_gone()). Being nested in some other
-- trigger admits nothing. All three are SECURITY DEFINER, so their lookups of
-- the invoice and the workspace read as the owner and RLS cannot blind them
-- into admitting a row. TRUNCATE fires no row trigger and is not frozen: no
-- role but the owner holds it (IT3, IT4).
--
-- Person references (created_by, paid_by, voided_by, sent_by) are NO ACTION
-- foreign keys to auth.users, so private.erase_account()'s derived re-point
-- walk (step 7) moves them to the tombstone; the freeze admits exactly that
-- re-point and nothing else.
--
-- Also here, because the catalogues refuse a table they do not name: the
-- seven audit actions the RPCs will write, the retention roll (all four
-- `cascades`, plan decision 8 / Q252), and the export catalogue.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. invoice_settings -- one row per workspace.
-- ---------------------------------------------------------------------------
create table public.invoice_settings (
  organisation_id uuid primary key references public.organisations (id) on delete cascade,
  business_name text check (business_name is null or char_length(business_name) between 1 and 200),
  business_address text check (business_address is null or char_length(business_address) between 1 and 500),
  -- Null = not VAT registered: every line is forced to 'none' and the PDF
  -- shows no VAT column (a non-registered business must not charge VAT).
  vat_number text check (vat_number is null
                         or vat_number ~ '^(GB|XI)([0-9]{9}|[0-9]{12}|GD[0-9]{3}|HA[0-9]{3})$'),
  bank_account_name text check (bank_account_name is null or char_length(bank_account_name) between 1 and 140),
  bank_sort_code text check (bank_sort_code is null or bank_sort_code ~ '^[0-9]{6}$'),
  bank_account_number text check (bank_account_number is null or bank_account_number ~ '^[0-9]{8}$'),
  number_prefix text not null default 'INV-' check (number_prefix ~ '^[A-Z0-9-]{0,12}$'),
  -- Advanced ONLY by public.issue_invoice(); no client role can write it.
  next_number integer not null default 1 check (next_number between 1 and 2147483646),
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoice_settings_bank_all_or_none
    check (num_nulls(bank_account_name, bank_sort_code, bank_account_number) in (0, 3))
);

comment on table public.invoice_settings is
  'One row per workspace: the seller block, bank details and numbering for its invoices (Invoices part 1). Read by view_finance; written only by public.save_invoice_settings() (step-up in the app; every bank change audited with the last four digits only and emailed to the Owners and Admins) and, for next_number, by public.issue_invoice().';

-- ---------------------------------------------------------------------------
-- 2. invoices
-- ---------------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'issued', 'paid', 'void')),
  -- Null while draft; prefix || sequence once issued. The shape is what lets
  -- the PDF route put it in a filename with no user text reaching it.
  number text constraint invoices_number_check
    check (number is null or number ~ '^[A-Z0-9-]{0,12}[0-9]{4,10}$'),
  recipient_company_id uuid,
  recipient_contact_id uuid,
  -- No CRM record has an address column (plan decision 2); HMRC requires one.
  recipient_address text check (recipient_address is null or char_length(recipient_address) between 1 and 500),
  event_id uuid,
  issue_date date,
  due_date date,
  supply_date date,
  currency text not null default 'GBP' check (currency = 'GBP'),
  net_minor bigint not null default 0 check (net_minor >= 0),
  vat_minor bigint not null default 0 check (vat_minor >= 0),
  gross_minor bigint not null default 0,
  snapshot jsonb check (snapshot is null or jsonb_typeof(snapshot) = 'object'),
  notes text check (notes is null or char_length(notes) <= 2000),
  paid_on date,
  paid_by uuid references auth.users (id),
  paid_entry_id uuid,
  voided_at timestamptz,
  voided_by uuid references auth.users (id),
  void_reason text check (void_reason is null or char_length(void_reason) between 1 and 500),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint invoices_gross_is_net_plus_vat check (gross_minor = net_minor + vat_minor),
  -- A draft may have no recipient yet (plan decision 3); never two.
  constraint invoices_at_most_one_recipient
    check (num_nonnulls(recipient_company_id, recipient_contact_id) <= 1),
  constraint invoices_issued_shape check (
    (status = 'draft') = (number is null)
    and (status = 'draft') = (snapshot is null)
    and (status = 'draft') = (issue_date is null)
    and (status = 'draft') = (due_date is null)
    and (status = 'draft'
         or (supply_date is not null
             and recipient_address is not null
             and num_nonnulls(recipient_company_id, recipient_contact_id) = 1
             and deleted_at is null))),
  constraint invoices_paid_shape check (
    (paid_on is null) = (paid_by is null)
    and (status <> 'paid' or paid_on is not null)
    and (status in ('paid', 'void') or (paid_on is null and paid_entry_id is null))),
  constraint invoices_void_shape check (
    (status = 'void') = (voided_at is not null)
    and (status = 'void') = (voided_by is not null)
    and (status = 'void') = (void_reason is not null)),
  constraint invoices_id_org_unique unique (id, organisation_id),
  constraint invoices_number_unique unique (organisation_id, number)
);

-- Tenant-scoped composite FKs, NO ACTION: none of these parents is ever hard
-- deleted except with the whole workspace, inside the same statement.
alter table public.invoices
  add constraint invoices_recipient_company_fkey
    foreign key (recipient_company_id, organisation_id) references public.companies (id, organisation_id),
  add constraint invoices_recipient_contact_fkey
    foreign key (recipient_contact_id, organisation_id) references public.contacts (id, organisation_id),
  add constraint invoices_event_fkey
    foreign key (event_id, organisation_id) references public.events (id, organisation_id),
  add constraint invoices_paid_entry_fkey
    foreign key (paid_entry_id, organisation_id) references public.financial_entries (id, organisation_id);

comment on table public.invoices is
  'An invoice (Invoices part 1): draft -> issued -> paid, and issued/paid -> void. Tenant-private, never read by a network view. Read by view_finance (not tier-gated: a downgrade leaves invoices readable); written only by the SECURITY DEFINER RPCs, which require manage_finance AND the Pro entitlement. Once issued its content is frozen for every role by private.invoices_freeze(); the PDF is rendered only from snapshot.';
comment on column public.invoices.paid_entry_id is
  'The actual income financial_entries row public.mark_invoice_paid() created for the lines with no financial_entry_id (net of VAT), so public.void_invoice() can soft-delete exactly that row.';

-- ---------------------------------------------------------------------------
-- 3. invoice_lines
-- ---------------------------------------------------------------------------
create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  invoice_id uuid not null,
  position integer not null check (position between 1 and 100),
  description text not null check (char_length(description) between 1 and 500),
  quantity numeric(12,2) not null check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  vat_rate text not null check (vat_rate in ('standard_20', 'reduced_5', 'zero', 'exempt', 'none')),
  net_minor bigint not null check (net_minor >= 0),
  vat_minor bigint not null check (vat_minor >= 0),
  financial_entry_id uuid,
  -- Set by public.mark_invoice_paid() when it flipped this line's entry from
  -- budgeted to actual, so public.void_invoice() reverses exactly those.
  entry_flipped boolean not null default false,
  created_at timestamptz not null default now(),
  constraint invoice_lines_position_unique unique (invoice_id, position),
  constraint invoice_lines_flip_needs_entry check (not entry_flipped or financial_entry_id is not null),
  constraint invoice_lines_invoice_fkey
    foreign key (invoice_id, organisation_id) references public.invoices (id, organisation_id) on delete cascade,
  constraint invoice_lines_entry_fkey
    foreign key (financial_entry_id, organisation_id) references public.financial_entries (id, organisation_id)
);

-- ---------------------------------------------------------------------------
-- 4. invoice_sends -- append-only: no client grant of any write, no UPDATE path.
-- ---------------------------------------------------------------------------
create table public.invoice_sends (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  invoice_id uuid not null,
  to_email text not null check (char_length(to_email) between 3 and 254 and to_email ~ '^[^\s@]+@[^\s@.]+\.[^\s@]+$'),
  sent_by uuid not null references auth.users (id),
  sent_at timestamptz not null default now(),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 200),
  constraint invoice_sends_invoice_fkey
    foreign key (invoice_id, organisation_id) references public.invoices (id, organisation_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 5. Indexes: every FK's leading column (schema_invariants D3) and the list.
-- ---------------------------------------------------------------------------
create index invoices_organisation_id_idx          on public.invoices (organisation_id);
create index invoices_recipient_company_id_org_idx on public.invoices (recipient_company_id, organisation_id);
create index invoices_recipient_contact_id_org_idx on public.invoices (recipient_contact_id, organisation_id);
create index invoices_event_id_org_idx             on public.invoices (event_id, organisation_id);
create index invoices_paid_entry_id_org_idx        on public.invoices (paid_entry_id, organisation_id);
create index invoices_paid_by_idx                  on public.invoices (paid_by);
create index invoices_voided_by_idx                on public.invoices (voided_by);
create index invoices_created_by_idx               on public.invoices (created_by);
create index invoices_org_created_id_idx
  on public.invoices (organisation_id, created_at, id) include (status) where deleted_at is null;
comment on index public.invoices_org_created_id_idx is
  'Covers the invoices list''s default sort (created_at desc) and keyset range, live rows only. lib/invoices/list.ts''s INVOICE_LIST.backedBy names this index.';
create index invoice_lines_organisation_id_idx     on public.invoice_lines (organisation_id);
create index invoice_lines_entry_id_org_idx        on public.invoice_lines (financial_entry_id, organisation_id);
create index invoice_sends_organisation_id_idx     on public.invoice_sends (organisation_id);
create index invoice_sends_invoice_id_org_idx      on public.invoice_sends (invoice_id, organisation_id);
create index invoice_sends_sent_by_idx             on public.invoice_sends (sent_by);

-- ---------------------------------------------------------------------------
-- 6. updated_at, by hand, named set_updated_at (rls_phase2_crm.sql L5/L6).
--    invoice_lines and invoice_sends have no updated_at: a line is replaced,
--    never edited; a send is written once.
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.invoice_settings
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();
create trigger set_updated_at before update on public.invoices
  for each row when (old.* is distinct from new.*) execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. THE FREEZE.
-- ---------------------------------------------------------------------------
-- The purge test, alone in its own function: the retention clock walk
-- (private.retention_clock_candidates) follows every private function a
-- retention function names, and a freeze body naming public.organisations
-- beside the word updated_at halts the sweep as undeclared_retention_clock.
create or replace function private.invoice_workspace_is_gone(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.organisations o where o.id = p_organisation_id)
$$;
revoke all on function private.invoice_workspace_is_gone(uuid) from public, anon, authenticated, service_role;

create or replace function private.invoices_freeze()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The columns a non-draft row may still change, each only in its own
  -- transition (checked below). Everything else is frozen at issue.
  v_moving constant text[] := array['status', 'paid_on', 'paid_by', 'paid_entry_id',
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
    if (new.paid_on, new.paid_entry_id, new.voided_at, new.void_reason)
         is distinct from (old.paid_on, old.paid_entry_id, old.voided_at, old.void_reason)
       or (old.paid_by is null and new.paid_by is not null)
       or (old.voided_by is null and new.voided_by is not null) then
      raise exception 'invoices: an issued invoice''s content is frozen'
        using errcode = '42501', hint = 'invoice_is_frozen';
    end if;
  elsif old.status = 'issued' and new.status = 'paid' then
    null;  -- the paid columns are set here; invoices_paid_shape holds their shape
  elsif old.status in ('issued', 'paid') and new.status = 'void' then
    if (new.paid_on, new.paid_by, new.paid_entry_id)
         is distinct from (old.paid_on, old.paid_by, old.paid_entry_id) then
      raise exception 'invoices: voiding keeps the payment record as it was'
        using errcode = '42501', hint = 'invoice_is_frozen';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.invoices_freeze() from public, anon, authenticated, service_role;

create trigger invoices_freeze before update or delete on public.invoices
  for each row execute function private.invoices_freeze();

create or replace function private.invoice_lines_freeze()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE' and new.invoice_id is distinct from old.invoice_id then
    raise exception 'invoice_lines: a line never moves between invoices'
      using errcode = '42501', hint = 'invoice_is_frozen';
  end if;

  if tg_op = 'INSERT' then
    select i.status into v_status from public.invoices i where i.id = new.invoice_id;
  else
    select i.status into v_status from public.invoices i where i.id = old.invoice_id;
  end if;

  -- Null: the invoice is gone (read as definer, so never merely invisible):
  -- a delete cascading from a draft or the purge, or an INSERT the composite
  -- FK refuses next.
  if v_status is null or v_status = 'draft' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  -- The workspace purge's cascade: the workspace row is already gone.
  if tg_op = 'DELETE' and private.invoice_workspace_is_gone(old.organisation_id) then
    return old;
  end if;
  -- public.mark_invoice_paid() records which entries it flipped, and nothing else.
  if tg_op = 'UPDATE'
     and (pg_catalog.to_jsonb(new) - 'entry_flipped') = (pg_catalog.to_jsonb(old) - 'entry_flipped') then
    return new;
  end if;
  raise exception 'invoice_lines: the invoice is % and its lines are frozen', v_status
    using errcode = '42501', hint = 'invoice_is_frozen';
end;
$$;
revoke all on function private.invoice_lines_freeze() from public, anon, authenticated, service_role;

create trigger invoice_lines_freeze before insert or update or delete on public.invoice_lines
  for each row execute function private.invoice_lines_freeze();

-- ---------------------------------------------------------------------------
-- 8. THE ARITHMETIC (spec § Arithmetic), THE NUMBER, THE SNAPSHOT.
--    lib/invoices/arithmetic.ts is the TypeScript port; one case table binds
--    them (rls_invoices.sql § IA, tests/unit/invoices/arithmetic-cases.ts).
-- ---------------------------------------------------------------------------
create or replace function private.invoice_line_amounts(
  p_quantity numeric, p_unit_price_minor bigint, p_vat_rate text)
returns table (net_minor bigint, vat_minor bigint)
language sql
immutable
set search_path = ''
as $$
  -- round(numeric) is half away from zero; every value here is >= 0, so half up.
  select s.net,
         pg_catalog.round(s.net * case p_vat_rate when 'standard_20' then 0.20
                                                  when 'reduced_5'   then 0.05
                                                  else 0 end)::bigint
    from (select pg_catalog.round(p_quantity * p_unit_price_minor)::bigint as net) s
$$;
revoke all on function private.invoice_line_amounts(numeric, bigint, text) from public, anon, authenticated, service_role;

create or replace function private.format_invoice_number(p_prefix text, p_n integer)
returns text
language sql
immutable
set search_path = ''
as $$
  -- lpad() TRUNCATES past its width (plan decision 11): pad below 10 000 only.
  select p_prefix || case when p_n < 10000 then pg_catalog.lpad(p_n::text, 4, '0') else p_n::text end
$$;
revoke all on function private.format_invoice_number(text, integer) from public, anon, authenticated, service_role;

-- The frozen copy (spec § Data model, snapshot): seller block from
-- invoice_settings, recipient block from the CRM record plus the typed
-- address, the lines and the totals. lib/invoices/snapshot.ts parses it.
create or replace function private.build_invoice_snapshot(
  p_invoice_id uuid, p_number text, p_issue date, p_supply date, p_due date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
           'version', 1,
           'number', p_number,
           'issue_date', p_issue,
           'supply_date', p_supply,
           'due_date', p_due,
           'currency', i.currency,
           'seller', pg_catalog.jsonb_build_object(
             'name', s.business_name,
             'address', s.business_address,
             'vat_number', s.vat_number,
             'bank', case when s.bank_account_number is null then null
                          else pg_catalog.jsonb_build_object(
                                 'account_name', s.bank_account_name,
                                 'sort_code', s.bank_sort_code,
                                 'account_number', s.bank_account_number) end),
           'recipient', pg_catalog.jsonb_build_object(
             'kind', case when i.recipient_company_id is not null then 'company' else 'contact' end,
             'name', coalesce(co.name, ct.name),
             'address', i.recipient_address,
             'email', ct.email),
           'lines', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                       'position', l.position,
                                       'description', l.description,
                                       'quantity', l.quantity::text,
                                       'unit_price_minor', l.unit_price_minor,
                                       'vat_rate', l.vat_rate,
                                       'net_minor', l.net_minor,
                                       'vat_minor', l.vat_minor) order by l.position)
                                from public.invoice_lines l where l.invoice_id = i.id), '[]'::jsonb),
           'totals', pg_catalog.jsonb_build_object(
             'net_minor', t.net, 'vat_minor', t.vat, 'gross_minor', t.net + t.vat),
           'notes', i.notes)
    from public.invoices i
    join public.invoice_settings s on s.organisation_id = i.organisation_id
    left join public.companies co
      on co.id = i.recipient_company_id and co.organisation_id = i.organisation_id
    left join public.contacts ct
      on ct.id = i.recipient_contact_id and ct.organisation_id = i.organisation_id
    cross join lateral (
      select coalesce(sum(l.net_minor), 0)::bigint as net, coalesce(sum(l.vat_minor), 0)::bigint as vat
        from public.invoice_lines l where l.invoice_id = i.id) t
   where i.id = p_invoice_id
$$;
revoke all on function private.build_invoice_snapshot(uuid, text, date, date, date) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. RLS, grants, policies. Reads are NOT tier-gated (a downgrade leaves the
--    invoices readable, spec § Permissions); view_finance folds in aal2,
--    suspension and the closure-backup read through permitted_organisations().
-- ---------------------------------------------------------------------------
alter table public.invoice_settings enable row level security;
alter table public.invoice_settings force row level security;
alter table public.invoices         enable row level security;
alter table public.invoices         force row level security;
alter table public.invoice_lines    enable row level security;
alter table public.invoice_lines    force row level security;
alter table public.invoice_sends    enable row level security;
alter table public.invoice_sends    force row level security;

revoke all on public.invoice_settings from public, anon, authenticated, service_role;
revoke all on public.invoices         from public, anon, authenticated, service_role;
revoke all on public.invoice_lines    from public, anon, authenticated, service_role;
revoke all on public.invoice_sends    from public, anon, authenticated, service_role;
grant select on public.invoice_settings, public.invoices, public.invoice_lines, public.invoice_sends to authenticated;

create policy invoice_settings_select_view_finance on public.invoice_settings
  for select to authenticated
  using (organisation_id in (select private.permitted_organisations('view_finance')));
create policy invoices_select_view_finance on public.invoices
  for select to authenticated
  using (organisation_id in (select private.permitted_organisations('view_finance')));
create policy invoice_lines_select_view_finance on public.invoice_lines
  for select to authenticated
  using (organisation_id in (select private.permitted_organisations('view_finance')));
create policy invoice_sends_select_view_finance on public.invoice_sends
  for select to authenticated
  using (organisation_id in (select private.permitted_organisations('view_finance')));

-- ---------------------------------------------------------------------------
-- 10. THE CATALOGUES, rebuilt from their live pg_get_functiondef (each diffed
--     identical to its latest defining migration first) with only the
--     invoice rows added.
-- ---------------------------------------------------------------------------

-- (a) The audit catalogue: the seven actions Tasks 5, 6, 7, 10 and 11 write.
--     Latest defining migration: 20261031000000_organisation_edits_are_audited.sql.
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
    ('invoice_settings.bank_details_changed')
$function$;

-- (b) The retention roll: all four `cascades` (plan decision 8, Q252).
--     Latest defining migration: 20261104000000_first_proof_of_an_address.sql.
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

    -- ---- invoices (added in 20261107000000; plan decision 8, Q252) -------
    ('invoices', 'cascades', null,
     'FK to public.organisations, ON DELETE CASCADE. A financial record: a draft is soft-deleted, and an issued, paid or void invoice is never deleted by its workspace (private.invoices_freeze() refuses it), so it lives exactly as long as the workspace. The seven-year financial class applies to it if Q180 is ever taken, as it does to financial_entries (Q252).'),
    ('invoice_lines',    'cascades', null, 'Composite FK to public.invoices, ON DELETE CASCADE.'),
    ('invoice_sends',    'cascades', null, 'Composite FK to public.invoices, ON DELETE CASCADE: the send log goes with its invoice.'),
    ('invoice_settings', 'cascades', null, 'FK to public.organisations, ON DELETE CASCADE: one row of configuration per workspace.')
$function$;

-- (c) The export catalogue.
--     Latest defining migration: 20261030003000_integrations_in_the_privacy_lifecycle.sql.
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
  ('account',   'invoice_sends', 'excused', 'Workspace record; the account appears only as sent_by. In the workspace export.', null, null, null, null)
$function$;

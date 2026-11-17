-- ===========================================================================
-- INVOICES PART 3 -- TASK 1: invoice_deliveries, ITS BUDGET, AND THE
-- CATALOGUES (spec docs/superpowers/specs/2026-11-13-invoices-network-delivery-design.md).
-- TWO-TENANT, like network_connection_requests: the sender's invoice, the
-- receiver's inbox entry. No client role writes it (Task 2's two RPCs do),
-- and only the SENDER reads it; the receiver reads public.received_invoices
-- (Task 3). It stores no link id and no profile id (Q82): which private
-- record the sender linked is not the receiver's to learn.
-- ===========================================================================

create table public.invoice_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  invoice_id           uuid not null,
  from_organisation_id uuid not null,
  to_organisation_id   uuid not null references public.organisations (id) on delete cascade,
  delivered_by         uuid references auth.users (id) on delete set null,
  delivered_at         timestamptz not null default pg_catalog.now(),
  withdrawn_at         timestamptz,
  withdrawn_by         uuid references auth.users (id) on delete set null,
  constraint invoice_deliveries_invoice_fkey
    foreign key (invoice_id, from_organisation_id) references public.invoices (id, organisation_id) on delete cascade,
  constraint invoice_deliveries_not_to_self check (from_organisation_id <> to_organisation_id),
  constraint invoice_deliveries_withdrawn_pair check (withdrawn_by is null or withdrawn_at is not null)
);

create unique index invoice_deliveries_live_unique
  on public.invoice_deliveries (invoice_id, to_organisation_id) where withdrawn_at is null;
create index invoice_deliveries_from_org_idx  on public.invoice_deliveries (from_organisation_id);
create index invoice_deliveries_to_org_list_idx
  on public.invoice_deliveries (to_organisation_id, delivered_at, id) where withdrawn_at is null;
create index invoice_deliveries_delivered_by_idx on public.invoice_deliveries (delivered_by);
create index invoice_deliveries_withdrawn_by_idx on public.invoice_deliveries (withdrawn_by);

alter table public.invoice_deliveries enable row level security;
-- The SENDER's side only. The receiver never reads this table.
create policy invoice_deliveries_select on public.invoice_deliveries for select to authenticated
  using (from_organisation_id in (select private.permitted_organisations('view_finance')));
revoke all on public.invoice_deliveries from public, anon, authenticated, service_role;
grant select on public.invoice_deliveries to authenticated;

comment on table public.invoice_deliveries is
  'Invoices part 3: one row per delivery of an issued or paid invoice into a connected workspace''s inbox. Two-tenant (from_organisation_id is the sender, to_organisation_id the receiver), like network_connection_requests. Written only by public.deliver_invoice and public.withdraw_invoice_delivery; read by the sender''s view_finance holders; the receiver reads public.received_invoices and never this table. Holds no link id and no network profile id (Q82).';

-- ---------------------------------------------------------------------------
-- THE BUDGET: 30 deliveries per user per hour, enforced AT THE WRITE by a
-- BEFORE INSERT trigger so it holds for every writer (Task 2's RPC is the only
-- one today). A copy of private.meter_connection_request() (20260909060000)
-- with three changes: the category, the subject (the USER, not the
-- organisation) and the authorisation it meters after (manage_finance).
-- Read-before-write so a refusal has nothing to roll back, PT429 with the
-- remaining seconds in `hint`, no counting past the limit (Q115). Exempts a
-- sessionless writer (auth.uid() is null: a migration, a seed, a fixture).
-- ---------------------------------------------------------------------------
create or replace function private.meter_invoice_delivery()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_policy public.rate_limit_policies%rowtype;
  v_window timestamptz;
  v_count  integer;
  v_after  integer;
  v_retry  integer;
begin
  -- NOT A CLIENT SEND: a migration, a seed or a test fixture inserting as
  -- `postgres` has no session, spends nobody's budget and is not what this
  -- meters. The test is `auth.uid() is null`, the one
  -- private.audit_crm_row()/private.audit_network_row() use, and deliberately
  -- NOT row_security_active(): this function is SECURITY DEFINER (the limiter
  -- core is granted to no client role), so row_security_active() inside it is
  -- evaluated as the owner and is false for EVERY caller -- copying the
  -- invoker-side guard pattern here would make the meter a no-op.
  if (select auth.uid()) is null then
    return new;
  end if;

  select * into v_policy
  from public.rate_limit_policies p
  where p.category = 'invoice_delivery';
  if not found then
    -- FAIL CLOSED. A missing policy row is a broken deployment, not a licence
    -- to send without a budget.
    raise exception 'meter_invoice_delivery: no rate-limit policy for invoice_delivery'
      using errcode = '22023';
  end if;

  -- METER AFTER AUTHORISATION. If the actor could not have delivered this
  -- anyway (no manage_finance in the sender), Task 2's RPC refuses it and no
  -- budget is spent: a stranger cannot burn a victim workspace's budget.
  if new.from_organisation_id is null
     or new.from_organisation_id not in (
          select private.permitted_organisations('manage_finance')) then
    return new;
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  -- `greatest` is a parser construct, not a pg_catalog function, so it is
  -- deliberately unqualified even under `search_path = ''` -- the same way
  -- 20260909020000's core writes it.
  v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                  - pg_catalog.now())))::integer);

  select c.request_count into v_count
  from public.rate_limit_counters c
  where c.category      = 'invoice_delivery'
    and c.subject_scope = 'user'
    and c.subject_id    = (select auth.uid())
    and c.window_start  = v_window;
  v_count := coalesce(v_count, 0);

  -- (1) THE BUDGET IS ALREADY SPENT. Nothing written, so nothing is lost to
  -- the rollback this raise causes.
  if v_count >= v_policy.max_requests then
    raise exception 'invoice_deliveries: you have reached your invoice-delivery limit (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  -- (2) COUNT IT.
  select r.request_count into v_after
  from private.record_rate_limit_event(
         'invoice_delivery', 'user',
         (select auth.uid()), new.from_organisation_id) r;

  -- (2b) THE RACE. Two callers can both pass (1) at count = max - 1. The
  -- second one's own increment is what this rolls back.
  if v_after > v_policy.max_requests then
    raise exception 'invoice_deliveries: you have reached your invoice-delivery limit (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  -- (3) THE CROSSING ALERT, at the last accepted delivery: a refused INSERT
  -- cannot commit one, so it is filed here (as the connection-request meter does).
  if v_after = v_policy.max_requests then
    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values (
      'rate_limit_tripped',
      new.from_organisation_id,
      pg_catalog.format(
        'Rate limit reached: invoice_delivery (limit %s per %s seconds).',
        v_policy.max_requests, v_policy.window_seconds),
      pg_catalog.jsonb_build_object(
        'category',       'invoice_delivery',
        'subject_scope',  'user',
        'subject_id',     (select auth.uid()),
        'window_start',   v_window,
        'max_requests',   v_policy.max_requests,
        'window_seconds', v_policy.window_seconds,
        -- Distinguishes this path's semantics from every other category's:
        -- the count stops at the limit here, so it is not a pressure figure.
        'counts_refusals', false
      )
    );
  end if;

  return new;
end;
$$;

comment on function private.meter_invoice_delivery() is
  'Invoices part 3 (Q282): the 30-per-hour-per-user invoice-delivery budget, enforced AT THE WRITE. A copy of private.meter_connection_request() metered by user and after manage_finance: reads the current window before writing so a refusal has nothing to roll back, raises PT429 with the remaining seconds in `hint`, files the crossing alert at the LAST ACCEPTED delivery and never counts past the limit. Exempts sessionless writers (auth.uid() is null).';

insert into public.rate_limit_policies (category, subject_scope, max_requests, window_seconds, description)
values ('invoice_delivery', 'user', 30, 3600,
        'Invoices delivered into another workspace per user (Invoices part 3, Q282). Enforced at the write by private.meter_invoice_delivery(), modelled on the connection-request meter.');

create trigger meter_invoice_delivery
  before insert on public.invoice_deliveries
  for each row execute function private.meter_invoice_delivery();

revoke all on function private.meter_invoice_delivery() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- THE CATALOGUES. Each is rebuilt from its live definition (diffed identical
-- to its latest migration first); only the rows below are added.
-- ---------------------------------------------------------------------------
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
    ('invoice_stripe_account.ended'),
    ('invoice_stripe_account.charges_enabled_changed'),
    -- Invoices part 3 (20261117000000; written by Tasks 2 and 3).
    ('invoice.delivered'),
    ('invoice.delivery_withdrawn'),
    ('invoice.received_pdf_downloaded')
$function$;

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
    ('private.stripe_link_states', 'cascades', null, 'FKs to public.organisations and auth.users, both ON DELETE CASCADE: the SHA-256 of an OAuth state bound to its user and workspace, a 10-minute expiry, no Stripe identifier and no tenant content. It goes with its workspace or its account.'),
    ('invoice_deliveries', 'cascades', null, 'Composite FK to public.invoices, ON DELETE CASCADE: a delivery lives as long as the sender''s invoice (spec default 1: the receiver reads the sender''s snapshot, nothing is copied).')
$function$;

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
  ('account',   'invoice_stripe_accounts', 'excused', 'Workspace record; the account appears only as linked_by. In the workspace export.', null, null, null, null),
  -- INVOICES PART 3 (20261117000000). A delivery is the SENDER's record: it
  -- is read under the sender's RLS (view_finance) and appears in the sender's
  -- workspace export, keyed on from_organisation_id. The receiver reads the
  -- sender's snapshot through public.received_invoices, which is not an export.
  ('workspace', 'invoice_deliveries', 'exported', null, 'requester_rls', array['from_organisation_id'], 'id', null),
  ('account',   'invoice_deliveries', 'excused', 'Workspace record; the account appears only as delivered_by / withdrawn_by. In the SENDER''s workspace export (spec default 2).', null, null, null, null)
$function$;

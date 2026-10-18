-- Phase 10 Task 20 (Q245, Critical): A PASSWORD CHOSEN AFTER THE PROOF.
--
-- ===========================================================================
-- THE RESIDUAL THIS CLOSES (G11, measured on GoTrue v2.196.0 by Task 4)
-- ===========================================================================
-- GoTrue keeps the FIRST password on an unconfirmed re-sign-up, and confirming
-- does not replace it. So a squatter who signs up as somebody else's address
-- first owns the account its real owner later confirms -- by signing up over
-- it, by following the squatter's own confirmation email, by asking for an
-- emailed sign-in link (GoTrue sends a sign-up confirmation instead), or by
-- following a recovery email anybody can request.
--
-- The fix lives in app/auth/callback/route.ts and lib/auth/first-proof.ts: an
-- address's FIRST proof keeps the password only when the browser proving it
-- is the browser whose sign-up created the account; otherwise the password is
-- replaced, every other session is signed out, and the user must choose a new
-- one. This table is how the callback tells a FIRST proof from a later one.
--
-- ===========================================================================
-- WHAT THIS MIGRATION ADDS
-- ===========================================================================
--   1. private.address_first_proofs: one row per account whose address has
--      been proved through the callback, recording whether the pre-proof
--      password was kept. Not exposed (private schema), granted to nobody.
--   2. Two SECURITY DEFINER functions, executable by service_role ALONE and
--      refusing any session with a person on it -- the callback's only reach
--      into the table, through lib/auth/first-proof.ts (the service-role
--      client census names that file):
--        public.address_is_proved(uuid)                  -> boolean
--        public.record_address_first_proof(uuid, boolean) -> void
--   3. A BACKFILL: every account already confirmed is recorded as proved,
--      password kept, so no existing account is sent to /set-password.
--   4. A trigger on auth.users doing the same for an account created ALREADY
--      confirmed after today (Admin API, OAuth).
--   5. 'set-password' joins the reserved workspace slugs (a new top-level route).
--   6. The marker joins the retention roll (cascades with the account).
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- 1. THE MARKER.
create table private.address_first_proofs (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  proved_at     timestamptz not null default now(),
  password_kept boolean not null
);

revoke all on table private.address_first_proofs from public, anon, authenticated, service_role;

comment on table private.address_first_proofs is
  'THE FIRST PROOF OF AN ADDRESS (20261104000000; Phase 10 Task 20, Q245). One row per account whose email address has been proved through app/auth/callback/route.ts, or that was already confirmed when this table arrived (the backfill, password_kept = true). password_kept says whether the password set before the proof survived it: true when the proving browser held the sign-up binding (or the account has no email identity, so no password), false when the callback replaced it and required a new one. No row = the next proof through the callback is the first. Not exposed, granted to nobody; read and written ONLY by public.address_is_proved() and public.record_address_first_proof() (service_role, sessionless); deleted by the FK cascade with the account.';


-- 2. THE TWO ENTRY POINTS.
create or replace function public.address_is_proved(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'address_is_proved: read by the auth callback, never from a person''s session'
      using errcode = '42501', hint = 'address_first_proof_is_server_only';
  end if;

  return exists (select 1 from private.address_first_proofs where user_id = p_user_id);
end;
$$;

revoke all on function public.address_is_proved(uuid) from public, anon, authenticated;
grant execute on function public.address_is_proved(uuid) to service_role;

comment on function public.address_is_proved(uuid) is
  'Has this account''s address already been proved (a row in private.address_first_proofs)? Called by lib/auth/first-proof.ts from the auth callback after verifyOtp / the code exchange, to tell an address''s FIRST proof from a later one. service_role only; refuses any session (42501 address_first_proof_is_server_only). Answers one boolean about one account.';

create or replace function public.record_address_first_proof(p_user_id uuid, p_password_kept boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'record_address_first_proof: written by the auth callback, never from a person''s session'
      using errcode = '42501', hint = 'address_first_proof_is_server_only';
  end if;

  if p_user_id is null or p_password_kept is null then
    raise exception 'record_address_first_proof: user and outcome are required'
      using errcode = '22023', hint = 'address_first_proof_incomplete';
  end if;

  -- The first record stands: a concurrent second proof (two tabs) changes nothing.
  insert into private.address_first_proofs (user_id, password_kept)
  values (p_user_id, p_password_kept)
  on conflict (user_id) do nothing;
end;
$$;

revoke all on function public.record_address_first_proof(uuid, boolean) from public, anon, authenticated;
grant execute on function public.record_address_first_proof(uuid, boolean) to service_role;

comment on function public.record_address_first_proof(uuid, boolean) is
  'Records an account''s FIRST proof of address in private.address_first_proofs, with whether the pre-proof password was kept. Called by lib/auth/first-proof.ts from the auth callback ONLY after the outcome is complete (password kept, or replaced with other sessions signed out and the must-choose mark set), so a failure part-way leaves no row and the next proof retries. The first row stands (ON CONFLICT DO NOTHING). service_role only; refuses any session (42501 address_first_proof_is_server_only); a null argument is 22023 address_first_proof_incomplete.';


-- 3. THE BACKFILL: an account confirmed before this table existed is not gated.
insert into private.address_first_proofs (user_id, proved_at, password_kept)
select u.id, coalesce(u.email_confirmed_at, now()), true
  from auth.users u
 where u.email_confirmed_at is not null
on conflict (user_id) do nothing;


-- 4. AN ACCOUNT BORN CONFIRMED. Only the server (the Admin API with
--    email_confirm) or an OAuth provider can create an account whose address
--    is already confirmed; neither went through a proof the callback could
--    see, and neither carries a squatter's password. Without this row its
--    first emailed sign-in link would count as a first proof and replace a
--    password its owner chose.
--
--    MEASURED (GoTrue v2.196.0): the Admin API does not insert a confirmed
--    row. In ONE transaction it inserts the account unconfirmed, then updates
--    email_confirmed_at. So "born confirmed" is "confirmed in the transaction
--    that created it": the INSERT leaves a transaction-local marker
--    (set_config(..., true), gone at commit) and the UPDATE that confirms
--    reads it. A self-service sign-up or an invitation is confirmed later, in
--    another transaction, by the proof itself -- which must stay the
--    callback's to record, so that UPDATE writes nothing here.
create or replace function private.record_born_confirmed_address()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_created_here text := 'gsp.created_in_tx_' || pg_catalog.replace(new.id::text, '-', '');
begin
  if tg_op = 'INSERT' then
    perform pg_catalog.set_config(v_created_here, 'on', true);
  end if;

  if new.email_confirmed_at is not null
     and pg_catalog.current_setting(v_created_here, true) = 'on' then
    insert into private.address_first_proofs (user_id, proved_at, password_kept)
    values (new.id, new.email_confirmed_at, true)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

comment on function private.record_born_confirmed_address() is
  'AFTER INSERT OR UPDATE OF email_confirmed_at trigger on auth.users (20261104000000; Phase 10 Task 20): an account confirmed IN THE TRANSACTION THAT CREATED IT (the Admin API with email_confirm inserts unconfirmed and confirms in the same transaction, measured; OAuth) is recorded in private.address_first_proofs as proved, password kept, so its first emailed link is not treated as the first proof of its address. An account confirmed in a later transaction (self-service sign-up, invitation) gets no row here; its first proof through the auth callback writes one.';

revoke all on function private.record_born_confirmed_address() from public, anon, authenticated, service_role;

create trigger on_auth_user_confirmed_at_birth
  after insert or update of email_confirmed_at on auth.users
  for each row
  execute function private.record_born_confirmed_address();


-- 5. /set-password IS A TOP-LEVEL ROUTE, so its segment is a reserved
--    workspace slug (Q151; tests/unit/org/reserved-slugs.test.ts). Rebuilt
--    from the live definition, which matched 20260923005000 exactly; the one
--    change is the 'set-password' row.
create or replace function private.reserved_workspace_slugs()
returns table (slug text)
language sql
immutable
set search_path = ''
as $$
  values ('account'::text),
         ('api'::text),
         ('auth'::text),
         ('invites'::text),
         ('legal'::text),
         ('login'::text),
         ('magic-link'::text),
         ('onboarding'::text),
         ('set-password'::text),
         ('signup'::text),
         ('super'::text);
$$;

comment on function private.reserved_workspace_slugs() is
  'The static top-level route segments of the app (20260923005000, Q151; set-password added by 20261104000000): a workspace slug equal to one would be shadowed by that route. Asserted equal to the segments app/ defines by tests/unit/org/reserved-slugs.test.ts; mirrored by lib/org/reserved-slugs.ts. Enforced by private.organisations_slug_not_reserved().';

revoke all on function private.reserved_workspace_slugs() from public, anon, authenticated, service_role;


-- 6. THE RETENTION ROLL. private.assert_retention_roll() refuses the
--    retention job while any table in `public` or `private` is unclassified,
--    so the marker joins the roll. Rebuilt from its live pg_get_functiondef,
--    which matched its latest migration (20261101000000 § 6) exactly; the one
--    change is the private.address_first_proofs row at the end. Its comment
--    and grants are kept by CREATE OR REPLACE.
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
     'One row per account whose email address has been proved (Phase 10 Task 20, Q245): a user id, a time and whether the pre-proof password was kept -- no address, no content. FK to auth.users, ON DELETE CASCADE: it goes with the account, in private.erase_account(), and on no clock of its own.')
$function$;

-- 7. SELF-CHECK: the migration refuses itself rather than ship a roll that
--    does not classify the new table.
do $$
begin
  perform private.assert_retention_roll();
end;
$$;

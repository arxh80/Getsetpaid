-- ===========================================================================
-- PHASE 9 TASK 1: INTEGRATION TABLES. Schema only -- no provider is live
-- (founder 2026-10-09; docs/superpowers/specs/2026-10-09-integrations-schema-design.md).
--
-- WHAT THIS ADDS
--   1. private.integration_providers() -- the provider catalogue, eight rows,
--      every one `live = false`. Nothing in Phase 9 may set one true.
--   2. The `manage_integrations` permission key, Owner and Admin, NOT
--      surviving suspension.
--   3. public.integration_connections -- one row per connection a workspace
--      (owner_user_id null) or a person in it (owner_user_id set) holds with a
--      provider. VAULT-READY: the token is never a column. token_secret_id is
--      the uuid of a vault.secrets row (Task 2 writes it; Task 2 Step 3
--      revokes it from `authenticated` at column level).
--   4. public.integration_sync_runs -- one row per sync attempt, bound to its
--      connection IN THE SAME ORGANISATION by a composite FK.
--
-- WRITE PATH: NONE FOR A CLIENT. `authenticated` holds SELECT only; anon and
-- service_role hold nothing (the 20260827232507 default-privileges floor,
-- restated here so the intent does not depend on it). Every write is a
-- SECURITY DEFINER RPC (Task 2), or postgres in a fixture.
--
-- READ PATH. A connection is visible to an organisation's manage_integrations
-- holders (Owner, Admin -- MFA-gated through permitted_organisations), and a
-- PERSON-SCOPED connection additionally to its owner while they can view_crm
-- in that workspace. Reads are not tier-gated: a downgraded (Free) workspace
-- keeps reading the rows it has -- downgrade never hides data. A sync run is
-- visible exactly when its connection is (the policy reads the connection
-- under the caller's own RLS).
--
-- ATTRIBUTION. private.stamp_row_attribution() (20261029001000) is attached
-- to integration_connections. It is SECURITY INVOKER and exempts the owner
-- roles postgres/supabase_admin, and a SECURITY DEFINER RPC owned by postgres
-- runs its INSERT with current_user = postgres -- so under Task 2's RPCs the
-- trigger is a deliberate NO-OP and the RPC must set created_by := auth.uid()
-- itself. It is attached anyway as the rail for the day a client write path
-- appears: such a path would run as `authenticated` and be pinned to the
-- session at once. It cannot break a definer insert (measured, IT12).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE PROVIDER CATALOGUE.
-- ---------------------------------------------------------------------------
create or replace function private.integration_providers()
returns table (provider text, category text, live boolean)
language sql immutable set search_path = '' as $$
  values ('google_gmail','email',false), ('google_calendar','calendar',false),
         ('microsoft_365_mail','email',false), ('microsoft_365_calendar','calendar',false),
         ('skiddle','ticketing',false), ('fatsoma','ticketing',false),
         ('xero','accounting',false), ('quickbooks','accounting',false)
$$;

comment on function private.integration_providers() is
  'Phase 9 provider catalogue (founder 2026-10-09). Eight providers, every one live = false: schema only, no live connector at MVP. A connection may name only a provider listed here (private.integration_connections_guard). Setting live = true is a deliberate future change, never a Phase 9 one.';

revoke all on function private.integration_providers()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. THE PERMISSION KEY (pattern: 20260927000000_export_jobs.sql).
-- ---------------------------------------------------------------------------
insert into public.permissions (key, survives_suspension, description) values
  ('manage_integrations', false,
   'Connect, revoke and read third-party integrations for a workspace. Owner and Admin. No provider is live at MVP (Phase 9, founder 2026-10-09).')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('owner', 'manage_integrations'),
  ('admin', 'manage_integrations')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. THE TABLES.
-- ---------------------------------------------------------------------------
create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  provider text not null,
  owner_user_id uuid null references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','active','error','revoked')),
  scopes text[] not null default '{}',
  token_secret_id uuid null,
  token_expires_at timestamptz null,
  last_synced_at timestamptz null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null,
  revoked_by uuid null references auth.users(id) on delete set null,
  unique (organisation_id, id),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (status <> 'revoked' or token_secret_id is null)
);

comment on table public.integration_connections is
  'Phase 9. A workspace''s (owner_user_id null) or a person''s (owner_user_id set) connection to a provider in private.integration_providers(). No token column: token_secret_id names a vault.secrets row. Client roles hold SELECT only; writes are SECURITY DEFINER RPCs. revoked is terminal and drops the secret reference.';

-- At most one live (non-revoked) connection per workspace, provider and
-- person; a workspace-scoped one is keyed on the nil uuid.
create unique index integration_connections_one_live
  on public.integration_connections (organisation_id, provider,
     coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'revoked';
create index integration_connections_owner_user_id_idx on public.integration_connections (owner_user_id);
create index integration_connections_created_by_idx    on public.integration_connections (created_by);
create index integration_connections_revoked_by_idx    on public.integration_connections (revoked_by);

create table public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  connection_id uuid not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  items_read integer not null default 0 check (items_read >= 0),
  items_written integer not null default 0 check (items_written >= 0),
  error_code text null check (error_code in ('auth_expired','rate_limited','provider_unavailable','scope_missing','internal')),
  foreign key (organisation_id, connection_id)
    references public.integration_connections (organisation_id, id) on delete cascade,
  check ((status = 'failed') = (error_code is not null)),
  check ((status = 'running') = (finished_at is null))
);

comment on table public.integration_sync_runs is
  'Phase 9. One sync attempt of one integration connection, in the same organisation (composite FK). error_code is a closed vocabulary -- never free text, so a provider error message (which may echo a token) cannot land here. Client roles hold SELECT only.';

create index integration_sync_runs_org_connection_idx on public.integration_sync_runs (organisation_id, connection_id);
create index integration_sync_runs_connection_id_idx  on public.integration_sync_runs (connection_id);

-- ---------------------------------------------------------------------------
-- 4. THE GUARD: a catalogue provider, and revoked is terminal.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the catalogue check works for every writer: the
-- catalogue is EXECUTE-revoked from the client roles, and an invoker guard
-- would refuse a non-owner writer with a bare 42501 on the catalogue instead
-- of the 23514 below -- and would mask the attribution rail that fires after
-- it (measured: IT14). It reads only NEW/OLD and the catalogue.
create or replace function private.integration_connections_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.integration_providers() p where p.provider = new.provider) then
    raise exception 'integration_connections: provider % is not in the integration catalogue', new.provider
      using errcode = '23514', hint = 'unknown_integration_provider';
  end if;

  if tg_op = 'UPDATE' and old.status = 'revoked' and new.status is distinct from 'revoked' then
    raise exception 'integration_connections: a revoked connection cannot be reopened; connect again instead'
      using errcode = '23514', hint = 'revoked_is_terminal';
  end if;

  return new;
end;
$$;

comment on function private.integration_connections_guard() is
  'Phase 9 Task 1. BEFORE INSERT OR UPDATE on public.integration_connections: refuses a provider outside private.integration_providers() (23514, hint unknown_integration_provider) and any move out of status revoked (23514, hint revoked_is_terminal).';

revoke all on function private.integration_connections_guard()
  from public, anon, authenticated, service_role;

create trigger integration_connections_guard
  before insert or update on public.integration_connections
  for each row execute function private.integration_connections_guard();

-- The attribution rail (see the header: a no-op under a postgres-owned
-- definer RPC, binding for any future client write path).
create trigger stamp_attribution
  before insert or update on public.integration_connections
  for each row execute function private.stamp_row_attribution();

-- ---------------------------------------------------------------------------
-- 5. RLS AND GRANTS.
-- ---------------------------------------------------------------------------
alter table public.integration_connections enable row level security;
alter table public.integration_connections force row level security;
alter table public.integration_sync_runs   enable row level security;
alter table public.integration_sync_runs   force row level security;

revoke all on public.integration_connections from public, anon, authenticated, service_role;
revoke all on public.integration_sync_runs   from public, anon, authenticated, service_role;
grant select on public.integration_connections to authenticated;
grant select on public.integration_sync_runs   to authenticated;

create policy integration_connections_select on public.integration_connections
  for select to authenticated using (
    organisation_id in (select private.permitted_organisations('manage_integrations'))
    or (owner_user_id = (select auth.uid())
        and organisation_id in (select private.permitted_organisations('view_crm')))
  );

create policy integration_sync_runs_select on public.integration_sync_runs
  for select to authenticated using (
    exists (select 1 from public.integration_connections c
             where c.organisation_id = integration_sync_runs.organisation_id
               and c.id = integration_sync_runs.connection_id)
  );


-- ---------------------------------------------------------------------------
-- 6. THE RETENTION ROLL. private.assert_retention_roll() refuses an
--    unclassified table in `public` -- and so would the nightly sweep -- the
--    moment these two exist. Rebuilt from the live pg_get_functiondef of
--    20261027000000's version, two rows added, nothing else changed. Both are
--    `cascades` today (true: each goes with its workspace); Task 3 replaces
--    that with their own retention classes.
-- ---------------------------------------------------------------------------
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
     'private.reap_stuck_jobs(): a row left `running` is failed, not deleted, so the one-live-job index stops blocking the subject (Q166). The archive bytes are already purged by the export runner''s own expiry.'),
    ('documents',           'swept', 'operational',
     'private.sweep_document_bytes(): the BYTES of a soft-deleted document, once its parent record''s class has run out (Q52). The row survives -- see the column comment on documents.bytes_purged_at.'),
    ('organisations',       'swept', 'workspace',
     'private.sweep_expired_workspaces() -> private.erase_organisation(): 60 days after suspension or closure (Q88/Q92/Q102). Everything classified `cascades` below goes with it.'),

    -- ---- goes with its parent --------------------------------------------
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

    -- ---- integrations (added in 20261030000000, Phase 9 Task 1) ---------
    ('integration_connections', 'cascades', null,
     'FK to public.organisations, ON DELETE CASCADE. Interim: Phase 9 Task 3 gives revoked connections their own clock (2 years, inactive-data default) and has the purge delete each Vault secret first.'),
    ('integration_sync_runs',   'cascades', null,
     'Composite FK to public.integration_connections and FK to public.organisations, both ON DELETE CASCADE. Interim: Phase 9 Task 3 sweeps them at 90 days under their own class.')
$function$;


-- ---------------------------------------------------------------------------
-- 7. THE ERASURE'S FK-LESS UUID ROLL. private.erase_account() refuses (55000)
--    while any uuid column without a foreign key is unclassified, and
--    integration_connections.token_secret_id is one. Rebuilt from the live
--    pg_get_functiondef, one row added, nothing else changed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.fkless_identifier_columns()
 RETURNS TABLE(table_name text, column_name text, identifies text, treatment text, predicate text, note text)
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select *
    from (values
      -- THE PERSON-BEARING ONES. Every one of these is why this roll exists.
      ('public.merges',           'winner_owner_user_id',    'user', 'null_on_match', null,
       'who owned the surviving record at the moment of the merge'),
      ('public.merges',           'loser_owner_user_id',     'user', 'null_on_match', null,
       'who owned the discarded record at the moment of the merge'),
      ('public.merge_candidates', 'keep_owner_user_id',      'user', 'null_on_match', null,
       'C1: written by public.screen_for_duplicates() on EVERY flagged duplicate'),
      ('public.merge_candidates', 'duplicate_owner_user_id', 'user', 'null_on_match', null,
       'C1: the same, for the proposed duplicate'),
      ('public.rate_limit_counters', 'subject_id',           'user', 'delete_row',
       'subject_scope = ''user''',
       'enforcement state about somebody who will not be asking for anything else; deleted rather than re-pointed, so an erased budget cannot throttle the tombstone'),
      ('public.rate_limit_counters', 'subject_id',           'organisation', 'delete_row',
       'subject_scope = ''organisation''',
       'the same column again, on its other scope: enforcement state about a workspace that has been purged, which the workspace purge deletes (fix round 1 -- the roll named only the `user` scope, so a purged workspace kept its counters)'),
      ('public.audit_events',     'target_id',               'polymorphic', 'handled_explicitly', null,
       'erase_account() step 6b re-points it at the tombstone AND drops the payload; a workspace purge leaves it, because a workspace is not a data subject'),

      -- THE WORKSPACE-BEARING ONE.
      ('public.feedback', 'support_access_organisation_id', 'organisation', 'null_on_match', null,
       'a snapshot of the workspace a superuser was inside when the feedback was written; no foreign key, so a purge would leave it naming a workspace that is gone'),

      -- AND THE REST, CLASSIFIED SO THAT THE DENOMINATOR IS THE CATALOGUE AND
      -- NOT A HABIT. None of these can hold a person or a workspace.
      ('public.audit_events',         'correlation_id',       'other',  'not_a_person', null, 'a thread id'),
      ('public.data_subject_requests','fulfilment_reference', 'other',  'not_a_person', null, 'an export or erasure job id'),
      ('public.feedback',             'support_access_session_id','other','not_a_person', null, 'an impersonation session id'),
      ('public.custom_field_values',  'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.document_links',       'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.meeting_links',        'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.note_links',           'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.task_links',           'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.network_links',        'private_entity_id',    'record', 'not_a_person', null, 'this workspace''s own CRM row'),
      ('public.network_profiles',     'entity_id',            'record', 'not_a_person', null, 'the published entity'),
      ('public.merges',               'winner_id',            'record', 'not_a_person', null, 'the surviving CRM row'),
      ('public.merges',               'loser_id',             'record', 'not_a_person', null, 'the discarded CRM row'),
      ('public.merge_candidates',     'keep_id',              'record', 'not_a_person', null, 'the proposed survivor'),
      ('public.merge_candidates',     'duplicate_id',         'record', 'not_a_person', null, 'the proposed duplicate'),
      -- PHASE 8 TASK 6. public.retention_runs.correlation_id is the thread a
      -- retention run's audit rows are written on -- audit_events.correlation_id's
      -- twin, and classified the same way for the same reason: it identifies a
      -- RUN OF A JOB and can never name a person or a workspace. It is on this
      -- roll because it MADE THE ERASURE REFUSE the moment the table existed
      -- (55000 / unclassified_fkless_identifier, measured by
      -- rls_phase8_retention.sql § RW on its first run), which is exactly what
      -- the derivation is for.
      ('public.retention_runs',       'correlation_id',       'other',  'not_a_person', null, 'the thread one retention run''s audit rows are written on'),
      -- PHASE 9 TASK 1 (20261030000000). token_secret_id names a vault.secrets
      -- row (no FK: vault is not ours to reference). It identifies a SECRET,
      -- never a person or a workspace; erasing the person who owns a
      -- person-scoped connection deletes the row and its secret (Task 3),
      -- which this roll does not need to know about. It is here because it
      -- made every erasure refuse the moment the column existed.
      ('public.integration_connections', 'token_secret_id', 'other', 'not_a_person', null, 'a vault.secrets id; the token itself is never a column')
    ) as r(table_name, column_name, identifies, treatment, predicate, note)
$function$;


-- ---------------------------------------------------------------------------
-- 8. THE EXPORT CATALOGUE. The completeness census (and
--    private.export_catalogue_is_sound()) requires every table with a row ->
--    organisation or row -> user path to be exported or excused. Rebuilt from
--    the live pg_get_functiondef, three INTERIM `excused` rows added; Task 3
--    turns them into exports.
-- ---------------------------------------------------------------------------
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
  -- PHASE 9 TASK 1 (20261030000000). INTERIM: Task 3 replaces these three
  -- rows with `exported` ones whose projection names token_secret_id OUT.
  ('workspace', 'integration_connections',      'excused', 'INTERIM (Phase 9 Task 1): the table exists but is not yet wired into the export. Phase 9 Task 3 exports its metadata (provider, status, scopes, dates) and never token_secret_id. No provider is live, so no workspace can hold a row yet.', null, null, null, null),
  ('workspace', 'integration_sync_runs',        'excused', 'INTERIM (Phase 9 Task 1): see integration_connections. Phase 9 Task 3 exports it.', null, null, null, null),
  ('account',   'integration_connections',      'excused', 'INTERIM (Phase 9 Task 1): Phase 9 Task 3 exports the person''s own person-scoped connections in the account export. No provider is live, so nobody can hold a row yet.', null, null, null, null)
$function$;

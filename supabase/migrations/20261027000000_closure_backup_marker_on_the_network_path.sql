-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 1b -- THE CLOSURE-BACKUP MARKER, ACKNOWLEDGED BY
-- THE THREE CENSUSES IT TRIPPED (Q227, controller 2026-10-05, pending founder).
--
-- 20261025000000 (C1) put private.closure_backup_read_admits() inside
-- private.permitted_organisations() and public.has_permission(). Three
-- structural censuses went red at 231 migrations. Decision (a): KEEP the term
-- where it is, and make each census acknowledge it explicitly.
--
-- 1. THE NETWORK-LEAKAGE CLOSURE (network_leakage_phase6.sql § LF) WAS RED ON A
--    COMMENT, NOT ON THE MARKER. Measured: the text closure from the two
--    masking views grew from 6 bodies to 14, because permitted_organisations'
--    new comment named "public.export_read_page()" and the closure is a NAME
--    match over bodies (the false-positive direction its header promises).
--    That pulled in export_read_page and, through it, the export catalogue,
--    which names public.financial_entries, public.notes and every other
--    tenant table -- so LF1/LF3/LF3c counted private relations that no
--    masking view can reach. The marker itself names only
--    private.closure_backup_reads, which LF1's public.* needle set cannot see.
--    So: permitted_organisations is rebuilt from its LIVE definition with that
--    one comment line reworded (no behaviour change), and § LF now allowlists
--    EXACTLY private.closure_backup_reads as the one private relation the
--    closure may name, pins that table's column set (xact xid8,
--    organisation_id uuid, export_job_id uuid -- a transaction id and two
--    foreign keys, no tenant data), and asserts it is empty at rest.
-- 2. rls_phase2_crm.sql § M1c/M1d2 is re-pinned in the test file (the
--    suspension clause now has a third disjunct, in both bodies).
-- 3. THE RETENTION ROLL CLASSIFIES THE MARKER. private.retention_roll_relations()
--    sees `private`, so every retention run refused with
--    unclassified_retention_subject. Rebuilt from its LIVE definition
--    (20261016000000) with one row added, treatment `ephemeral`: a row lives
--    for one export_read_page() call and is deleted on both paths.
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

CREATE OR REPLACE FUNCTION private.permitted_organisations(p_permission text)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.organisation_id
  from public.organisation_memberships m
  join public.role_permissions rp
    on rp.role_key = m.role
  -- Q6, mirrored from public.has_permission.
  join public.permissions perm
    on perm.key = rp.permission_key
  join public.organisations o
    on o.id = m.organisation_id
   and (o.deleted_at is null or perm.survives_suspension
        -- 20261025000000 (Task 9c fix round 1, C1): a closure backup's read
        -- sees the workspace as it was before the closure. TRUE only inside
        -- the export engine's requester read of a closure_backup job,
        -- in that transaction, for that organisation -- see that function.
        or private.closure_backup_read_admits(o.id))
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and rp.permission_key = p_permission
    and (
      not private.role_requires_mfa(m.role)
      or private.session_is_aal2()
    )
  -- PHASE 7 TASK 2, mirrored from has_permission's second disjunct. UNION, not
  -- UNION ALL: a caller cannot be both a member and an impersonator of the
  -- same organisation today (the superuser is not a member of the tenants they
  -- support), but a duplicate id here would be a duplicate row in every
  -- `organisation_id in (select ...)` InitPlan, and dedup is free at this
  -- cardinality.
  union
  select g from private.impersonated_organisations(p_permission) g;
$function$

;

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
     'One row per transaction in which public.export_read_page() is reading a closure_backup job (20261025000000, Task 9c C1): a transaction id, the organisation id and the export job id -- no tenant data. Inserted and deleted inside that one call, on both its success and its failure path, so the table is empty at rest (rls_phase8_closure_backup.sql KA7/KM). Nothing to sweep; the FKs also cascade with the workspace and the job.')
$function$
;

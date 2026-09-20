-- ===========================================================================
-- PHASE 8 TASK 4 -- EXPORT, PART 1: THE PERMISSION KEY, THE BOUNDS AND THE
-- TABLE CATALOGUE THAT IS ALSO THE COMPLETENESS CENSUS'S SUBJECT.
--
-- Q132 says there are TWO controllers, so there are two exports:
--
--   * `account`   -- GetSetPaid is the controller. Everything the platform
--                    holds about the signed-in person AS A USER: profile,
--                    memberships, the consents ledger, their data subject
--                    requests, feedback they sent, the support-access
--                    sessions they accepted or declined, and the audit rows
--                    where they are the ACTOR. It does NOT contain the CRM
--                    content of the workspaces they belong to: that is the
--                    workspace's data, and a member leaving with a copy of
--                    their employer's contact book is a breach, not a right.
--   * `workspace` -- the customer is the controller and we are the processor.
--                    Every tenant-owned table for ONE organisation, including
--                    soft-deleted rows. Owner/Admin only, step-up, on the
--                    `exports` budget, audited.
--
-- ===========================================================================
-- HOW THE JOB'S READS ARE AUTHORISED -- THE DECISION THIS TASK TURNS ON
-- ===========================================================================
-- An export that runs with elevated rights and reads whatever it likes has
-- rebuilt the theft path founder ruling Q54 closed: `notes.visibility =
-- 'private'` reaches only its author, and an Owner who cannot read a
-- colleague's private note in the product must not be handed it in a zip.
--
-- So the default -- and the ONLY authorisation the whole workspace export
-- uses -- is `requester_rls`: the read runs under `role authenticated` with
-- the requester's own JWT claims, so every row policy in the schema decides,
-- exactly as it would in their browser. Not a re-implementation of the rules;
-- the rules themselves. 20260927001000 is the mechanism.
--
-- FOUR ACCOUNT TABLES CANNOT BE READ THAT WAY, and pretending otherwise would
-- have been the invisible-denominator failure this phase keeps making:
-- `audit_events` and `feedback` are superuser-only by policy, `platform_admins`
-- has no SELECT policy whatsoever, and `impersonation_sessions` is readable
-- only through a permission in a workspace the person may have left. Under
-- `requester_rls` all four would have exported ZERO ROWS and every test would
-- have passed. They are marked `elevated` instead, and an elevated row must
-- carry a reason and -- where the table holds more than the requester's own
-- data -- an explicit column PROJECTION, which
-- private.export_catalogue_is_sound() enforces.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE PERMISSION KEY.
--
--    `export_organisation_data` -- Owner and Admin only. Not Manager, not
--    Finance, not Marketing: a workspace export is EVERY table in the
--    workspace at once, which is the whole record a role-scoped key exists to
--    avoid handing out. It is the key a customer uses to answer a DSR routed
--    to them (Q132), to leave the product, and to take a copy before Q88's
--    60-day purge.
--
--    survives_suspension = TRUE, and that is a decision rather than a
--    default. Q88/Q92 keep a suspended or closed workspace's data for 60 days
--    and then make it eligible for purge; a customer locked out of their own
--    data during exactly that window is the failure to avoid, and it is the
--    window in which they most need the copy. It is also consistent with Q6
--    (suspension is read-only, not a lockout) and with `view_crm`, the READ
--    key that already survives: an export is a read. It is the THIRD key in
--    the catalogue with this flag, after `view_crm` and `end_support_access`,
--    and supabase/tests/rls_phase2_crm.sql § M1f names that set -- so this
--    migration reds that assertion until it is updated, deliberately.
--
--    It grants no WRITE anywhere: starting a job inserts a row in
--    public.export_jobs and nothing else, and the archive is built under the
--    requester's own read rights.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, survives_suspension, description) values
  ('export_organisation_data', true,
   'Start and download a WORKSPACE export: a machine-readable archive of every tenant-owned table for one organisation, soft-deleted rows included. Owner and Admin only -- a Manager, Booker, Venue Manager, Finance or Marketing role is record- or module-scoped by design, and this key is the whole workspace at once. survives_suspension = true (Phase 8 Task 4): a suspended or closed workspace is kept for 60 days (Q88/Q92) and is then eligible for purge, so the retention window is exactly when a customer needs their copy; locking them out of it would make the retention promise unkeepable. Grants no write: the job is built under the requester''s own read rights.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('owner', 'export_organisation_data'),
  ('admin', 'export_organisation_data')
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- 2. THE BOUNDS.
--
--    "Exports are async and bounded" (CLAUDE.md § Non-negotiable rules). A
--    job that exceeds a ceiling FAILS LOUDLY with a recorded reason; it never
--    truncates silently, because a silent truncation is an export that says
--    it is complete and is not -- which for a statutory access request is a
--    wrong answer given with confidence.
--
--    ONE DECLARED PLACE, so a later task changes a number here and nowhere
--    else. lib/export/contract.ts mirrors these for the UI copy and
--    tests/integration/export/limits-match-db.test.ts binds the two.
-- ---------------------------------------------------------------------------

create or replace function private.export_limits()
returns table (
  page_size           integer,
  max_rows_per_table  bigint,
  max_total_rows      bigint,
  max_archive_bytes   bigint,
  archive_days        integer
)
language sql
immutable
set search_path = ''
as $$
  -- page_size          : rows per read. Keyset, never OFFSET.
  -- max_rows_per_table : one table's ceiling.
  -- max_total_rows     : the job's ceiling across every table.
  -- max_archive_bytes  : 40 MiB. Under the bucket's own 50 MiB limit and
  --                      under the stack's global storage cap, so the job
  --                      fails with ITS OWN recorded reason rather than with
  --                      a storage 413 nobody can read.
  -- archive_days       : how long a finished archive can be downloaded.
  select 500, 50000::bigint, 500000::bigint, 41943040::bigint, 7
$$;

comment on function private.export_limits() is
  'The export job''s ceilings, in ONE declared place (Phase 8 Task 4). A job that would exceed max_rows_per_table, max_total_rows or max_archive_bytes is FAILED with a recorded reason -- never truncated, because a truncated statutory access response is a wrong answer given with confidence. archive_days is READ-TIME expiry, the house pattern: nothing sweeps it, the download path refuses an archive older than that, and Task 6 purges the bytes. Mirrored in lib/export/contract.ts and bound by tests/integration/export/limits-match-db.test.ts.';

revoke all on function private.export_limits() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE TABLE CATALOGUE -- the export's contents AND the census's subject.
--
--    ONE list, read by the job (which tables to page through, under which
--    authorisation, on which scope column, with which projection) and by
--    tests/integration/export/completeness-census.test.ts (which derives the
--    denominator from pg_constraint and asserts this list equals it).
--
--    THE DENOMINATOR IS A FOREIGN-KEY WALK, NOT A COLUMN-NAME MATCH. Four of
--    the organisation paths are not called `organisation_id`:
--    data_subject_requests.routed_to_organisation_id,
--    impersonation_sessions.target_organisation_id and
--    network_connection_requests.from_organisation_id / to_organisation_id.
--    A census keyed on the name would have dropped all four silently, which
--    is the shape of failure this phase has shipped twice.
--
--    disposition: 'exported' | 'excused'. An excused table carries a REASON,
--    and the soundness check refuses an empty one.
--    authorisation: 'requester_rls' | 'elevated' (see the header).
--    scope_columns: the column(s) that tie a row to the subject. More than
--    one where a row can be the subject's by either end
--    (network_connection_requests; impersonation_sessions).
--    projection: null = every column; otherwise exactly these.
-- ---------------------------------------------------------------------------

create or replace function private.export_catalogue()
returns table (
  export_kind   text,
  table_name    text,
  disposition   text,
  reason        text,
  authorisation text,
  scope_columns text[],
  key_column    text,
  projection    text[]
)
language sql
immutable
set search_path = ''
as $$
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
  ('workspace', 'data_subject_requests', 'excused',
   'Another person''s statutory request. The workspace appears on it only as the organisation an operator ROUTED it to (Q160), and the row holds the requester''s identity, their own words and our handling of them -- none of which is the workspace''s data. The requester gets it in their own account export.',
   null, null, null, null),

  -- =====================================================================
  -- ACCOUNT EXPORT. GetSetPaid is the controller.
  -- =====================================================================
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
   'ELEVATED: public.platform_admins has NO select policy for any client role, so nothing could read it under RLS. Two columns, both about the requester: that this account is the platform operator, and since when. Filtered to user_id = the requester; no projection is needed because the whole row is theirs.',
   'elevated', array['user_id'], 'user_id', null),
  ('account', 'impersonation_sessions', 'exported',
   'ELEVATED: the workspace-admin read this rests on is a permission IN a workspace, so a person who has left that workspace would silently export nothing -- while the record of support access THEY consented to or refused stays their own act. Filtered to the two columns that name them as the decider; a session they neither accepted nor declined is not theirs and is not returned.',
   'elevated', array['admin_accepted_by','declined_by'], 'id', null),

  -- ---- EXCUSED ---------------------------------------------------------
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
  ('account', 'incident_alerts',                'excused', 'Platform operations; the account appears only as resolved_by, which is the operator acting on GetSetPaid''s own signal. Excused from both exports.', null, null, null, null)
$$;

comment on function private.export_catalogue() is
  'WHAT THE TWO EXPORTS CONTAIN, and the subject of the completeness census (Phase 8 Task 4). One row per (export_kind, table_name). disposition is exported or excused, and an excused row must say why. authorisation is requester_rls -- the read runs under role authenticated with the requester''s own claims, so every RLS policy decides exactly as it would in their browser -- or elevated, which is permitted only for a table no client role can read and must carry a reason and, where the table holds more than the requester''s own data, an explicit column PROJECTION. The WHOLE workspace export is requester_rls, which is what makes "an Owner''s export contains no other member''s private note" true by construction. tests/integration/export/completeness-census.test.ts derives the denominator from pg_constraint (a foreign-key walk, NOT a column-name match -- four organisation paths are not called organisation_id) and fails when a table is in neither disposition.';

revoke all on function private.export_catalogue() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. THE CATALOGUE'S OWN INVARIANTS, checked in the database rather than only
--    in a test, so a later migration cannot add a nonsense row and find out
--    at job time.
-- ---------------------------------------------------------------------------

create or replace function private.export_catalogue_is_sound()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select pg_catalog.string_agg(problem, '; ' order by problem)
       from (
         select 'unknown export_kind: ' || c.export_kind as problem
           from private.export_catalogue() c where c.export_kind not in ('account','workspace')
         union all
         select 'unknown disposition: ' || c.table_name
           from private.export_catalogue() c where c.disposition not in ('exported','excused')
         union all
         select 'excused without a reason: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'excused'
            and (c.reason is null or pg_catalog.btrim(c.reason) = '')
         union all
         select 'exported without an authorisation: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported'
            and (c.authorisation is null or c.authorisation not in ('requester_rls','elevated'))
         union all
         select 'elevated without a reason: ' || c.table_name
           from private.export_catalogue() c
          where c.authorisation = 'elevated'
            and (c.reason is null or pg_catalog.btrim(c.reason) = '')
         union all
         select 'exported without scope columns: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported'
            and (c.scope_columns is null or pg_catalog.array_length(c.scope_columns, 1) is null)
         union all
         select 'exported without a key column: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported' and c.key_column is null
         union all
         select 'a workspace export table is elevated: ' || c.table_name
           from private.export_catalogue() c
          where c.export_kind = 'workspace' and c.authorisation = 'elevated'
         union all
         select 'no such relation: ' || c.table_name
           from private.export_catalogue() c
          where not exists (select 1 from pg_catalog.pg_class k
                              join pg_catalog.pg_namespace n on n.oid = k.relnamespace
                             where n.nspname = 'public' and k.relname = c.table_name and k.relkind = 'r')
         union all
         select 'no such column ' || col || ' on ' || c.table_name
           from private.export_catalogue() c
           cross join lateral pg_catalog.unnest(
             coalesce(c.scope_columns, '{}'::text[])
             || coalesce(c.projection, '{}'::text[])
             || (case when c.key_column is null then '{}'::text[] else array[c.key_column] end)) as col
          where not exists (select 1 from pg_catalog.pg_attribute a
                              join pg_catalog.pg_class k on k.oid = a.attrelid
                              join pg_catalog.pg_namespace n on n.oid = k.relnamespace
                             where n.nspname = 'public' and k.relname = c.table_name
                               and a.attname = col and a.attnum > 0 and not a.attisdropped)
         union all
         select 'duplicate catalogue row: ' || c.export_kind || '.' || c.table_name
           from private.export_catalogue() c
          group by c.export_kind, c.table_name having pg_catalog.count(*) > 1
       ) problems),
    'sound');
$$;

comment on function private.export_catalogue_is_sound() is
  'Answers `sound`, or a semicolon-joined list of everything wrong with private.export_catalogue() -- an unknown kind or disposition, an excused row with no reason, an exported row with no authorisation / scope column / key column, an ELEVATED row in the workspace export (never permitted: the whole workspace export runs under the requester''s own RLS), a table or column that does not exist, or a duplicate row. Asserted by the psql suite and by the completeness census.';

revoke all on function private.export_catalogue_is_sound() from public, anon, authenticated, service_role;

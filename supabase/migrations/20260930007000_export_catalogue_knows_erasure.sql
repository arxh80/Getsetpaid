-- ===========================================================================
-- PHASE 8 TASK 5 -- ERASURE, PART 8: THE EXPORT CATALOGUE LEARNS ABOUT THE
-- ERASURE REGISTER.
--
-- `public.erasure_jobs` has a row -> organisation path AND a row -> user
-- path, so `tests/integration/export/completeness-census.test.ts` and
-- `rls_phase8_exports.sql` § XC2/XC3 both went RED the moment the table
-- existed -- by design. That census is a two-directional equality between a
-- foreign-key walk of the live schema and the catalogue, and a new table in
-- neither disposition is exactly what it is for.
--
-- BOTH DISPOSITIONS ARE `excused`, and the reasons are on the rows below
-- rather than here. The short version: for a workspace, the only way it
-- appears on this register is as the subject of its own purge, which is the
-- platform's operational state; for a person, a SUCCEEDED job has already
-- deleted the account that would have exported it, and a queued or failed one
-- is on /account/erase live -- while `requested_by` can name the OPERATOR,
-- which is the Q167 argument about staff identities.
--
-- Re-issued from its LATEST definition, read out of pg_proc at 171
-- migrations (20260929000000 did not touch this function; 20260928001000 and
-- 20260928003000 did). Two rows added, nothing else changed.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

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
   'ELEVATED: the workspace-admin read this rests on is a permission IN a workspace, so a person who has left that workspace would silently export nothing -- while the record of support access THEY consented to or refused stays their own act. Filtered to the two columns that name them as the decider; a session they neither accepted nor declined is not theirs and is not returned. PROJECTED (20260928001000, Q167) to the columns describing their OWN decision: `reason` is the operator''s free text and `superuser_user_id` is a GetSetPaid staff identity, and neither is this person''s data -- the identical argument the sibling feedback row already applies to the support-access attribution columns, which are the operator''s record of their own session. A CURRENT workspace admin can still read the whole row through impersonation_sessions_select_target_admin; the export is for the person who has LEFT, which is the case this row is elevated for in the first place.',
   'elevated', array['admin_accepted_by','declined_by'], 'id',
   array['id','target_organisation_id','status','requested_at','admin_accepted_by','accepted_at','declined_by','declined_at','started_at','expires_at','ended_at']),

  -- ---- EXCUSED ---------------------------------------------------------
  ('account', 'erasure_jobs', 'excused',
   'The register of erasures -- metadata about the process rather than data about the person, and in practice unreachable: a SUCCEEDED account erasure has already deleted the account, so no export of that account can ever contain it. What it could hold is a QUEUED or FAILED job, and the person reads both of those on /account/erase, live, with the reason. It also names the OPERATOR as requested_by when an erasure was started on a statutory request (20260930005000), and a GetSetPaid staff identity is not this person''s data -- the Q167 argument the impersonation_sessions and feedback rows already make. Excused rather than projected, because everything left after that projection is already on their own page.',
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
  ('account', 'incident_alerts',                'excused', 'Platform operations; the account appears only as resolved_by, which is the operator acting on GetSetPaid''s own signal. Excused from both exports.', null, null, null, null)
$function$;


comment on function private.export_catalogue() is
  'WHAT AN EXPORT CONTAINS, one row per (kind, table), re-issued in 20260930007000 with public.erasure_jobs excused from both scopes. Everything else is as 20260928001000 and 20260928003000 left it: every WORKSPACE read is `requester_rls` without exception, four ACCOUNT tables are `elevated` because no client session could read them at all, and every elevated row carries a projection (a rule private.export_catalogue_is_sound() enforces). The catalogue is bound to a foreign-key walk of the live schema in both directions by tests/integration/export/completeness-census.test.ts and rls_phase8_exports.sql section XC, so a table that joins the schema and neither disposition is a red test naming itself.';

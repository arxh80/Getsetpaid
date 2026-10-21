-- ===========================================================================
-- PHASE 8 TASK 4, FIX ROUND 1 -- AN ELEVATED READ IS ALWAYS PROJECTED.
--
-- Task 4 review, finding M2, and founder question Q167.
--
-- `impersonation_sessions` is one of the four ACCOUNT tables read with
-- elevated rights, and it shipped with `projection = null` -- which means
-- `select *`. Its row scoping was and is correct (only sessions the
-- requester accepted or declined; a session in another tenant declined by
-- somebody else does not appear), but the row it returned whole carries
-- `reason`, the operator's own words justifying break-glass access, and
-- `superuser_user_id`, a GetSetPaid staff identity. Measured in the review,
-- out of a real archive.
--
-- The catalogue's own stated rule already said an elevated read of a table
-- holding more than the requester's own data must carry an explicit column
-- PROJECTION, and the sibling `feedback` row applies exactly that argument to
-- "the support-access attribution columns, which are the operator's record of
-- their own session". The same argument, not applied here.
--
-- SO TWO CHANGES, and the second is the one that matters in a year:
--
--   1. impersonation_sessions is PROJECTED to the eleven columns describing
--      the requester's OWN decision -- what was asked for, of which
--      workspace, when, who accepted or declined it and when, and the
--      session's own clock. `reason` and `superuser_user_id` are withheld.
--      The counter-argument (a person is entitled to know WHY their workspace
--      was accessed) is real and is recorded against Q167; if the founder
--      prefers it, the projection is one line and the reason must then say so
--      explicitly rather than being absent by default.
--
--   2. private.export_catalogue_is_sound() now enforces "ELEVATED IMPLIES A
--      PROJECTION" for every elevated row, so the next elevated table cannot
--      ship bare. platform_admins, whose two columns really are both the
--      requester's, names them rather than being exempted -- a total rule and
--      one line per table, instead of a judgement no query can make.
--
-- Nothing else in the catalogue changes. Both functions are rebuilt from
-- their LATEST definitions (the catalogue from 20260927000000 section 3, the
-- soundness check from 20260927002000 section 1, which added the
-- key-column-survives-the-projection rule).
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE CATALOGUE, with two projections written in.
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
  ('workspace', 'export_jobs', 'excused',
   'The register of exports themselves. It is metadata about this feature rather than a record of the business, there is no cross-member read of it (an export of it would hold only the reader''s own jobs), and it necessarily contains the job building the archive -- a record of itself. The reader sees every one of their own on the export page, live.',
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
$$;

comment on function private.export_catalogue() is
  'WHAT THE TWO EXPORTS CONTAIN, and the subject of the completeness census (Phase 8 Task 4). One row per (export_kind, table_name). disposition is exported or excused, and an excused row must say why. authorisation is requester_rls -- the read runs under role authenticated with the requester''s own claims, so every RLS policy decides exactly as it would in their browser -- or elevated, which is permitted only for a table no client role can read and must carry a reason AND an explicit column PROJECTION (enforced since 20260928001000; before it, impersonation_sessions was elevated with a null projection and therefore select *, which returned the operator''s break-glass reason and a staff user id -- Q167). The WHOLE workspace export is requester_rls, which is what makes "an Owner''s export contains no other member''s private note" true by construction. tests/integration/export/completeness-census.test.ts derives the denominator from pg_constraint (a foreign-key walk, NOT a column-name match -- four organisation paths are not called organisation_id) and fails when a table is in neither disposition.';

revoke all on function private.export_catalogue() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE SOUNDNESS CHECK, with the rule that makes it stick.
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
         -- NEW IN 20260927002000.
         select 'the key column is projected away: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported'
            and c.projection is not null
            and not (c.key_column = any (c.projection))
         union all
         -- NEW IN 20260928001000 (review finding M2). EVERY elevated row
         -- carries a projection. The catalogue's own stated rule was
         -- "elevated ... where the table holds more than the requester's own
         -- data, an explicit column PROJECTION", and that clause was prose in
         -- three places and machinery in none: impersonation_sessions shipped
         -- elevated with projection = null and therefore `select *`, handing
         -- the requester the operator's free-text reason and a staff user id.
         --
         -- The rule is written TOTAL rather than conditional, because "does
         -- this table hold more than the requester's own data" is a judgement
         -- no query can make. A table whose every column really is theirs
         -- (platform_admins) names its columns and withholds nothing; the
         -- cost of that is one line per elevated table and the benefit is
         -- that the next one cannot ship bare.
         select 'elevated without a projection: ' || c.table_name
           from private.export_catalogue() c
          where c.authorisation = 'elevated'
            and (c.projection is null
                 or pg_catalog.array_length(c.projection, 1) is null)
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
  'Answers `sound`, or a semicolon-joined list of everything wrong with private.export_catalogue(): an unknown kind or disposition, an excused row with no reason, an exported row with no authorisation / scope column / key column, a PROJECTION that drops the key column (the pager orders and resumes on it, so a projected-away key makes the second page repeat the first), an ELEVATED row with NO projection (20260928001000 -- an elevated read is select * without one, which is how the operator''s break-glass reason reached an account archive; the rule is total rather than conditional, because "does this table hold more than the requester''s own data" is a judgement no query can make), an ELEVATED row in the workspace export (never permitted -- the whole workspace export runs under the requester''s own RLS), a table or column that does not exist, or a duplicate row. Re-issued in 20260927002000 with the key-column check and in 20260928001000 with the elevated-projection one.';

revoke all on function private.export_catalogue_is_sound() from public, anon, authenticated, service_role;

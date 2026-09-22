-- ===========================================================================
-- PHASE 8 TASK 7 (Q122 / Q134): CRM WRITE AUDITING FOR EVERY TENANT-OWNED
-- TABLE A CLIENT CAN WRITE THAT PHASE 7 TASK 6b LEFT OUT.
--
-- 20260912000000 put `private.audit_crm_change()` on the eleven mutable
-- Phase 2 tables and named the rest as "NOT covered" (SECURITY.md § 7):
-- a raw `PATCH /rest/v1/events` by a valid member left no trace at all. This
-- migration attaches the SAME trigger function to sixteen more tables and
-- extends the SAME allowlist function; it writes no new trigger function.
--
-- ===========================================================================
-- THE LIST IS DERIVED, NOT COPIED FROM THE BRIEF
-- ===========================================================================
-- The denominator is every table in `public` with a foreign key to
-- `public.organisations` (plus `organisations` itself, the root) on which a
-- client role -- `authenticated` or `anon` -- holds INSERT or UPDATE, at the
-- table or at the column level. `private.audit_coverage()` below computes
-- that list from pg_constraint / has_column_privilege / pg_trigger / pg_policy
-- at call time and classifies each table; nothing in it is a hand list.
-- Measured at 207 migrations, by running that function against the
-- pre-migration catalogue, the client-writable set was 35 tables:
--
--   generic (audit_crm_change pair)     the eleven Phase 2 tables
--   dedicated audit trigger             feedback, incident_alerts, erasure_jobs,
--                                       export_jobs, network_connection_requests,
--                                       network_profiles
--   rpc_only (marker-policy guarded)    organisation_billing_overrides,
--                                       organisation_feature_overrides
--   UNAUDITED (16)                      events, event_lineup, tasks, meetings,
--                                       notes, documents, task_links,
--                                       meeting_links, note_links,
--                                       document_links, financial_entries,
--                                       network_links, organisation_memberships,
--                                       organisation_subscriptions,
--                                       merge_candidates, organisations
--
-- A STATED LIMIT OF THE DERIVATION, found on that first measurement: it sees
-- that a trigger FIRES on an operation, not what the trigger DOES. It called
-- network_profiles `dedicated` because private.audit_network_row() fires on
-- every INSERT and UPDATE -- and that writer returns early for a draft insert
-- and for every ordinary field edit, so a raw PATCH rewriting a published
-- bio left no row while the census said covered. The same blindness hid the
-- connection request's `withdrawn` transition. Both were found by reading
-- the writer, both are closed below, and the behavioural half -- one row per
-- effective write, per table -- is rls_phase8_crm_audit_p3_6.sql, which the
-- structural census does not replace.
--
-- Fifteen of the sixteen unaudited tables, plus network_profiles, get the
-- generic trigger here.
-- Three of them are OUTSIDE the brief's Phase 3-6 list and were found only
-- because the list was derived: `organisation_memberships` (an invite, a role
-- change and a revocation were all unaudited -- a role escalation left no
-- row), `organisation_subscriptions` (the platform's tier writes) and
-- `merge_candidates` (dismissing a flagged duplicate; Task 6b's "the twelve"
-- missed it). `organisations` is the one deliberate excusal, queued as a
-- question rather than done: the lifecycle RPCs already write
-- `organisation.created/.suspended/.deleted/.reinstated`, and the generic
-- trigger would write a SECOND `organisation.created` per workspace and a
-- `.soft_deleted`/`.restored` beside every lifecycle summary row -- the
-- decision about which of those shapes is wanted is not one an audit
-- extension should take silently (DECISIONS-QUEUE Q189).
--
-- Two tables the brief names are NOT client-writable and are therefore
-- outside the denominator by construction, stated so the absence reads as a
-- decision: `event_status_changes` (written only by
-- private.record_event_status_change() from an `events` write, which IS now
-- audited as event.updated carrying status old -> new) and
-- `document_versions` (dormant, SELECT-only; a trigger on a table with no
-- write path is a check that cannot see its own subject -- the day a grant
-- lands, private.audit_coverage() classifies it `unaudited` and the census
-- is red by name).
--
-- ===========================================================================
-- THE ONE RULE: STRUCTURAL COLUMNS ONLY, NEVER CONTENT
-- ===========================================================================
-- audit_events is readable by the platform superuser across every tenant.
-- 20260912000000's allowlist rule is unchanged: a value is copied into an
-- audit row only if the column is named in private.audit_crm_value_columns()
-- for that target, and the test of each entry is "could the operator learn
-- something a tenant TYPED from this value?". Everything else is recorded by
-- NAME ("body changed") and never by value. Per new table:
--
--   event               owner_user_id, event_type, status, starts_at, ends_at,
--                       venue_id, venue_room_id, deleted_at
--                       WITHHELD: name, location, ticket_link, notes
--   event_lineup        event_id, artist_id, position, billing, set_starts_at,
--                       set_ends_at, deleted_at
--                       WITHHELD: notes
--   task                owner_user_id, status, priority, due_at, reminder_at,
--                       completed_at, deleted_at
--                       WITHHELD: title, detail
--   meeting             owner_user_id, starts_at, ends_at, status, deleted_at
--                       WITHHELD: title, location, meeting_url, attendees, notes
--   note                owner_user_id, visibility, deleted_at
--                       WITHHELD: body -- a PRIVATE note's body reaching the
--                       superuser is the exact boundary Q54 and "no direct
--                       tenant-data access outside impersonation" protect.
--                       What the operator CAN learn is that a note exists,
--                       who owns it, its visibility and when it moved.
--   document            owner_user_id, mime_type, size_bytes, scan_status,
--                       scanned_at, deleted_at, bytes_purged_at, retention_class
--                       WITHHELD: filename, storage_key. A filename is typed
--                       by the uploader and routinely carries a person's name
--                       ("Contract - J Smith.pdf"); the quarantine alert
--                       (private.document_quarantine_alert) and the document
--                       audit RPC (20260902031000) both already record the id
--                       and never the filename, and this follows them.
--                       mime_type is the server-sniffed type from a closed
--                       allowlist, size_bytes a measurement, scan_status and
--                       retention_class CHECK-constrained vocabularies.
--   task_link / meeting_link / note_link / document_link
--                       parent_id, entity_type, entity_id, deleted_at
--                       (every column is structural; nothing withheld)
--   financial_entry     event_id, category, status, currency, occurred_on,
--                       supplier_contact_id, artist_id, created_by, deleted_at
--                       WITHHELD: amount_minor (money -- the artist_fee
--                       precedent), description
--   network_profile     entity_kind, entity_id, status, field_visibility,
--                       published_at, created_by, deleted_at
--                       WITHHELD: display_name, headline, bio, city, region,
--                       country, website_url, contact_email -- the published
--                       VALUES, which private.audit_network_row() already
--                       withholds for the same reason. field_visibility is a
--                       map of field NAMES to levels and carries no value.
--   network_link        network_profile_id, private_entity_type,
--                       private_entity_id, created_by, deleted_at (all structural)
--   membership          user_id, role, status, invited_by, invited_at, joined_at
--                       (no deleted_at: removing a member is a HARD delete,
--                       which the generic pair does not see -- so it gets an
--                       audit_delete trigger through private.audit_crm_row(),
--                       the contact_companies shape, as membership.deleted)
--   subscription        plan_id, billing_cycle, seat_count, status,
--                       comp_expires_at, current_period_end (all structural)
--   merge_candidate     entity_type, keep_id, duplicate_id, keep_owner_user_id,
--                       duplicate_owner_user_id, reason (CHECK: exact_email /
--                       fuzzy_name), resolution, resolved_by, deleted_at
--                       WITHHELD: label (free text), similarity
--
-- ===========================================================================
-- TWO WRITERS ON ONE TABLE, DELIBERATELY
-- ===========================================================================
-- network_profiles keeps private.audit_network_row() (20260907001000):
-- network_profile.published / .unpublished / .visibility_changed, each with
-- the visibility map. The generic trigger adds .created / .updated /
-- .soft_deleted / .restored beside them. A publish is therefore TWO rows --
-- `.published` naming the transition PRD § 15 names, and `.updated` naming
-- every column that changed in the same statement (which the dedicated row
-- never did: a publish that also rewrote `bio` recorded nothing about bio).
-- The same shape already exists for documents (document_uploaded app-side,
-- document.created here) and is the same shape events have with their
-- tenant-facing event_status_changes row. Measured and asserted in
-- rls_phase8_crm_audit_p3_6.sql § PN, not left as a surprise.
--
-- network_connection_requests does NOT get the generic trigger. It has no
-- organisation_id column -- it spans two tenants -- and its dedicated writer
-- already files INSERT and the accept/decline transitions against the side
-- whose member acted (sender for a request, recipient for an answer). What
-- that writer did NOT cover, and now does (rebuilt below from its LATEST
-- definition, 20260907001000): the SENDER's withdrawal
-- (`network_connection.withdrawn`, filed against the sender) and any other
-- effective UPDATE (`network_connection.updated`, name-only diff, filed
-- against the side whose policy admitted the write: `status = 'withdrawn'`
-- can only have come through the sender's policy, anything else through the
-- recipient's). One writer, one row per write, no duplication.
--
-- ===========================================================================
-- WHAT DOES NOT CHANGE
-- ===========================================================================
-- private.audit_crm_change() itself is NOT reissued: its body needs no
-- change for these tables (every one has `id` and `organisation_id`, and the
-- deleted_at transition rule applies wherever the column exists). Its
-- `comment on function` is reissued because the old one says "eleven".
-- The exemption (auth.uid() is null -> no row) is unchanged, and it still
-- means what 20260912000000 says: migrations, seeds, DBA repair and the
-- cascades they start. Two of those cascades now matter more and are stated:
--
--   * ON DELETE SET NULL on owner_user_id / created_by / changed_by /
--     requested_by / responded_by fires an UPDATE on these tables when an
--     auth.users row is deleted. That happens inside private.erase_account()
--     (Phase 8 Task 5), which runs from the sessionless erasure runner --
--     auth.uid() is null, the trigger skips, and that is RIGHT: a per-row
--     `note.updated {owner_user_id: <erased id> -> null}` would write the
--     erased person's stable identifier into a payload the erasure exists to
--     remove (Task 5 C1's class). The one summary row (`account.erased`,
--     counts only) is the record of that cascade.
--   * The 60-day workspace purge and every retention sweep (Task 6) run
--     sessionless from pg_cron and are recorded by their own summary rows.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE ALLOWLIST, rebuilt from its LATEST definition (20260912000000).
--    The eleven Phase 2 branches are verbatim; sixteen are added.
-- ---------------------------------------------------------------------------
create or replace function private.audit_crm_value_columns(p_target_type text)
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select case p_target_type
    -- Phase 2 (20260912000000), unchanged.
    when 'company'                 then array['owner_user_id', 'type', 'deleted_at']
    when 'contact'                 then array['owner_user_id', 'deleted_at']
    when 'contact_company'         then array['contact_id', 'company_id', 'is_primary']
    when 'agency'                  then array['owner_user_id', 'deleted_at']
    when 'artist'                  then array['owner_user_id', 'deleted_at']
    when 'artist_representation'   then array['artist_id', 'agency_id', 'contact_id',
                                              'is_exclusive', 'is_primary',
                                              'started_at', 'ended_at', 'deleted_at']
    when 'artist_fee'              then array['artist_id', 'event_id', 'occurred_on',
                                              'currency', 'deleted_at']
    when 'venue'                   then array['owner_user_id', 'deleted_at']
    when 'venue_room'              then array['venue_id', 'deleted_at']
    when 'custom_field_definition' then array['entity_type', 'field_type', 'deleted_at']
    when 'custom_field_value'      then array['field_id', 'entity_type', 'entity_id']
    -- Phase 3 (Task 7, 20261006000000).
    when 'event'                   then array['owner_user_id', 'event_type', 'status',
                                              'starts_at', 'ends_at', 'venue_id',
                                              'venue_room_id', 'deleted_at']
    when 'event_lineup'            then array['event_id', 'artist_id', 'position', 'billing',
                                              'set_starts_at', 'set_ends_at', 'deleted_at']
    -- Phase 4.
    when 'task'                    then array['owner_user_id', 'status', 'priority', 'due_at',
                                              'reminder_at', 'completed_at', 'deleted_at']
    when 'meeting'                 then array['owner_user_id', 'starts_at', 'ends_at',
                                              'status', 'deleted_at']
    when 'note'                    then array['owner_user_id', 'visibility', 'deleted_at']
    when 'document'                then array['owner_user_id', 'mime_type', 'size_bytes',
                                              'scan_status', 'scanned_at', 'deleted_at',
                                              'bytes_purged_at', 'retention_class']
    when 'task_link'               then array['parent_id', 'entity_type', 'entity_id', 'deleted_at']
    when 'meeting_link'            then array['parent_id', 'entity_type', 'entity_id', 'deleted_at']
    when 'note_link'               then array['parent_id', 'entity_type', 'entity_id', 'deleted_at']
    when 'document_link'           then array['parent_id', 'entity_type', 'entity_id', 'deleted_at']
    -- Phase 5.
    when 'financial_entry'         then array['event_id', 'category', 'status', 'currency',
                                              'occurred_on', 'supplier_contact_id', 'artist_id',
                                              'created_by', 'deleted_at']
    -- Phase 6.
    when 'network_profile'         then array['entity_kind', 'entity_id', 'status',
                                              'field_visibility', 'published_at', 'created_by',
                                              'deleted_at']
    when 'network_link'            then array['network_profile_id', 'private_entity_type',
                                              'private_entity_id', 'created_by', 'deleted_at']
    -- Found by the derivation, outside the brief's list.
    when 'membership'              then array['user_id', 'role', 'status', 'invited_by',
                                              'invited_at', 'joined_at']
    when 'subscription'            then array['plan_id', 'billing_cycle', 'seat_count', 'status',
                                              'comp_expires_at', 'current_period_end']
    when 'merge_candidate'         then array['entity_type', 'keep_id', 'duplicate_id',
                                              'keep_owner_user_id', 'duplicate_owner_user_id',
                                              'reason', 'resolution', 'resolved_by', 'deleted_at']
    else '{}'::text[]
  end;
$$;

comment on function private.audit_crm_value_columns(text) is
  'THE ONE ALLOWLIST of columns whose VALUES a CRM INSERT/UPDATE audit row may carry (Phase 7 Task 6b; extended to twenty-seven targets in Phase 8 Task 7, 20261006000000). Everything else on the row is recorded by NAME only ("body changed", never what it changed to), because audit_events is readable by the platform superuser and CLAUDE.md § Superuser dashboard keeps tenant record content off that surface. Structural columns only: ownership/assignment ids, foreign keys, booleans, numbers that were measured rather than typed, dates, deleted_at, CHECK-constrained closed vocabularies, and the network visibility map (names to levels, no values). Never notes.body, meetings.attendees, documents.filename, financial_entries.amount_minor or any free text. An unknown target type yields {} -- name-only, the fail-safe direction -- so a column added later is excluded until someone edits this function and justifies it in the migration header.';

revoke all on function private.audit_crm_value_columns(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. THE TRIGGER FUNCTION'S COMMENT, reissued (its body is unchanged --
--    20260912000000 remains its latest definition).
-- ---------------------------------------------------------------------------
comment on function private.audit_crm_change() is
  'AFTER INSERT OR UPDATE audit writer for every tenant-owned table a client can write (the eleven Phase 2 CRM tables since Phase 7 Task 6b, 20260912000000; sixteen more since Phase 8 Task 7, 20261006000000 -- events, event_lineup, tasks, meetings, notes, documents, the four *_links tables, financial_entries, network_profiles, network_links, organisation_memberships, organisation_subscriptions, merge_candidates). Sibling of private.audit_crm_row() (the hard-DELETE and merge paths) and of private.audit_network_row() (the network transitions). SECURITY DEFINER because private.log_audit_event() is granted to no client role. One trigger argument, the target_type: it is the allowlist key (private.audit_crm_value_columns), the audit target_type, and the action prefix -- <target>.created, .updated, .soft_deleted, .restored. An UPDATE row carries the NAMES of every changed column and the old/new VALUES of the allowlisted structural ones only; never user-entered content, because audit_events is superuser-readable (CLAUDE.md § Superuser dashboard). Returns early with no row when auth.uid() is null (migrations, seeds, DBA repair, sessionless cascades including the ON DELETE SET NULL cascades an account erasure runs -- and NO client path, since service_role holds no grant on these tables), and when an UPDATE changed nothing but updated_at. auth.uid() rather than row_security_active() because the latter is false inside a SECURITY DEFINER function (Task 5 I4). The organisation is resolved by live lookup so a row written during an organisations cascade cannot violate audit_events'' foreign key (20260828160000 New-1). private.audit_coverage() derives which tables carry it and which do not.';

-- ---------------------------------------------------------------------------
-- 3. ATTACHMENT. Thirty-two triggers, one statement each, so the audited set
--    is greppable -- the 20260912000000 convention.
-- ---------------------------------------------------------------------------
drop trigger if exists audit_insert on public.events;
create trigger audit_insert after insert on public.events
  for each row execute function private.audit_crm_change('event');
drop trigger if exists audit_update on public.events;
create trigger audit_update after update on public.events
  for each row execute function private.audit_crm_change('event');

drop trigger if exists audit_insert on public.event_lineup;
create trigger audit_insert after insert on public.event_lineup
  for each row execute function private.audit_crm_change('event_lineup');
drop trigger if exists audit_update on public.event_lineup;
create trigger audit_update after update on public.event_lineup
  for each row execute function private.audit_crm_change('event_lineup');

drop trigger if exists audit_insert on public.tasks;
create trigger audit_insert after insert on public.tasks
  for each row execute function private.audit_crm_change('task');
drop trigger if exists audit_update on public.tasks;
create trigger audit_update after update on public.tasks
  for each row execute function private.audit_crm_change('task');

drop trigger if exists audit_insert on public.meetings;
create trigger audit_insert after insert on public.meetings
  for each row execute function private.audit_crm_change('meeting');
drop trigger if exists audit_update on public.meetings;
create trigger audit_update after update on public.meetings
  for each row execute function private.audit_crm_change('meeting');

drop trigger if exists audit_insert on public.notes;
create trigger audit_insert after insert on public.notes
  for each row execute function private.audit_crm_change('note');
drop trigger if exists audit_update on public.notes;
create trigger audit_update after update on public.notes
  for each row execute function private.audit_crm_change('note');

drop trigger if exists audit_insert on public.documents;
create trigger audit_insert after insert on public.documents
  for each row execute function private.audit_crm_change('document');
drop trigger if exists audit_update on public.documents;
create trigger audit_update after update on public.documents
  for each row execute function private.audit_crm_change('document');

drop trigger if exists audit_insert on public.task_links;
create trigger audit_insert after insert on public.task_links
  for each row execute function private.audit_crm_change('task_link');
drop trigger if exists audit_update on public.task_links;
create trigger audit_update after update on public.task_links
  for each row execute function private.audit_crm_change('task_link');

drop trigger if exists audit_insert on public.meeting_links;
create trigger audit_insert after insert on public.meeting_links
  for each row execute function private.audit_crm_change('meeting_link');
drop trigger if exists audit_update on public.meeting_links;
create trigger audit_update after update on public.meeting_links
  for each row execute function private.audit_crm_change('meeting_link');

drop trigger if exists audit_insert on public.note_links;
create trigger audit_insert after insert on public.note_links
  for each row execute function private.audit_crm_change('note_link');
drop trigger if exists audit_update on public.note_links;
create trigger audit_update after update on public.note_links
  for each row execute function private.audit_crm_change('note_link');

drop trigger if exists audit_insert on public.document_links;
create trigger audit_insert after insert on public.document_links
  for each row execute function private.audit_crm_change('document_link');
drop trigger if exists audit_update on public.document_links;
create trigger audit_update after update on public.document_links
  for each row execute function private.audit_crm_change('document_link');

drop trigger if exists audit_insert on public.financial_entries;
create trigger audit_insert after insert on public.financial_entries
  for each row execute function private.audit_crm_change('financial_entry');
drop trigger if exists audit_update on public.financial_entries;
create trigger audit_update after update on public.financial_entries
  for each row execute function private.audit_crm_change('financial_entry');

drop trigger if exists audit_insert on public.network_profiles;
create trigger audit_insert after insert on public.network_profiles
  for each row execute function private.audit_crm_change('network_profile');
drop trigger if exists audit_update on public.network_profiles;
create trigger audit_update after update on public.network_profiles
  for each row execute function private.audit_crm_change('network_profile');

drop trigger if exists audit_insert on public.network_links;
create trigger audit_insert after insert on public.network_links
  for each row execute function private.audit_crm_change('network_link');
drop trigger if exists audit_update on public.network_links;
create trigger audit_update after update on public.network_links
  for each row execute function private.audit_crm_change('network_link');

drop trigger if exists audit_insert on public.organisation_memberships;
create trigger audit_insert after insert on public.organisation_memberships
  for each row execute function private.audit_crm_change('membership');
drop trigger if exists audit_update on public.organisation_memberships;
create trigger audit_update after update on public.organisation_memberships
  for each row execute function private.audit_crm_change('membership');

drop trigger if exists audit_insert on public.organisation_subscriptions;
create trigger audit_insert after insert on public.organisation_subscriptions
  for each row execute function private.audit_crm_change('subscription');
drop trigger if exists audit_update on public.organisation_subscriptions;
create trigger audit_update after update on public.organisation_subscriptions
  for each row execute function private.audit_crm_change('subscription');

drop trigger if exists audit_insert on public.merge_candidates;
create trigger audit_insert after insert on public.merge_candidates
  for each row execute function private.audit_crm_change('merge_candidate');
drop trigger if exists audit_update on public.merge_candidates;
create trigger audit_update after update on public.merge_candidates
  for each row execute function private.audit_crm_change('merge_candidate');

-- ---------------------------------------------------------------------------
-- 3b. THE ONE HARD DELETE THE DERIVATION FOUND. `authenticated` holds DELETE
--     on organisation_memberships (organisation_memberships_delete_manage_
--     members), so removing a member is a real client path with no row. The
--     20260828141000 shape: private.audit_crm_row('<action>', '<target>')
--     AFTER DELETE, with private.audit_crm_payload() -- rebuilt here from its
--     LATEST definition (20260828141000; the walker finds no later one) --
--     projecting the row to user_id / role / status. membership.deleted joins
--     CRM_IRREVERSIBLE_AUDIT_ACTIONS beside contact_company.deleted.
-- ---------------------------------------------------------------------------
create or replace function private.audit_crm_payload(p_target_type text, p_row jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case p_target_type
    when 'contact_company' then pg_catalog.jsonb_build_object(
      'contact_id', p_row -> 'contact_id',
      'company_id', p_row -> 'company_id',
      'is_primary', p_row -> 'is_primary')
    when 'custom_field_value' then pg_catalog.jsonb_build_object(
      'field_id',    p_row -> 'field_id',
      'entity_type', p_row -> 'entity_type',
      'entity_id',   p_row -> 'entity_id')
    when 'merge' then pg_catalog.jsonb_build_object(
      'entity_type', p_row -> 'entity_type',
      'winner_id',   p_row -> 'winner_id',
      'loser_id',    p_row -> 'loser_id')
    -- 20261006000000: a removed member. Who, which role, which state --
    -- identifiers and closed vocabularies; nothing on this table is typed.
    when 'membership' then pg_catalog.jsonb_build_object(
      'user_id', p_row -> 'user_id',
      'role',    p_row -> 'role',
      'status',  p_row -> 'status')
    else '{}'::jsonb
  end;
$$;

comment on function private.audit_crm_payload(text, jsonb) is
  'Projects a CRM row (as to_jsonb) down to the identifiers and structure an audit_crm_row() DELETE/INSERT row may carry: contact_company, custom_field_value and merge since 20260828141000, membership since 20261006000000 (Phase 8 Task 7). An unknown target type yields {} -- name-only, the fail-safe direction. Never user-entered content: audit_events is superuser-readable.';

revoke all on function private.audit_crm_payload(text, jsonb) from public, anon, authenticated, service_role;

drop trigger if exists audit_delete on public.organisation_memberships;
create trigger audit_delete after delete on public.organisation_memberships
  for each row execute function private.audit_crm_row('membership.deleted', 'membership');

-- ---------------------------------------------------------------------------
-- 4. THE NETWORK WRITER, rebuilt from its LATEST definition (20260907001000).
--    The network_profiles branch is verbatim. The connection-requests branch
--    gains the sender's withdrawal and a name-only fallback for any other
--    effective UPDATE, so the whole client-writable surface of that table is
--    covered by its one dedicated writer.
-- ---------------------------------------------------------------------------
create or replace function private.audit_network_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_action  text;
  v_org     uuid;
  v_after   jsonb;
  v_changed text[];
begin
  -- Sessionless writer: a migration, a seed, DBA repair, or a foreign-key
  -- cascade initiated by one. Not a client action, has no actor to attribute,
  -- and must not be turned into an error -- 20260828160000's early return.
  if v_actor is null then
    return null;
  end if;

  if tg_table_name = 'network_profiles' then
    -- Q81's transitions, then the visibility change. `elsif`, not independent
    -- branches: a single UPDATE that both publishes and changes visibility
    -- emits the PUBLISH row, because that is the consequential half and the
    -- payload carries the new field_visibility either way.
    --
    -- INSERT-AS-PUBLISHED FIRST (20260907001000): nothing forces an INSERT to
    -- be a draft, and publishing at creation is the same escalation as
    -- draft -> published -- so it emits the same action.
    if tg_op = 'INSERT' and new.status = 'published' then
      v_action := 'network_profile.published';
    elsif tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'published' then
      v_action := 'network_profile.published';
    elsif tg_op = 'UPDATE' and old.status = 'published' and new.status = 'draft' then
      v_action := 'network_profile.unpublished';
    elsif tg_op = 'UPDATE'
          and new.field_visibility is distinct from old.field_visibility then
      v_action := 'network_profile.visibility_changed';
    else
      -- An INSERT as a DRAFT, or an ordinary field edit. Not audited HERE --
      -- since 20261006000000 the generic private.audit_crm_change() trigger
      -- on this table records both as network_profile.created / .updated.
      return null;
    end if;

    -- LIVE LOOKUP, never new.organisation_id directly (20260828160000 New-1).
    select o.id into v_org
      from public.organisations o where o.id = new.organisation_id;

    -- IDENTIFIERS AND THE VISIBILITY MAP ONLY. No display_name, no headline,
    -- no bio, no city/region/country, no website_url, no contact_email --
    -- audit_events is superuser-readable.
    v_after := pg_catalog.jsonb_build_object(
      'entity_kind',      new.entity_kind,
      'entity_id',        new.entity_id,
      'status',           new.status,
      'field_visibility', new.field_visibility
    );

    perform private.log_audit_event(
      p_action          => v_action,
      p_target_type     => 'network_profile',
      p_organisation_id => v_org,
      p_target_id       => new.id,
      p_after           => v_after
    );

  elsif tg_table_name = 'network_connection_requests' then
    if tg_op = 'INSERT' then
      v_action := 'network_connection.requested';
    elsif tg_op = 'UPDATE' and new.status = 'accepted'
          and old.status is distinct from new.status then
      v_action := 'network_connection.accepted';
    elsif tg_op = 'UPDATE' and new.status = 'declined'
          and old.status is distinct from new.status then
      v_action := 'network_connection.declined';
    elsif tg_op = 'UPDATE' and new.status = 'withdrawn'
          and old.status is distinct from new.status then
      -- 20261006000000: the SENDER's withdrawal. Before this it was the one
      -- client-reachable transition on this table that left no row.
      v_action := 'network_connection.withdrawn';
    else
      -- 20261006000000: any OTHER effective UPDATE -- a terminal row's
      -- responded_at re-set, a profile id re-pointed -- was silently
      -- unaudited. Name-only diff, updated_at excluded, no row for a no-op.
      select coalesce(pg_catalog.array_agg(n.key order by n.key), '{}'::text[])
        into v_changed
        from pg_catalog.jsonb_each(pg_catalog.to_jsonb(new)) n
       where n.key <> 'updated_at'
         and (pg_catalog.to_jsonb(old) -> n.key) is distinct from n.value;
      if tg_op <> 'UPDATE' or pg_catalog.cardinality(v_changed) = 0 then
        return null;
      end if;
      v_action := 'network_connection.updated';
    end if;

    -- BI-TENANT (Q83), so the audit row is filed against the organisation
    -- WHOSE MEMBER PERFORMED THE ACT -- the sender for a request and for a
    -- withdrawal, the recipient for an answer. For the name-only fallback the
    -- side is the one whose UPDATE policy could have admitted the write:
    -- network_connection_requests_update_sender_withdraws requires
    -- status = 'withdrawn' after the write, so a row that is not withdrawn
    -- came through the recipient's policy. A person who is a member of BOTH
    -- organisations is attributed by the policy that admitted the write, not
    -- by membership. The other side is always in the payload.
    select o.id into v_org
      from public.organisations o
     where o.id = case when tg_op = 'INSERT' or new.status = 'withdrawn'
                       then new.from_organisation_id
                       else new.to_organisation_id end;

    v_after := pg_catalog.jsonb_build_object(
      'status',                  new.status,
      'from_organisation_id',    new.from_organisation_id,
      'to_organisation_id',      new.to_organisation_id,
      'from_network_profile_id', new.from_network_profile_id,
      'to_network_profile_id',   new.to_network_profile_id
    );
    if v_action = 'network_connection.updated' then
      v_after := v_after || pg_catalog.jsonb_build_object('changed', pg_catalog.to_jsonb(v_changed));
    end if;

    perform private.log_audit_event(
      p_action          => v_action,
      p_target_type     => 'network_connection_request',
      p_organisation_id => v_org,
      p_target_id       => new.id,
      p_after           => v_after
    );
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

comment on function private.audit_network_row() is
  'AFTER-trigger audit writer for the network surface (Q84; PRD § 15 names "Network publishing and changes to visibility" explicitly). Emits network_profile.published / .unpublished / .visibility_changed on the relevant transitions and network_connection.requested / .accepted / .declined / .withdrawn -- the last since 20261006000000 (Phase 8 Task 7), which also added network_connection.updated, a name-only diff for any other effective UPDATE on a request, so that table''s whole client-writable surface is covered by this one writer. SINCE 20260907001000, INSERT-AS-PUBLISHED also emits network_profile.published. Ordinary profile edits and draft inserts are recorded by the generic private.audit_crm_change() trigger that 20261006000000 put on network_profiles beside this one, so a publish is TWO rows: .published (the transition, with the visibility map) and .updated (every column that changed in the same statement). A TRIGGER rather than an app-side audit because network_profiles carries client grants and the anon key ships in every browser. Modelled on private.audit_crm_row (20260828160000): auth.uid() is null early return, LIVE LOOKUP of the organisation. BI-TENANT ATTRIBUTION: a connection-request row is filed against the organisation whose member performed the act -- the sender for a request and a withdrawal, the recipient for an answer, decided by the status the write leaves behind (which is what the two UPDATE policies key on); the other side is in the payload. PAYLOAD IS field_visibility AND IDENTIFIERS ONLY, NEVER A PUBLISHED FIELD''S VALUE: audit_events is superuser-readable. Calls private.log_audit_event(), which is granted to no client role -- hence SECURITY DEFINER.';

revoke all on function private.audit_network_row()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE HAND-LISTED HALF OF THE CATALOGUE, rebuilt from its LATEST
--    definition (20261005001000), with the three network_connection.* names
--    that private.audit_network_row() has written since 20260904005000 and
--    that were on NEITHER side of the catalogue (report finding 1), the two
--    this migration adds to that writer, and membership.deleted (§ 3b).
--    Same order as lib/admin/audit-actions.ts;
--    tests/unit/admin/audit-action-catalogue.test.ts asserts it.
-- ---------------------------------------------------------------------------
create or replace function private.platform_audit_actions()
returns setof text
language sql
immutable
set search_path = ''
as $$
  values
    -- The four irreversible CRM actions (CRM_IRREVERSIBLE_AUDIT_ACTIONS).
    ('contact_company.deleted'),
    ('custom_field_value.deleted'),
    ('records.merged'),
    ('records.merged.fields'),
    ('membership.deleted'),
    -- PLATFORM_AUDIT_ACTIONS, in catalogue order.
    ('organisation.created'),
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
    ('retention.swept')
$$;

comment on function private.platform_audit_actions() is
  'THE HAND-LISTED HALF OF THE AUDIT ACTION CATALOGUE (Phase 8 Task 6 fix round 2, re-review finding m-N4; Phase 8 Task 7 added the five network_connection.* names, three of which the database had written since 20260904005000 without being on either side of the catalogue): the platform actions and the four irreversible CRM actions, the same list as PLATFORM_AUDIT_ACTIONS + CRM_IRREVERSIBLE_AUDIT_ACTIONS in lib/admin/audit-actions.ts, bound to it in CI by tests/unit/admin/audit-action-catalogue.test.ts (which reads this body from the migrations) and against the live database by catalogue-bindings-match-db.test.ts and audit-actions-match-db.test.ts. IMMUTABLE and a `values` list on purpose: the catalogue is a fact about what the product writes, and a name that exists on one side only is a red test. Read by private.audit_action_catalogue().';

revoke all on function private.platform_audit_actions() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. THE COVERAGE CENSUS: which tenant-owned client-writable tables carry
--    which audit writer, DERIVED from the catalogue at call time.
-- ---------------------------------------------------------------------------
-- One row per table in `public` that (a) has a foreign key to
-- public.organisations, or IS public.organisations, and (b) a client role
-- (`authenticated`, `anon`) holds INSERT, UPDATE or DELETE on, at table or
-- column level. Every such operation is COVERED when one of these holds:
--
--   generic     INSERT by an `audit_insert` trigger and UPDATE by an
--               `audit_update` trigger, both bound to private.audit_crm_change
--               with one target argument (returned as target_type)
--   dedicated   an AFTER ROW trigger bound to a private.audit_* function that
--               fires on that operation (feedback, incident alerts, the two job
--               registers, connection requests; and the audit_crm_row DELETE
--               triggers on contact_companies / custom_field_values /
--               organisation_memberships)
--   rpc_only    every permissive policy for that operation carries a
--               transaction-marker term (`..._in_progress()`), so a direct
--               write is refused and the only writers are audited RPCs (the
--               two override tables, 20260908050000)
--
-- `uncovered_ops` lists the operations none of the three covers; `coverage`
-- is `unaudited` when that list is non-empty, else the writer that carries
-- the row-change half (generic where the pair is present, then dedicated,
-- then rpc_only). A table with only ONE of the generic pair has an uncovered
-- op, not a partial pass -- half a trigger is a hole.
-- tests/integration/admin/crm-audit-coverage-census.test.ts asserts no row is
-- `unaudited` except the declared excusals, binds `generic` to
-- CRM_AUDIT_TARGETS in both directions, pins the other two rolls by name, and
-- proves the denominator by planting a table this function must report.
create or replace function private.audit_coverage()
returns table (
  table_name    text,
  client_writes text[],
  uncovered_ops text[],
  coverage      text,
  target_type   text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tenant_tables as (
    select c.oid, c.relname
      from pg_catalog.pg_class c
     where c.relnamespace = 'public'::pg_catalog.regnamespace
       and c.relkind in ('r', 'p')
       and (c.relname = 'organisations'
            or exists (select 1 from pg_catalog.pg_constraint k
                        where k.conrelid = c.oid and k.contype = 'f'
                          and k.confrelid = 'public.organisations'::pg_catalog.regclass))
  ),
  ops as (
    -- (table, op) for every client-writable operation. Column-level grants
    -- count: has_column_privilege() answers true for a table-level grant too.
    select t.oid, t.relname, op.op
      from tenant_tables t
      cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) op(op)
     where exists (select 1
                     from pg_catalog.pg_attribute a,
                          unnest(array['authenticated', 'anon']) r
                    where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
                      and ((op.op <> 'DELETE' and pg_catalog.has_column_privilege(r, t.oid, a.attname, op.op))
                           or (op.op = 'DELETE' and pg_catalog.has_table_privilege(r, t.oid, 'DELETE'))))
  ),
  generic as (
    select g.tgrelid,
           bool_or(g.tgname = 'audit_insert' and (g.tgtype & 4) <> 0) as has_insert,
           bool_or(g.tgname = 'audit_update' and (g.tgtype & 16) <> 0) as has_update,
           min(pg_catalog.replace(pg_catalog.encode(g.tgargs, 'escape'), '\000', '')) as target,
           count(distinct pg_catalog.replace(pg_catalog.encode(g.tgargs, 'escape'), '\000', '')) as targets
      from pg_catalog.pg_trigger g
      join pg_catalog.pg_proc p on p.oid = g.tgfoid
     where not g.tgisinternal
       and p.pronamespace = 'private'::pg_catalog.regnamespace
       and p.proname = 'audit_crm_change'
     group by g.tgrelid
  ),
  covered as (
    select o.oid, o.relname, o.op,
           (g.tgrelid is not null and g.targets = 1
              and ((o.op = 'INSERT' and g.has_insert) or (o.op = 'UPDATE' and g.has_update))) as by_generic,
           exists (select 1 from pg_catalog.pg_trigger t
                     join pg_catalog.pg_proc p on p.oid = t.tgfoid
                    where t.tgrelid = o.oid and not t.tgisinternal
                      and p.pronamespace = 'private'::pg_catalog.regnamespace
                      and p.proname like 'audit\_%'
                      and (t.tgtype & 1) <> 0          -- FOR EACH ROW
                      and (t.tgtype & 66) = 0          -- AFTER (not BEFORE, not INSTEAD OF)
                      and (t.tgtype & (case o.op when 'INSERT' then 4 when 'UPDATE' then 16 else 8 end)) <> 0)
             as by_dedicated,
           (exists (select 1 from pg_catalog.pg_policy pol
                     where pol.polrelid = o.oid and pol.polpermissive
                       and pol.polcmd in ((case o.op when 'INSERT' then 'a' when 'UPDATE' then 'w' else 'd' end), '*'))
            and not exists (select 1 from pg_catalog.pg_policy pol
                     where pol.polrelid = o.oid and pol.polpermissive
                       and pol.polcmd in ((case o.op when 'INSERT' then 'a' when 'UPDATE' then 'w' else 'd' end), '*')
                       and (coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                            || coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), ''))
                           !~ '_in_progress\(\)'))
             as by_rpc_only,
           g.target
      from ops o
      left join generic g on g.tgrelid = o.oid
  )
  select c.relname::text,
         (select pg_catalog.array_agg(x.op order by x.op) from covered x where x.oid = c.oid)::text[],
         coalesce((select pg_catalog.array_agg(x.op order by x.op) from covered x
                    where x.oid = c.oid and not (x.by_generic or x.by_dedicated or x.by_rpc_only)),
                  '{}'::text[])::text[],
         (case
           when exists (select 1 from covered x where x.oid = c.oid
                         and not (x.by_generic or x.by_dedicated or x.by_rpc_only)) then 'unaudited'
           when bool_or(c.by_generic)   then 'generic'
           when bool_or(c.by_dedicated) then 'dedicated'
           else 'rpc_only'
         end)::text,
         (case when bool_or(c.by_generic) then min(c.target) end)::text
    from covered c
   group by c.oid, c.relname
   order by 1
$$;

comment on function private.audit_coverage() is
  'THE CRM WRITE-AUDIT COVERAGE CENSUS (Phase 8 Task 7, 20261006000000): one row per tenant-owned table (a foreign key to public.organisations, or organisations itself) that a client role can INSERT, UPDATE or DELETE, derived at call time from pg_constraint, has_column_privilege, pg_trigger and pg_policy -- no hand list. Each operation is covered by the generic pair (audit_crm_change, target_type returned), by a dedicated AFTER ROW private.audit_* trigger firing on it, or by policies that all carry a transaction-marker term (only audited RPCs can write). uncovered_ops names the rest and coverage is unaudited when it is non-empty. tests/integration/admin/crm-audit-coverage-census.test.ts and rls_phase8_crm_audit_p3_6.sql § PC assert that no table is unaudited except the declared excusals, bind generic to CRM_AUDIT_TARGETS both ways, and prove the denominator with a planted table. A table Phase 9 adds with a client write grant and no audit trigger is red by name.';

revoke all on function private.audit_coverage() from public, anon, authenticated, service_role;

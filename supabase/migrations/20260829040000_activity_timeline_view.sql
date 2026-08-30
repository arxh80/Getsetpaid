-- Phase 2 (Core CRM), Task 7: the shared activity timeline's aggregation.
--
-- ===========================================================================
-- WHAT THIS IS, IN ONE SENTENCE
-- ===========================================================================
-- `public.activity_events` is a read-only VIEW that projects the CRM tables
-- this phase already ships into one uniform event row, so that one keyset
-- query over one relation answers "what has happened to this record".
--
-- ===========================================================================
-- WHY A VIEW AND NOT A TABLE
-- ===========================================================================
-- The plan is explicit that the activity timeline is "not its own table -- a
-- query-time aggregation ... No dedicated activity table exists in the PRD's
-- §11 baseline list". A table would mean a second write path beside every
-- existing one (CLAUDE.md § Non-negotiable rules names a second write path as a
-- defect on its own), a backfill for every row already in the database, and a
-- durable copy of tenant data that RLS would have to re-derive from scratch.
--
-- ===========================================================================
-- WHY `security_invoker` IS THE ENTIRE ACCESS CONTROL, AND WHY THAT IS ENOUGH
-- ===========================================================================
-- `security_invoker = true` means each branch below reads its base table under
-- the CALLER'S OWN policies. There is no new policy in this migration, no
-- SECURITY DEFINER function, and no widening of any existing predicate: a row
-- appears in this view exactly when the caller could already have selected it
-- from the table it came from.
--
-- That is deliberate and it is the reason this file is short. FOLLOW-UPS.md's
-- `contact_search` lesson is that a definer body is the whole control and has
-- to re-establish every policy term by hand; a view that delegates has no body
-- to get wrong. The visible consequences are inherited rather than designed:
--
--   * A record-scoped reader (standard_user, read_only) sees only events whose
--     SOURCE ROW they can read. For `merges` that is stricter than for the
--     entity itself -- merges_select_via_winner requires BOTH sides -- so a
--     record-scoped reader can see a contact and NOT see a merge that contact
--     survived. The application says so in copy; see lib/crm/activity.ts.
--   * A merge whose loser was later hard-deleted is invisible to a
--     record-scoped reader and visible to a full-scope one, because
--     20260828170000 says exactly that about the policy. Nothing here changes
--     it and nothing here breaks on it.
--
-- ===========================================================================
-- `audit_events` IS NOT A SOURCE, AND THAT IS A DECISION NOT AN OMISSION
-- ===========================================================================
-- The obvious source for "who changed what" is closed to tenant users by
-- design -- audit_events_select_platform_superuser is the table's only SELECT
-- policy. Opening it, even through a narrow definer projection, is a decision
-- about the audit boundary and not component work, so this migration does not
-- make it. The consequence is stated rather than hidden: of the sources below,
-- ONLY `merges` records an actor. Every other event answers WHAT and WHEN and
-- has no honest answer for WHO. See the Task 7 report § 3.
--
-- ===========================================================================
-- THE ORDERING KEY -- `(occurred_at, id)`, WITH `id` SYNTHESISED
-- ===========================================================================
-- lib/list/'s cursor is `[value, id, sort]` and `id` must be a uuid: it is
-- interpolated into a PostgREST logic tree and lib/list/cursor.ts pins it to
-- the uuid shape so that half of the filter can carry no grammar characters at
-- all. A union has no natural primary key, and `created_at` alone is not
-- unique ACROSS TABLES -- two sources writing in one transaction share
-- `now()` exactly, which is not a rare tie but the ordinary case for a create
-- that also links.
--
-- So `id` is `md5(<kind>:<subject_type>:<subject_id>:<source row id>)::uuid`:
--
--   * DETERMINISTIC -- the same event has the same id on every request, so a
--     cursor made on one page still names a row on the next.
--   * UNIQUE across every branch, because the kind and the source row id are
--     both in the digest and no two branches emit the same pair.
--   * A REAL uuid, so lib/list/cursor.ts's shape check passes and the
--     tie-break clause `id.lt.<uuid>` is grammatically inert.
--
-- Its ORDER is arbitrary -- an md5 digest sorts like noise -- and that is
-- fine: a tie-break has to be total and stable, not meaningful. Two events at
-- the same instant always come back in the same order, which is the property
-- keyset pagination needs and the only one it needs. rls_phase2_crm.sql T7-T9
-- assert it on a constructed tie.
--
-- `pg_catalog.md5` and `pg_catalog` casts throughout, for the reason every
-- function in this schema pins `search_path`: a view stores parsed references,
-- and schema-qualifying is how the reference is pinned to the object meant.
--
-- ===========================================================================
-- WHAT AN EVENT'S `occurred_at` REALLY IS, PER KIND
-- ===========================================================================
-- Two of the kinds are NOT immutable log entries and the copy must not imply
-- they are:
--
--   record_updated      `updated_at`. ONE row per record, and it MOVES on
--                       every edit. It is a "last edited" marker, not a
--                       history of edits -- the schema records no such
--                       history and this view does not invent one.
--   custom_field_set    `custom_field_values.updated_at`, one row per (field,
--                       record). Same: last changed, not a history.
--
-- Everything else is genuinely append-only or state-shaped:
--   record_created      `created_at`, immutable.
--   record_deleted      `deleted_at`; the event DISAPPEARS on restore, which
--                       is correct -- the record is no longer deleted.
--   merge_absorbed /
--   merge_into          `merges.merged_at`, on an append-only table.
--   link_added          the join row's `created_at`.
--   link_removed        the join row's `deleted_at`, and ONLY for the two join
--                       tables that HAVE one.
--
-- ===========================================================================
-- WHAT THE SCHEMA CANNOT TELL US, WRITTEN DOWN RATHER THAN SMOOTHED OVER
-- ===========================================================================
--  1. `contact_companies` HAS NO `deleted_at`. Unlinking a contact from a
--     company is a hard DELETE (lib/crm/contacts.ts), so the removal leaves no
--     trace anywhere in this database and cannot appear on any timeline.
--     `artist_representations` and `venue_rooms` DO have one, so their
--     removals do appear. The asymmetry is real, it is visible to users, and
--     it is a schema fact -- not something the timeline can paper over.
--  2. `owner_user_id` IS NOT AN AUTHOR. lib/crm/contacts.ts sets it to the
--     creating user, but nothing keeps it there -- it is nullable, it is
--     ON DELETE SET NULL, and it is the record-scope column, so a future
--     reassignment feature rewrites it. `record_created` therefore emits NO
--     actor. Claiming "created by" from a column that means "assigned to" is
--     the class of false comment this phase keeps finding.
--  3. Nothing records WHICH fields an edit changed. `record_updated` can only
--     say that an edit happened.
--
-- ===========================================================================
-- PERFORMANCE: THE FILTER THAT MAKES THIS CHEAP IS `subject_type`
-- ===========================================================================
-- Every branch emits its `subject_type` as a LITERAL. A record-scoped read
-- sends `subject_type = 'contact'`, and the planner proves the other branches
-- false at plan time and never executes them -- an append over 4 branches
-- rather than 14. `subject_id = <uuid>` then reaches a real index on each
-- surviving branch, all of which already existed before this migration:
--
--   contacts / companies / agencies / artists / venues   the primary key
--   merges                merges_entity_winner_idx, merges_entity_loser_idx
--                         (entity_type, winner_id) / (entity_type, loser_id)
--   contact_companies     contact_companies_contact_company_unique (leading
--                         contact_id), contact_companies_company_id_idx
--   artist_representations  artist_representations_artist_id_idx,
--                         artist_representations_agency_id_idx
--   venue_rooms           venue_rooms_venue_id_idx
--   custom_field_values   custom_field_values_entity_idx
--                         (entity_type, entity_id)
--
-- NO INDEX IS CREATED HERE, and that is a measured claim rather than an
-- assumption -- the plans are in the Task 7 report. A view cannot carry an
-- index of its own, which is why lib/crm/activity.ts's `backedBy` names the
-- per-branch set instead of one name; that field's contract was written for
-- tables and this is the first spec in the codebase that is not one.

-- ---------------------------------------------------------------------------
-- The view.
--
-- COLUMN LIST IS THE CONTRACT. Phase 3, 4 and 5 add SOURCES by adding a
-- `union all` branch through `create or replace view`, which Postgres permits
-- only while the column list and types are unchanged. That restriction is the
-- feature: a new source cannot quietly widen the shape every consumer reads.
-- ---------------------------------------------------------------------------
create view public.activity_events
with (security_invoker = true) as

-- =========================== the entity's own row ==========================
-- Five tables, one projection, because `created_at`/`updated_at`/`deleted_at`
-- mean the same thing on all five. The CTE is referenced once, so Postgres
-- inlines it and the `subject_type` literal still prunes branches -- verified
-- in the plans in the Task 7 report, not assumed.
with subjects as (
  select 'contact'::text as subject_type, s.id, s.organisation_id,
         s.created_at, s.updated_at, s.deleted_at
    from public.contacts s
  union all
  select 'company'::text, s.id, s.organisation_id,
         s.created_at, s.updated_at, s.deleted_at
    from public.companies s
  union all
  select 'agency'::text, s.id, s.organisation_id,
         s.created_at, s.updated_at, s.deleted_at
    from public.agencies s
  union all
  select 'artist'::text, s.id, s.organisation_id,
         s.created_at, s.updated_at, s.deleted_at
    from public.artists s
  union all
  select 'venue'::text, s.id, s.organisation_id,
         s.created_at, s.updated_at, s.deleted_at
    from public.venues s
)
select
  pg_catalog.md5(e.kind || ':' || s.subject_type || ':' || s.id::text)::uuid
    as id,
  s.organisation_id,
  s.subject_type,
  s.id                    as subject_id,
  e.occurred_at,
  e.kind,
  null::uuid              as actor_user_id,
  null::text              as actor_name,
  '{}'::jsonb             as detail
from subjects s
cross join lateral (
  values ('record_created'::text, s.created_at),
         ('record_updated'::text, s.updated_at),
         ('record_deleted'::text, s.deleted_at)
) as e(kind, occurred_at)
where e.occurred_at is not null
  -- A record nobody has edited has `updated_at = created_at` (the column
  -- defaults to now() and 20260828121500's trigger only fires on a real
  -- change). Emitting both would put two events on one instant saying the
  -- same thing, and the second would be false: nothing was edited.
  and (e.kind <> 'record_updated' or s.updated_at > s.created_at)

union all

-- ================================= merges ==================================
-- TWO BRANCHES, ONE TABLE, because one merges row is an event on BOTH records
-- and it reads differently from each side. The winner absorbed something; the
-- loser was folded into something and soft-deleted. Each side gets its own
-- synthetic id (the kind is in the digest), so the two never collide even
-- though they share a source row.
--
-- THE NAMES COME OUT OF `field_resolution`, NOT OUT OF A JOIN -- the same
-- decision lib/crm/dedup.ts's mapMerge() already made and for the same reason:
-- winner_id and loser_id are polymorphic so there is no join to write, and the
-- history has to render when its subject has been hard-deleted.
--
-- ONLY `field_resolution.fields` IS READ, AND THAT HALF IS VERSION-INDEPENDENT.
-- 20260829030000 moved field_resolution from version 1 to version 2; the change
-- is confined to the CUSTOM FIELD half (`custom_fields.values`, loser-only at
-- v1, `{from, chosen, discarded}` at v2). The ordinary-column half read here
-- has carried `{from, chosen, discarded}` since v1, so this projection needs no
-- version branch -- and it deliberately does not report custom fields taken in
-- a merge, exactly as the merge history page does not.
select
  pg_catalog.md5('merge_absorbed:' || m.entity_type || ':'
                 || m.winner_id::text || ':' || m.id::text)::uuid,
  m.organisation_id,
  m.entity_type,
  m.winner_id,
  m.merged_at,
  'merge_absorbed'::text,
  m.merged_by,
  p.full_name,
  pg_catalog.jsonb_build_object(
    'other_id', m.loser_id,
    'other_name', m.field_resolution -> 'loser' -> 'before' ->> 'name',
    'fields', (
      select pg_catalog.jsonb_agg(f.k order by f.k)
        from pg_catalog.jsonb_each(
               coalesce(m.field_resolution -> 'fields',
                                   '{}'::jsonb)) as f(k, v)
       where f.v ->> 'from' = 'loser'
    )
  )
from public.merges m
-- LEFT, not inner: profiles has a "fellow member" read policy, so the row is
-- normally visible -- but merged_by names an auth.users row that may have been
-- erased, and a merge must not vanish from its record's history because the
-- person who performed it left. A null name renders as "someone in this
-- workspace", never as a missing event.
left join public.profiles p on p.id = m.merged_by

union all

select
  pg_catalog.md5('merge_into:' || m.entity_type || ':'
                 || m.loser_id::text || ':' || m.id::text)::uuid,
  m.organisation_id,
  m.entity_type,
  m.loser_id,
  m.merged_at,
  'merge_into'::text,
  m.merged_by,
  p.full_name,
  pg_catalog.jsonb_build_object(
    'other_id', m.winner_id,
    'other_name', m.field_resolution -> 'winner' -> 'before' ->> 'name',
    'fields', (
      select pg_catalog.jsonb_agg(f.k order by f.k)
        from pg_catalog.jsonb_each(
               coalesce(m.field_resolution -> 'fields',
                                   '{}'::jsonb)) as f(k, v)
       where f.v ->> 'from' = 'loser'
    )
  )
from public.merges m
left join public.profiles p on p.id = m.merged_by

union all

-- ========================== contact <-> company ============================
-- INNER JOIN TO THE OTHER END, and dropping the event when it is not visible
-- is the rule lib/crm/queries.ts's toLinkRows() already applies to this exact
-- table: "rendering '(unavailable)' would confirm that a record exists and is
-- out of reach, which is the same oracle the 404 rule exists to close."
--
-- NO `link_removed` HERE. contact_companies has no deleted_at -- unlinking is
-- a hard DELETE -- so the removal is not recorded anywhere and cannot be
-- shown. See the header, note 1.
select
  pg_catalog.md5('link_added:contact:' || cc.contact_id::text || ':'
                 || cc.id::text)::uuid,
  cc.organisation_id,
  'contact'::text,
  cc.contact_id,
  cc.created_at,
  'link_added'::text,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'company', 'other_id', co.id, 'other_name', co.name)
from public.contact_companies cc
join public.companies co
  on co.id = cc.company_id and co.organisation_id = cc.organisation_id

union all

select
  pg_catalog.md5('link_added:company:' || cc.company_id::text || ':'
                 || cc.id::text)::uuid,
  cc.organisation_id,
  'company'::text,
  cc.company_id,
  cc.created_at,
  'link_added'::text,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'contact', 'other_id', ct.id, 'other_name', ct.name)
from public.contact_companies cc
join public.contacts ct
  on ct.id = cc.contact_id and ct.organisation_id = cc.organisation_id

union all

-- ========================== artist <-> agency ==============================
-- Removals DO appear here: artist_representations is soft-deleted
-- (lib/crm/artists.ts deleteRepresentationAction -- "a soft delete, because
-- there is no other kind here"; the table has no DELETE grant).
select
  pg_catalog.md5(e.kind || ':artist:' || ar.artist_id::text || ':'
                 || ar.id::text)::uuid,
  ar.organisation_id,
  'artist'::text,
  ar.artist_id,
  e.occurred_at,
  e.kind,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'agency', 'other_id', ag.id, 'other_name', ag.name)
from public.artist_representations ar
join public.agencies ag
  on ag.id = ar.agency_id and ag.organisation_id = ar.organisation_id
cross join lateral (
  values ('link_added'::text, ar.created_at),
         ('link_removed'::text, ar.deleted_at)
) as e(kind, occurred_at)
where e.occurred_at is not null

union all

select
  pg_catalog.md5(e.kind || ':agency:' || ar.agency_id::text || ':'
                 || ar.id::text)::uuid,
  ar.organisation_id,
  'agency'::text,
  ar.agency_id,
  e.occurred_at,
  e.kind,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'artist', 'other_id', a.id, 'other_name', a.name)
from public.artist_representations ar
join public.artists a
  on a.id = ar.artist_id and a.organisation_id = ar.organisation_id
cross join lateral (
  values ('link_added'::text, ar.created_at),
         ('link_removed'::text, ar.deleted_at)
) as e(kind, occurred_at)
where e.occurred_at is not null

union all

-- ================================= rooms ===================================
-- A room is a child record, not a link, and it has no page of its own -- so
-- `other_id` is null and the renderer shows a name rather than a link. It
-- reuses `link_added`/`link_removed` rather than inventing a room-shaped kind:
-- the kind vocabulary is the part of this contract every later phase has to
-- learn, and one more entry that means "something was attached to this record"
-- is worse than reusing the entry that already means it.
--
-- It is here at all because a venue's timeline is otherwise almost empty:
-- adding a room does NOT move venues.updated_at (the trigger is per-table), so
-- without this branch the most common thing anyone does to a venue after
-- creating it would leave no trace.
select
  pg_catalog.md5(e.kind || ':venue:' || vr.venue_id::text || ':'
                 || vr.id::text)::uuid,
  vr.organisation_id,
  'venue'::text,
  vr.venue_id,
  e.occurred_at,
  e.kind,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'room', 'other_id', null, 'other_name', vr.name)
from public.venue_rooms vr
cross join lateral (
  values ('link_added'::text, vr.created_at),
         ('link_removed'::text, vr.deleted_at)
) as e(kind, occurred_at)
where e.occurred_at is not null

union all

-- =========================== custom field values ===========================
-- ONE ROW PER (field, record), carrying `updated_at` -- so this is "this field
-- was last set at T", not a history of what it was set to. It is included
-- anyway because without it a custom-field edit is INVISIBLE: the trigger that
-- maintains updated_at is per-table, so writing a custom field does not move
-- the record's own updated_at and produces no `record_updated`.
--
-- THE VALUE IS NOT CARRIED. It is the field's content, it is often the most
-- sensitive thing on the record, and a timeline that reprints it would put a
-- second copy of it in a surface with a different shape. The label answers the
-- question a timeline asks; the panel above shows the value.
--
-- LEFT JOIN to the definition: a REMOVED custom field keeps its values
-- (20260829010000 decision 1) and its history must not vanish with it. Null
-- label renders as "a custom field", not as a missing event.
select
  pg_catalog.md5('custom_field_set:' || cfv.entity_type || ':'
                 || cfv.entity_id::text || ':' || cfv.id::text)::uuid,
  cfv.organisation_id,
  cfv.entity_type,
  cfv.entity_id,
  cfv.updated_at,
  'custom_field_set'::text,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object('field_label', cfd.label)
from public.custom_field_values cfv
left join public.custom_field_definitions cfd
  on cfd.id = cfv.field_id
 and cfd.organisation_id = cfv.organisation_id;

comment on view public.activity_events is
  'Query-time aggregation of the CRM tables into one uniform event row, for the shared activity timeline. security_invoker: every branch reads its base table under the CALLER''S policies, so this view grants nothing -- a row is here exactly when the caller could already select it from its source. `id` is a synthetic md5-derived uuid (kind:subject_type:subject_id:source row id): deterministic, unique across branches, and a real uuid so lib/list/''s [value, id, sort] cursor can carry it. audit_events is deliberately NOT a source (its only SELECT policy is platform superuser), so only `merges` carries an actor. Phase 3-5 add sources with `create or replace view`, which enforces that the column list does not change.';

-- The default-privileges baseline (20260827232507) means this view arrived with
-- an empty ACL. SELECT only, and there is nothing else to grant: a view over a
-- union with a lateral is not auto-updatable, so INSERT/UPDATE/DELETE through
-- it are refused by Postgres itself and not merely ungranted.
grant select on public.activity_events to authenticated;

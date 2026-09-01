-- Phase 4 (Operations), Task 7: public.activity_events learns about the four
-- operational objects -- tasks, meetings, notes, documents.
--
-- ===========================================================================
-- WHAT THIS IS
-- ===========================================================================
-- Four new sources on the shared activity timeline, added the way
-- lib/crm/activity.ts's header (points 1-4) says a source is added: a
-- `create or replace view` that changes NOTHING about the column list. Postgres
-- refuses the statement if the nine columns change, which is the contract guard.
--
-- Every one of the four reads FROM a *_links table, so its subject is the CRM
-- record the operational object is hung off (the polymorphic (entity_type,
-- entity_id) target end). This is what makes "a task/meeting/note/document was
-- attached to this contact/event/venue" appear on THAT record's timeline.
--
--   1. task_links (join tasks)      link_added / link_removed naming the task,
--                                   PLUS task_completed keyed on the task's
--                                   completed_at (all three in one lateral).
--   2. meeting_links (join meetings) link_added / link_removed naming the meeting.
--   3. note_links (join notes)       note_added, at the link's created_at.
--   4. document_links (join documents) document_attached / document_removed.
--
-- ===========================================================================
-- FOUR NEW KINDS, AND WHY task/meeting REUSE link_added WHILE note/document DO NOT
-- ===========================================================================
-- ACTIVITY_KINDS gains `task_completed`, `note_added`, `document_attached`,
-- `document_removed` -- exactly the four the brief names, and no more. There is
-- deliberately NO `note_removed` and NO `document_added`:
--
--   * TASK and MEETING attachment REUSE link_added / link_removed, the rule the
--     venue_rooms and lineup branches set (20260901030000): "one more entry
--     meaning something was attached to this record is worse than reusing the
--     entry that already means it." A task or a meeting has a title, so the
--     existing link_added renderer names it exactly as it names a linked company.
--   * NOTE and DOCUMENT get their OWN kinds, because the brief's four-branch
--     spec asks for them and the copy differs: "A note was added about this
--     contact" and "<file> was attached" are not "Linked to ...". A note has no
--     name at all (only a body, which the timeline must NOT reprint -- the same
--     discipline custom_field_set applies to a field's value), so note_added
--     carries no other_name and its branch emits a single arm (creation only;
--     detaching a note writes no timeline entry, and there is no note_removed
--     kind to carry one). A document has a filename, so document_attached /
--     document_removed name it and the branch has both arms.
--
-- The reconciliation is recorded in the Task 7 report (§ 2): the brief's Branch
-- 1 says all four link types reuse link_added, while Branches 3 and 4 give note
-- and document their own kinds; the two readings are reconciled by letting
-- task/meeting reuse and note/document own, which keeps ACTIVITY_KINDS + the
-- renderer record total and every branch reaching a real index.
--
-- ===========================================================================
-- INDEXES -- ALL FOUR BRANCHES ARE POLYMORPHIC AND REACH A *_links_target_idx
-- ===========================================================================
-- None of the four emits a LITERAL subject_type: a link's target can be any of
-- the six CRM entities, so subject_type is the `entity_type` COLUMN -- exactly
-- the shape merges and custom_field_values already have (20260829050000). A
-- polymorphic branch is NOT eliminated at plan time; it executes on every read,
-- and stays cheap only because its index LEADS on entity_type:
--
--   task_links      -> task_links_target_idx      (entity_type, entity_id, organisation_id)
--   meeting_links   -> meeting_links_target_idx   (entity_type, entity_id, organisation_id)
--   note_links      -> note_links_target_idx      (entity_type, entity_id, organisation_id)
--   document_links  -> document_links_target_idx  (entity_type, entity_id, organisation_id)
--
-- All four target indexes are Task 1's (20260902002000), the reverse-lookup pair
-- "which tasks/notes/... are linked to this record". NO INDEX IS CREATED HERE.
-- lib/crm/activity.ts's `backedBy` gains the four names in the same change, and
-- the census in that header is updated from MEASURED plans (Task 7 report § 2),
-- not restated from memory. rls_phase4_operations.sql § OI asserts the four
-- names are REAL indexes, the half a psql suite can do.
--
-- ===========================================================================
-- security_invoker AND THE PRIVATE-NOTE PROPERTY (the security-critical bit)
-- ===========================================================================
-- The view is security_invoker (unchanged): every branch reads its base tables
-- under the CALLER'S policies. The note_added branch joins note_links -> notes,
-- so a 'private' note the caller cannot select under notes_select_by_visibility
-- (Task 2) is filtered by that policy AT THE JOIN -- a private note authored by
-- someone else never produces a note_added entry on a third party's timeline
-- read, and full scope does NOT override it (notes_select_by_visibility has no
-- full_scope term). This is asserted in rls_phase4_operations.sql § OI: the
-- author sees their own private note's note_added, a full-scope non-author does
-- not, on the SAME subject. Were the view ever switched to security_definer the
-- non-author read would leak, so the assertion is the tripwire on that change.

create or replace view public.activity_events
with (security_invoker = true) as

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
  union all
  select 'event'::text, s.id, s.organisation_id,
         s.created_at, s.updated_at, s.deleted_at
    from public.events s
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
  and (e.kind <> 'record_updated' or s.updated_at > s.created_at)

union all

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
 and cfd.organisation_id = cfv.organisation_id

union all

-- ======================= BRANCH: the lineup, event side ====================
-- INNER JOIN TO THE ARTIST (20260901030000): rendering '(unavailable)' would
-- confirm a record exists and is out of reach. Removals appear because
-- event_lineup is soft-deleted and deleted_at is a real "came off the bill".
select
  pg_catalog.md5(e.kind || ':event:' || el.event_id::text || ':'
                 || el.id::text)::uuid,
  el.organisation_id,
  'event'::text,
  el.event_id,
  e.occurred_at,
  e.kind,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'artist', 'other_id', a.id, 'other_name', a.name)
from public.event_lineup el
join public.artists a
  on a.id = el.artist_id and a.organisation_id = el.organisation_id
cross join lateral (
  values ('link_added'::text, el.created_at),
         ('link_removed'::text, el.deleted_at)
) as e(kind, occurred_at)
where e.occurred_at is not null

union all

-- ====================== BRANCH: the lineup, artist side ====================
select
  pg_catalog.md5(e.kind || ':artist:' || el.artist_id::text || ':'
                 || el.id::text)::uuid,
  el.organisation_id,
  'artist'::text,
  el.artist_id,
  e.occurred_at,
  e.kind,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'event', 'other_id', ev.id, 'other_name', ev.name)
from public.event_lineup el
join public.events ev
  on ev.id = el.event_id and ev.organisation_id = el.organisation_id
cross join lateral (
  values ('link_added'::text, el.created_at),
         ('link_removed'::text, el.deleted_at)
) as e(kind, occurred_at)
where e.occurred_at is not null

union all

-- ========================= BRANCH: the venue side ==========================
-- events.venue_id is a COLUMN with no timestamp of its own; this entry is dated
-- at the event's created_at and MOVES to the new venue when the venue changes.
-- No link_removed arm. See 20260901030000 for the full accepted limitation.
select
  pg_catalog.md5('link_added:venue:' || ev.venue_id::text || ':'
                 || ev.id::text)::uuid,
  ev.organisation_id,
  'venue'::text,
  ev.venue_id,
  ev.created_at,
  'link_added'::text,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'event', 'other_id', ev.id, 'other_name', ev.name)
from public.events ev
where ev.venue_id is not null

union all

-- ===================== BRANCH: the status history ==========================
-- public.event_status_changes -> status_changed (20260901031000, the LATEST
-- view definition before this one -- reproduced here in full because a
-- `create or replace view` replaces the whole body, so dropping this branch
-- would silently un-ship it). Skips the create-time row (from_status is null):
-- record_created already carries that instant. This branch and merges are the
-- only two that carry an actor.
select
  pg_catalog.md5('status_changed:event:' || c.event_id::text || ':'
                 || c.id::text)::uuid,
  c.organisation_id,
  'event'::text,
  c.event_id,
  c.changed_at,
  'status_changed'::text,
  c.changed_by,
  null::text,
  pg_catalog.jsonb_build_object('from', c.from_status, 'to', c.to_status)
from public.event_status_changes c
where c.from_status is not null

union all

-- ===================== TASK 7 BRANCH: tasks via task_links =================
-- POLYMORPHIC (subject_type = tl.entity_type), reaching task_links_target_idx.
-- One lateral, THREE arms: link_added / link_removed at the link's timestamps
-- (reusing the kinds, per the venue_rooms rule), and task_completed at the
-- TASK's completed_at -- the one new kind here, folded in because the join to
-- tasks is already present for the title and a general record_updated cannot
-- say "done". completed_at is nullable, so the null filter drops the two arms
-- whose timestamp is absent (an open task, or a live/undeleted link).
select
  pg_catalog.md5(e.kind || ':' || tl.entity_type || ':'
                 || tl.entity_id::text || ':' || tl.id::text)::uuid,
  tl.organisation_id,
  tl.entity_type,
  tl.entity_id,
  e.occurred_at,
  e.kind,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'task', 'other_name', t.title)
from public.task_links tl
join public.tasks t
  on t.id = tl.parent_id and t.organisation_id = tl.organisation_id
cross join lateral (
  values ('link_added'::text,     tl.created_at),
         ('link_removed'::text,    tl.deleted_at),
         ('task_completed'::text,  t.completed_at)
) as e(kind, occurred_at)
where e.occurred_at is not null

union all

-- ================== TASK 7 BRANCH: meetings via meeting_links ==============
-- POLYMORPHIC, reaching meeting_links_target_idx. Reuses link_added /
-- link_removed naming the meeting -- a meeting has a title, so the existing
-- renderer names it exactly as it names a linked company.
select
  pg_catalog.md5(e.kind || ':' || ml.entity_type || ':'
                 || ml.entity_id::text || ':' || ml.id::text)::uuid,
  ml.organisation_id,
  ml.entity_type,
  ml.entity_id,
  e.occurred_at,
  e.kind,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'meeting', 'other_name', m.title)
from public.meeting_links ml
join public.meetings m
  on m.id = ml.parent_id and m.organisation_id = ml.organisation_id
cross join lateral (
  values ('link_added'::text,   ml.created_at),
         ('link_removed'::text, ml.deleted_at)
) as e(kind, occurred_at)
where e.occurred_at is not null

union all

-- ==================== TASK 7 BRANCH: notes via note_links ==================
-- POLYMORPHIC, reaching note_links_target_idx. SINGLE ARM: note_added at the
-- link's created_at ("a note was added about this record"). NO other_name -- a
-- note has no title, and its body must NOT be reprinted on the timeline (the
-- discipline custom_field_set applies to a value). THE JOIN TO notes IS THE
-- SECURITY GATE: under security_invoker, notes_select_by_visibility filters a
-- private note the caller did not author, so it never reaches a third party's
-- timeline (§ OI). No lateral: detaching a note writes no entry (no note_removed
-- kind), matching the brief's single-kind Branch 3.
select
  pg_catalog.md5('note_added:' || nl.entity_type || ':'
                 || nl.entity_id::text || ':' || nl.id::text)::uuid,
  nl.organisation_id,
  nl.entity_type,
  nl.entity_id,
  nl.created_at,
  'note_added'::text,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object('other_type', 'note')
from public.note_links nl
join public.notes n
  on n.id = nl.parent_id and n.organisation_id = nl.organisation_id

union all

-- ================ TASK 7 BRANCH: documents via document_links ==============
-- POLYMORPHIC, reaching document_links_target_idx. document_attached /
-- document_removed naming the document by filename. The join to documents is
-- read under documents_select_view_crm (record scope), same as every other
-- branch's join.
select
  pg_catalog.md5(e.kind || ':' || dl.entity_type || ':'
                 || dl.entity_id::text || ':' || dl.id::text)::uuid,
  dl.organisation_id,
  dl.entity_type,
  dl.entity_id,
  e.occurred_at,
  e.kind,
  null::uuid,
  null::text,
  pg_catalog.jsonb_build_object(
    'other_type', 'document', 'other_name', d.filename)
from public.document_links dl
join public.documents d
  on d.id = dl.parent_id and d.organisation_id = dl.organisation_id
cross join lateral (
  values ('document_attached'::text, dl.created_at),
         ('document_removed'::text,  dl.deleted_at)
) as e(kind, occurred_at)
where e.occurred_at is not null;

comment on view public.activity_events is
  'Query-time aggregation of the CRM + operations tables into one uniform event row, for the shared activity timeline. security_invoker: every branch reads its base table under the CALLER''S policies, so a row is here exactly when the caller could already select it from its source. `id` is a synthetic md5-derived uuid (kind:subject_type:subject_id:source row id): deterministic, unique across branches, and a real uuid so lib/list/''s [value, id, sort] cursor can carry it. A create-or-replace replaces the WHOLE body, so this reproduces every branch through 20260901031000 unchanged -- the six subjects, merges x2, contact_companies x2, artist_representations x2, venue_rooms, custom_field_values, event_lineup x2, the venue side, and status_changed (event_status_changes) -- then adds four. PHASE 4 TASK 7 ADDS FOUR SOURCES, all POLYMORPHIC on the *_links entity_type column (so a link''s target CRM record is the subject) and all reaching a Task 1 *_links_target_idx: task_links (link_added/link_removed naming the task, PLUS task_completed at the task''s completed_at), meeting_links (link_added/link_removed naming the meeting), note_links (note_added only -- a note has no name and its body is never reprinted; the join to notes carries notes_select_by_visibility so a private note authored by someone else never reaches a third party''s timeline), and document_links (document_attached/document_removed naming the document by filename). task/meeting REUSE link_added/link_removed (the venue_rooms/lineup rule); note/document get their own kinds because the copy differs and the brief''s four-branch spec asks for them. BRANCH PRUNING: the four new branches are polymorphic and are NOT eliminated at plan time (like merges/custom_field_values); they stay cheap because their target index leads on entity_type. No index is created here.';

-- SELECT only, as before. A view over a union with a lateral is not
-- auto-updatable, so INSERT/UPDATE/DELETE through it are refused by Postgres
-- itself. `create or replace view` preserves the existing ACL; this grant is a
-- restatement.
grant select on public.activity_events to authenticated;

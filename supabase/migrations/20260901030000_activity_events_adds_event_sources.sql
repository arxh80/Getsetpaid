-- Phase 3 (Events), Task 6: public.activity_events learns about events.
--
-- ===========================================================================
-- WHAT THIS IS
-- ===========================================================================
-- Four new sources on the shared activity timeline, added the way
-- lib/crm/activity.ts's header (points 1-4) says a source is added: a
-- `create or replace view` that changes NOTHING about the column list.
--
--   1. `events` joins the `subjects` CTE, so an event gets record_created /
--      record_updated / record_deleted for free, under the same
--      `updated_at > created_at` guard every other entity uses.
--   2. `event_lineup` FROM THE EVENT'S SIDE -- link_added / link_removed
--      naming the artist.
--   3. `event_lineup` FROM THE ARTIST'S SIDE -- link_added / link_removed
--      naming the event. This is what makes PRD 6.3's "artist booking /
--      event history" appear on an artist's timeline.
--   4. `events.venue_id` FROM THE VENUE'S SIDE -- link_added naming the
--      event. Founder decision Q34, 2026-08-30, which REVERSES the planner's
--      default of leaving the venue timeline alone. Its accepted limitation
--      is below and is repeated on the branch itself.
--
-- NO NEW KIND IN THIS FILE. `link_added` / `link_removed` are REUSED for both
-- lineup branches and for the venue branch, which is the rule the venue_rooms
-- branch established in 20260829040000: "one more entry meaning something was
-- attached to this record is worse than reusing the entry that already means
-- it". The one kind Phase 3 Task 6 does add -- `status_changed` -- arrives in
-- 20260901031000 with the table behind it, because a kind with no source is a
-- renderer nobody can reach.
--
-- ===========================================================================
-- BRANCH 4'S ACCEPTED LIMITATION, STATED BEFORE IT IS BUILT
-- ===========================================================================
-- `public.events.venue_id` IS A COLUMN, NOT A JOIN ROW. It carries no
-- `created_at` of its own and no `deleted_at`, so there is no honest timestamp
-- for "this event was booked into this venue" and none at all for "this event
-- left this venue". The branch therefore:
--
--   * dates the entry at `events.created_at`, not at the moment the venue was
--     chosen; and
--   * MOVES with the column. Change an event's venue and the entry leaves the
--     old venue's timeline entirely and appears on the new venue's, still
--     dated at the event's creation.
--
-- That is wrong in the way a last-changed marker is wrong (20260829040000's
-- header says the same of `record_updated` and `custom_field_set`), and the
-- founder accepted it in exchange for a venue timeline that shows the venue's
-- events at all. THERE IS NO `link_removed` ARM, deliberately: inventing a
-- timestamp for a departure would be worse than omitting the event.
-- rls_phase3_events.sql section EQ asserts the move, so it is documented
-- rather than discovered.
--
-- THE FIX, IF IT IS EVER WANTED, IS A JOIN TABLE OR A HISTORY TABLE, not a
-- cleverer branch. 20260901031000 does exactly that for `status`, and the
-- shape is there to copy.
--
-- ===========================================================================
-- INDEXES -- ALL FOUR BRANCHES REACH ONE THAT ALREADY EXISTS
-- ===========================================================================
--   subjects/events        the primary key (and the tenant filter)
--   event_lineup, event    event_lineup_event_id_org_idx   (Task 1)
--   event_lineup, artist   event_lineup_artist_id_org_idx  (Task 1)
--   events, venue          events_venue_id_org_idx         (Task 1)
--
-- All four emit a LITERAL `subject_type`, so each is eliminated at plan time
-- on a read of a different type -- the property 20260829050000 measured and
-- whose over-claim it corrected. This migration does NOT restate that claim
-- from memory: the plans are in the Task 6 report, taken with
-- `explain (analyze, buffers)` on an event, an artist and a venue timeline.
--
-- NO INDEX IS CREATED HERE. lib/crm/activity.ts's `backedBy` gains the new
-- names in the same change.

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
  -- BRANCH 1 (Phase 3 Task 6). The sixth entity, and it needs nothing else:
  -- created_at / updated_at / deleted_at mean on an event exactly what they
  -- mean on the other five.
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

-- ======================= BRANCH 2: the lineup, event side ==================
-- INNER JOIN TO THE ARTIST, and dropping the entry when the artist is not
-- visible is the rule 20260829040000 already applies to contact_companies and
-- lib/crm/queries.ts's toLinkRows() applies to the lists: "rendering
-- '(unavailable)' would confirm that a record exists and is out of reach,
-- which is the same oracle the 404 rule exists to close."
--
-- REMOVALS DO APPEAR, unlike contact_companies': public.event_lineup is
-- soft-deleted (20260901000000, and there is no DELETE grant on it), so
-- `deleted_at` is a real timestamp for "this artist came off the bill".
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

-- ====================== BRANCH 3: the lineup, artist side ==================
-- The same source row read from the other end, which is what PRD 6.3's
-- "booking / event history" on an artist actually is. One event_lineup row is
-- an entry on BOTH records and each side gets its own synthetic id, because
-- the subject_type is in the digest -- the same device the two `merges`
-- branches use.
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

-- ========================= BRANCH 4: the venue side ========================
-- Founder decision Q34, 2026-08-30. THE LIMITATION IS REPEATED HERE ON THE
-- BRANCH because the header is not where somebody editing this will be
-- looking: `events.venue_id` is a COLUMN with no timestamp of its own, so
-- this entry is dated at the EVENT'S creation and it MOVES when the venue
-- changes -- off the old venue's timeline entirely, on to the new one's, still
-- carrying the old date. There is deliberately no `link_removed` arm, because
-- nothing in this schema records when an event left a venue.
--
-- `venue_id is not null` is not an optimisation. Without it every event with
-- no venue emits a row whose `subject_id` is NULL, which no reader can filter
-- to and which would sit in the view forever.
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
where ev.venue_id is not null;

comment on view public.activity_events is
  'Query-time aggregation of the CRM tables into one uniform event row, for the shared activity timeline. security_invoker: every branch reads its base table under the CALLER''S policies, so this view grants nothing -- a row is here exactly when the caller could already select it from its source. `id` is a synthetic md5-derived uuid (kind:subject_type:subject_id:source row id): deterministic, unique across branches, and a real uuid so lib/list/''s [value, id, sort] cursor can carry it. audit_events is deliberately NOT a source (its only SELECT policy is platform superuser), so only `merges` carries an actor. Phase 3-5 add sources with `create or replace view`, which enforces that the column list does not change. PHASE 3 TASK 6 ADDS FOUR SOURCES: public.events in the subjects CTE (record_created/updated/deleted), public.event_lineup from the event side and from the artist side (link_added/link_removed, reusing the kinds rather than inventing lineup-shaped ones), and public.events.venue_id from the VENUE side (link_added only). THE VENUE BRANCH CARRIES AN ACCEPTED LIMITATION (founder Q34, 2026-08-30): venue_id has no timestamp of its own, so the entry is dated at the event''s created_at and MOVES to the new venue when the venue changes, leaving the old venue''s timeline. There is no link_removed arm because no column records a departure. BRANCH PRUNING IS PARTIAL and 20260829050000''s correction still holds in shape: all four new branches emit a LITERAL subject_type and are eliminated at plan time on a non-matching read; the three polymorphic branches (merge_absorbed, merge_into, custom_field_set) are not, and stay cheap only because entity_type leads their indexes. The new branches reach event_lineup_event_id_org_idx, event_lineup_artist_id_org_idx and events_venue_id_org_idx, all of which existed before this migration; no index is created here.';

-- SELECT only, as before. A view over a union with a lateral is not
-- auto-updatable, so INSERT/UPDATE/DELETE through it are refused by Postgres
-- itself and not merely ungranted. `create or replace view` preserves the
-- existing ACL, so this grant is a restatement rather than a change -- written
-- out because a reader of this file should not have to go and check
-- 20260829040000 to know what the ACL is.
grant select on public.activity_events to authenticated;

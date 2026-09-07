-- Phase 3 (Events), Task 6: event status history, and the timeline branch on
-- top of it.
--
-- FOUNDER DECISION Q33, 2026-08-30. It REVERSES the planner's default, which
-- was that a status change would be indistinguishable from any other edit --
-- one `record_updated` marker that moves, saying "someone changed this event"
-- and nothing about what changed. For a promoter, `planned -> confirmed` and
-- `on_sale -> cancelled` are the two facts the record exists to carry, and
-- `record_updated` is the one kind 20260829040000's header explicitly calls a
-- LAST-CHANGED MARKER rather than a history. So this is the one place in the
-- CRM that keeps a real per-change history, and it is a table because that is
-- the only thing that can.
--
-- ===========================================================================
-- APPEND-ONLY, TRIGGER-WRITTEN, AND NOT REACHABLE BY THE APPLICATION AT ALL
-- ===========================================================================
-- The application NEVER writes this table. `authenticated` holds SELECT and
-- nothing else -- no INSERT, no UPDATE, no DELETE grant -- so there is no
-- write path to get wrong, no second place for lib/crm/events.ts to forget,
-- and no way for a PostgREST call to plant a false history. The rows come from
-- a trigger on public.events, which is the only writer that cannot be skipped:
-- it fires for the create/edit forms, for a merge, for an import, and for a
-- direct PATCH alike.
--
-- CONSEQUENTLY THERE ARE NO WRITE POLICIES. schema_invariants.sql D5 asserts
-- the grant/policy biconditional in BOTH directions, so an INSERT policy
-- written here "for completeness" would be RED -- correctly, because it would
-- read as a working control and be dead code.
--
-- HOW THE TRIGGER GETS PAST RLS. Not through a policy, and not through
-- `bypassrls`: the function is `security definer` and runs as the table's
-- OWNER, and PostgreSQL exempts a table's owner from row security unless the
-- table carries `force row level security`. This one deliberately does not.
-- That is the same mechanism every `private.` definer helper in this schema
-- relies on, stated here because "there are no write policies and yet rows
-- appear" is otherwise a puzzle for the next reader.
--
-- ===========================================================================
-- THE VOCABULARY IS WRITTEN A THIRD AND FOURTH TIME, AND BOUND
-- ===========================================================================
-- `to_status` and `from_status` carry their own CHECK allowlists, so the eight
-- statuses now exist in FOUR places: `events_status_check`
-- (20260901000000), the two below, and `EVENT_STATUSES` in
-- lib/crm/event-status.ts. Copying a vocabulary is a drift risk and the answer
-- is the one this repository already uses for the other copies:
-- tests/integration/crm/event-vocabularies-match-db.test.ts reads all four
-- CHECK definitions out of pg_constraint and asserts each set equals the
-- TypeScript tuple. A value added to one and not the others is red naming the
-- file that is behind.
--
-- WHY NOT A FOREIGN KEY TO A LOOKUP TABLE, or a shared domain? Because
-- `events.status` is a CHECK today and this table has to agree with THAT, not
-- with a better design of it. Introducing a domain here would leave the two
-- columns typed differently and the disagreement invisible.
--
-- WHY `from_status` IS NULLABLE. The row written at INSERT has no previous
-- status -- an event is created AT one. That row is kept (it is the honest
-- start of the history and the table is the history) and is EXCLUDED from the
-- timeline branch below, because `record_created` already says it.
--
-- ===========================================================================
-- WHAT THIS DELIBERATELY IS NOT
-- ===========================================================================
--   * NOT A WORKFLOW. The trigger RECORDS transitions; it does not validate
--     them. CLAUDE.md Scope discipline puts offers/holds/contracts out of MVP
--     and lib/crm/event-status.ts says `hold` and `confirmed` are "LABELS ON A
--     ROW, not the workflow" -- so there are no transition rules here and
--     nothing may key a state machine off this table.
--   * NOT A PANEL. There is no status-history panel on the event detail page;
--     the timeline is the surface. One more panel would be a second place to
--     read the same rows with a second pagination story.
--   * NOT AN ARTIST-SIDE OR VENUE-SIDE BRANCH. A status change is an event's
--     own news. Fanning it out to every artist on the bill would put an
--     event's edit history on to records that did not change.

create table public.event_status_changes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  event_id        uuid not null,
  from_status     text,            -- null on the row written at create
  to_status       text not null,
  changed_by      uuid references auth.users (id) on delete set null,
  changed_at      timestamptz not null default now(),
  constraint event_status_changes_event_fkey
    foreign key (event_id, organisation_id)
    references public.events (id, organisation_id) on delete cascade,
  constraint event_status_changes_to_status_check
    check (to_status in ('draft','planned','hold','confirmed','on_sale','sold_out','completed','cancelled')),
  constraint event_status_changes_from_status_check
    check (from_status is null or from_status in ('draft','planned','hold','confirmed','on_sale','sold_out','completed','cancelled'))
);

-- NO `updated_at`, and therefore no `set_updated_at` trigger. The table is
-- append-only: a row is a fact about an instant and can never be edited, so a
-- "last modified" column would be a column that is always equal to
-- `changed_at` and would put this table into rls_phase2_crm.sql L5's
-- population for no reason. L6's count of 20 is unchanged by this migration.
comment on table public.event_status_changes is
  'Append-only history of public.events.status. Written ONLY by the trigger private.record_event_status_change() -- authenticated holds SELECT and no other grant, so the application cannot write it and no PostgREST call can plant a false history. One row per real change plus one at create (from_status null). Feeds the `status_changed` branch of public.activity_events, which skips the create row because record_created already says it. Founder decision Q33, 2026-08-30. Records transitions; does NOT validate them -- hold/confirmed are labels, not a workflow (CLAUDE.md Scope discipline).';

comment on constraint event_status_changes_event_fkey on public.event_status_changes is
  'Tenant-scoped: a status row can only name an event that agrees with it about which organisation it belongs to. Without the composite form a trigger bug, or any future writer, could file an ALPHA status row against a BETA event -- the cross-tenant write 20260828001132 proved reachable on venue_rooms and closed. ON DELETE CASCADE because a hard-deleted event has no history worth keeping and nothing else references these rows.';

-- FK-covering, plus the one the timeline branch reads.
--
-- `(event_id, organisation_id, changed_at, id)` is the timeline's shape and
-- not a guess: lib/list/query.ts pins `organisation_id` by equality,
-- fetchActivityPage pins `subject_id` (this table's event_id) by equality, and
-- the keyset compares `(occurred_at, id)` -- which is `(changed_at, id)` here.
-- The leading column is `event_id` rather than `organisation_id` because it is
-- ALSO the FK's leading column, and schema_invariants.sql D3 requires that;
-- one index therefore satisfies both, which is why there is no fourth.
create index event_status_changes_organisation_id_idx
  on public.event_status_changes (organisation_id);
create index event_status_changes_event_id_org_changed_at_idx
  on public.event_status_changes (event_id, organisation_id, changed_at, id);
create index event_status_changes_changed_by_idx
  on public.event_status_changes (changed_by);

-- ---------------------------------------------------------------------------
-- The writer.
--
-- `security definer` + `set search_path = ''` is the shape every function in
-- `private` uses, for the reason 20260828120500 gives: a definer body is the
-- whole control, so every reference in it is schema-qualified and nothing is
-- resolved through a caller-controlled search_path.
--
-- IT IS NOT A `case p_entity_type` DISPATCH and must never become one.
-- tests/integration/crm/entity-dispatch-branches-match-db.test.ts enumerates
-- every function in `private` whose body contains that literal and asserts the
-- found set equals its expected set; a helper that borrowed the phrase would
-- fail that census for no reason. This function is about ONE table.
--
-- THE GUARD IS THE POINT. Without `old.status is distinct from new.status`
-- every edit to an event -- a name fix, a note, a ticket link -- writes a row
-- saying the status changed from X to X, and the timeline grows a
-- "Status changed from Planned to Planned" entry per save.
-- rls_phase3_events.sql section EM asserts the negative (an edit that does not
-- touch status writes nothing), which is the assertion that goes red when the
-- guard is removed.
--
-- `after insert or update of status`: the `of status` column list means the
-- trigger is not even considered for an UPDATE that does not mention the
-- column, and the `is distinct from` guard then covers the case where it is
-- mentioned and unchanged. Two layers, and the second is the load-bearing one
-- because PostgREST PATCHes send every column the client held.
--
-- `(select auth.uid())` is NULL for a sessionless writer (a migration, a psql
-- fixture, a service-role job). That is recorded as null rather than refused:
-- a status change that really happened must not be lost because nobody was
-- signed in, and the renderer has no actor line for this kind anyway.
-- ---------------------------------------------------------------------------
create or replace function private.record_event_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    insert into public.event_status_changes
      (organisation_id, event_id, from_status, to_status, changed_by)
    values (
      new.organisation_id,
      new.id,
      case when tg_op = 'INSERT' then null else old.status end,
      new.status,
      (select auth.uid())
    );
  end if;
  -- AFTER FOR EACH ROW: the return value is ignored.
  return null;
end;
$$;

comment on function private.record_event_status_change() is
  'AFTER INSERT OR UPDATE OF status trigger on public.events: appends one row to public.event_status_changes when the status actually changed (or when the event was created, with from_status null). SECURITY DEFINER so it writes as the table owner, which is exempt from row security -- the table has no INSERT grant and no INSERT policy, and this is the only writer. Records transitions, does not validate them.';

revoke all on function private.record_event_status_change() from public, anon, authenticated, service_role;
grant execute on function private.record_event_status_change() to authenticated;

drop trigger if exists record_status_change on public.events;
create trigger record_status_change
  after insert or update of status on public.events
  for each row
  execute function private.record_event_status_change();

-- ---------------------------------------------------------------------------
-- Grants and RLS.
--
-- The 20260827232507 default-privileges baseline means the table arrives with
-- an EMPTY ACL, so the revoke is belt-and-braces rather than the control; it
-- is written out anyway because a reader of this file should not have to go
-- and check another migration to know what the ACL is.
--
-- SELECT ONLY. This is the whole of the difference between this table and the
-- other fifteen.
-- ---------------------------------------------------------------------------
revoke all on public.event_status_changes from public, anon, authenticated, service_role;
grant select on public.event_status_changes to authenticated;

alter table public.event_status_changes enable row level security;

-- ONE POLICY, SCOPED BY THE PARENT EVENT, written inline. Three shape rules,
-- all inherited from 20260901011000 and each with a measurement behind it
-- there:
--   1. the SET form `organisation_id in (select private.permitted_organisations(...))`,
--      never the per-row `public.has_permission(...)` -- an InitPlan once per
--      statement rather than a SubPlan per row;
--   2. the parent is joined INLINE rather than behind a helper function, for
--      the same per-row-SubPlan reason, and it keeps the dependency graph
--      acyclic (no policy on `events` names this table);
--   3. THE TENANT CORRELATION TERM `p.organisation_id =
--      event_status_changes.organisation_id` IS NOT OPTIONAL. The composite FK
--      makes the two columns agree by construction, so while the FK holds this
--      term cannot change an answer and no behavioural test can see it -- and
--      the two are each other's only backstop. schema_invariants.sql D11
--      asserts it structurally (this table joins the `invariants.child_parent`
--      list in the same change) and rls_phase3_events.sql section EF's
--      technique is what would assert it behaviourally with the FK lifted.
create policy "event_status_changes_select_via_event"
  on public.event_status_changes for select to authenticated
  using (
    exists (
      select 1 from public.events p
      where p.id = event_status_changes.event_id
        and p.organisation_id = event_status_changes.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

comment on policy "event_status_changes_select_via_event" on public.event_status_changes is
  'A status row is visible exactly when its parent event is: same permission key (view_crm), same record-scope disjunction, plus the tenant-correlation term the composite FK is the only other guard for. NO SOFT-DELETE TERM, deliberately -- a deleted event still renders (the restore path), and its history has to render with it. There is no INSERT, UPDATE or DELETE policy because there is no such grant: the table is append-only and the trigger is its only writer.';

-- ---------------------------------------------------------------------------
-- BRANCH 5 on public.activity_events: `status_changed`.
--
-- The view is re-issued in full with `create or replace view`, which is the
-- mechanism 20260829040000's header names: Postgres refuses the statement if
-- the column list or the types change, so a new source cannot quietly widen
-- the shape every consumer reads. Nine columns, in the same order, again.
--
-- `where c.from_status is not null` SKIPS THE CREATE-TIME ROW. Without it
-- every event carries two entries at the same instant -- `record_created` and
-- a "status changed to Draft" that is not a change -- and they would tie on
-- `occurred_at` and be separated only by the md5 tie-break, which is noise.
-- The row stays in the TABLE, because the table is the history; the timeline
-- is a reading of it.
--
-- THIS IS THE ONE SOURCE IN THE WHOLE VIEW BESIDES `merges` THAT CARRIES AN
-- ACTOR. `changed_by` is a real answer to WHO -- it is `auth.uid()` captured
-- at write time, not `owner_user_id`, which 20260829040000's header note 2
-- explains is the record-SCOPE column and not an author. The view projects it
-- into `actor_user_id`; `actor_name` stays null because resolving it would
-- mean a join to public.profiles on every row of every timeline, and the
-- renderer for this kind says what changed rather than who changed it.
-- ---------------------------------------------------------------------------
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

-- The venue side, with 20260901030000's accepted limitation: `events.venue_id`
-- has no timestamp of its own, so this entry is dated at the event's creation
-- and MOVES to the new venue when the venue changes. No `link_removed` arm.
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

-- ===================== BRANCH 5: the status history ========================
-- The create-time row (`from_status is null`) is skipped: `record_created`
-- already carries that instant, and two entries on one timestamp saying the
-- same thing is exactly what the `record_updated` guard in the subjects branch
-- exists to prevent.
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
where c.from_status is not null;

comment on view public.activity_events is
  'Query-time aggregation of the CRM tables into one uniform event row, for the shared activity timeline. security_invoker: every branch reads its base table under the CALLER''S policies, so this view grants nothing -- a row is here exactly when the caller could already select it from its source. `id` is a synthetic md5-derived uuid (kind:subject_type:subject_id:source row id): deterministic, unique across branches, and a real uuid so lib/list/''s [value, id, sort] cursor can carry it. audit_events is deliberately NOT a source (its only SELECT policy is platform superuser). PHASE 3 TASK 6 ADDED FIVE SOURCES: public.events in the subjects CTE; public.event_lineup from the event side and from the artist side (link_added/link_removed, reused rather than lineup-shaped new kinds); public.events.venue_id from the VENUE side (link_added only, and it MOVES with the column -- venue_id has no timestamp of its own, founder Q34); and public.event_status_changes as `status_changed`, the one kind this task adds. TWO SOURCES NOW CARRY AN ACTOR, not one: `merges` (merged_by, with a name joined from profiles) and event_status_changes (changed_by, with no name -- the renderer says what changed, not who). BRANCH 5 SKIPS the create-time status row (from_status is null) because record_created already carries that instant. BRANCH PRUNING IS PARTIAL, as 20260829050000 corrected: the five new branches all emit a LITERAL subject_type and are eliminated at plan time on a non-matching read; the three polymorphic branches (merge_absorbed, merge_into, custom_field_set) are not, and stay cheap only because entity_type leads their indexes. The new branches reach event_lineup_event_id_org_idx, event_lineup_artist_id_org_idx, events_venue_id_org_idx and event_status_changes_event_id_org_changed_at_idx.';

grant select on public.activity_events to authenticated;

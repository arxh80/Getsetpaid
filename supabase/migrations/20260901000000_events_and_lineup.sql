-- Phase 3 (Events), Task 1a: public.events and public.event_lineup.
--
-- Scope note, mirroring 20260827232510's Task 1 / Task 2 split exactly: this
-- migration creates TABLES, CONSTRAINTS, INDEXES, GRANTS and two updated_at
-- triggers. It creates NO policies, NO helper functions and NO permission
-- keys. Those are Phase 3 Task 2 (20260901010000), which depends on the tables
-- created here.
--
-- RLS IS ENABLED ON BOTH TABLES AT THE BOTTOM OF THIS FILE, with zero
-- policies. RLS with no policies denies every row to every non-owner role,
-- which is the correct intermediate state: CLAUDE.md § Non-negotiable rules
-- requires RLS to be on "before the application can reach it", and a table
-- that exists for one migration with RLS off is a table that was reachable.
--
-- MEASURED CONSEQUENCE, stated here so a reviewer does not have to discover
-- it: between this migration and 20260901010000, schema_invariants.sql D4, D5
-- and D11b FAIL. They assert "every table in the list has policies" and "every
-- grant is justified by a policy", and for one task both are false by design.
-- The Task 1 report lists the exact labels and counts. The interval is the
-- safe direction -- a grant with no policy behind it reaches no rows.
--
-- ===========================================================================
-- CONVENTIONS -- inherited from 20260827232510, restated only where this file
-- makes a choice that file did not
-- ===========================================================================
--
-- (1) TENANCY. Both tables carry `organisation_id` NOT NULL with an
--     ON DELETE CASCADE FK to public.organisations, and every reference to a
--     parent row is a TENANT-SCOPED COMPOSITE foreign key
--     (parent_id, organisation_id) -> parent (id, organisation_id), the
--     technique 20260828001132 introduced after a cross-tenant write was
--     proven end to end. SECURITY.md § 10: "Every new child table needs the
--     composite form; a plain FK is the defect."
--
-- (2) NO owner_user_id ON event_lineup. A child's scope is its parent's, and a
--     second independently-writable owner column is a way for the two to
--     disagree -- 20260827232510 note (2), applied unchanged. `events` is a
--     top-level entity and carries one.
--
--     `events.owner_user_id` also carries `default auth.uid()`, which is a
--     DEVIATION FROM THE TASK BRIEF'S DDL and is deliberate: 20260828001134
--     § 2 gave the other five top-level entities that default precisely
--     because a record created by a Standard User with no owner is a record
--     they instantly cannot see, and shipping events as the one top-level
--     entity without it would reproduce the defect that migration fixed. The
--     default reads request.jwt.claims and returns NULL rather than raising
--     for a sessionless writer, so migrations, seeds and the test harness are
--     unaffected -- 20260828001134 measured that and this file relies on it.
--     It is a FLOOR, not the enforcement: Task 2's WITH CHECK still has to pin
--     owner_user_id on insert for the record-scoped roles.
--
-- (3) VALUE DOMAINS ARE CHECK CONSTRAINTS, NOT ENUM TYPES. 20260827232510
--     note (5): "Where the brief says 'enum', read 'closed value set'." The
--     Phase 3 plan says "status enum"; in this schema that is a CHECK.
--
-- (4) SOFT DELETE. `deleted_at timestamptz` on both, per CLAUDE.md
--     § Non-negotiable rules. NO DELETE GRANT on either table, for the same
--     reason the twelve CRM tables have none: soft delete is the only delete.
--
-- (5) TIMESTAMPS. UTC (`timestamptz`), and `updated_at` is maintained by a
--     trigger, added BY HAND at the bottom of this file. 20260828121500
--     rejected a DDL event trigger explicitly ("a bug in it fails every future
--     deploy") and routed the obligation to each new table's own migration.
--
--     THE TRIGGER IS NAMED `set_updated_at` ON BOTH TABLES, not
--     `events_set_updated_at` as the task brief's snippet suggested.
--     rls_phase2_crm.sql L5 asserts that every table in `public` carrying an
--     `updated_at` column has a non-internal trigger named exactly
--     `set_updated_at`, so a per-table prefix would put two new tables in
--     violation of a shipped guard and buy nothing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- events
-- A dated occasion this tenant is working on -- a club night, a festival
-- booking, a tour date. PRD § 6.5. The centre of the product's core workflow
-- (CLAUDE.md: relationship -> enquiry/hold -> booking/event -> delivery ->
-- settlement/history) and the row every later Phase 3 surface hangs off.
--
-- NOT a network object. public.events is tenant-private, like every other
-- table in this schema; nothing here may be joined into a discovery path
-- (CLAUDE.md § The private/network split).
-- ---------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id uuid default auth.uid() references auth.users (id) on delete set null,
  name text not null check (btrim(name) <> ''),

  -- PRD § 6.5's baseline is "club night, rave, tour date; extensible".
  -- `festival` and `private_hire` are added and `other` is the default, so a
  -- user is never forced to mis-file. EXTENSIBLE AT MVP MEANS "add a value in
  -- a migration", not a user-editable vocabulary: a per-tenant type table is a
  -- feature nobody has asked for and a second RLS surface.
  event_type text not null default 'other'
    check (event_type in ('club_night','rave','tour_date','festival','private_hire','other')),

  -- PRD § 6.5 verbatim, all eight. `hold` and `confirmed` are LABELS ON THIS
  -- ROW and nothing more -- the offers/holds/contracts WORKFLOW is explicitly
  -- out of MVP (CLAUDE.md § Scope discipline), and a status value is not that
  -- workflow arriving early.
  status text not null default 'draft'
    check (status in ('draft','planned','hold','confirmed','on_sale','sold_out','completed','cancelled')),

  -- NOT NULL, deliberately. This is the events list's default sort column, and
  -- a nullable sort column makes keyset ordering non-total. An event with no
  -- date agreed yet is a `draft` carrying a placeholder date, which is honest
  -- and editable; a NULL that sorts arbitrarily is not.
  starts_at timestamptz not null,
  ends_at timestamptz,

  -- Both nullable: an event is routinely created before the venue is booked,
  -- and most venues in this product have no rooms recorded at all.
  venue_id uuid,
  venue_room_id uuid,

  -- Free text, for the case where the venue is not (or not yet) a record:
  -- "TBC, south London".
  location text,

  -- DEFENCE IN DEPTH ONLY. See the comment on the constraint below. Named
  -- explicitly rather than left to Postgres' `events_ticket_link_check`,
  -- because the comment below has to name it and a system-generated name is
  -- not a contract.
  ticket_link text constraint events_ticket_link_is_http
    check (ticket_link is null or ticket_link ~* '^https?://'),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint events_ends_after_starts
    check (ends_at is null or ends_at > starts_at),

  constraint events_room_needs_a_venue
    check (venue_room_id is null or venue_id is not null)
);

comment on table public.events is
  'A dated occasion a tenant is working on (PRD § 6.5). Tenant-private; never joined into a network discovery path. Soft-deleted, never hard-deleted, and there is no DELETE grant. `status` carries the eight PRD values including `hold` and `confirmed`, which are LABELS ON THIS ROW and NOT the offers/holds/contracts workflow -- that workflow is out of MVP scope (CLAUDE.md § Scope discipline) and a status value is not it arriving early.';

comment on column public.events.starts_at is
  'NOT NULL because it is the events list''s default sort column, and a nullable sort column makes keyset ordering non-total. An undated event is a draft with a placeholder date instead.';

comment on constraint events_ticket_link_is_http on public.events is
  'DEFENCE IN DEPTH, NOT THE CONTROL. The URL protocol rule for this product lives in lib/crm/urls.ts: normaliseWebsite() is the write-side allowlist and safeHref() the render-side one, and safeHref() is what stops a stored javascript: or data: URL becoming a live link. This CHECK is a cheap second floor for a writer that reaches PostgREST directly. DO NOT DELETE EITHER OF THOSE GUARDS BELIEVING THIS COVERS THEM -- it does not run on render, and it does not normalise.';

comment on constraint events_room_needs_a_venue on public.events is
  'A room without a venue is not a location, it is a dangling id. Pairs with events_venue_room_fkey, which additionally requires the room to belong to THIS event''s venue and to this tenant.';

comment on constraint events_ends_after_starts on public.events is
  'ends_at is nullable (an event with no announced finish is ordinary); when present it must be strictly after starts_at.';

-- ---------------------------------------------------------------------------
-- The unique constraints the composite foreign keys point at.
--
-- venue_rooms gets TWO. `venue_rooms_id_org_unique` is the ordinary
-- tenant-scoped target; `venue_rooms_id_venue_org_unique` is the target of the
-- THREE-column room FK below, which pins the room to its own venue as well as
-- to the tenant. Both are redundant on their own -- `id` is already the
-- primary key -- and exist only because Postgres requires a unique constraint
-- on exactly the referenced column list. Identical trade to the five
-- 20260828001132 added and to custom_field_definitions_id_org_entity_unique.
-- ---------------------------------------------------------------------------
alter table public.venue_rooms
  add constraint venue_rooms_id_org_unique unique (id, organisation_id);
alter table public.venue_rooms
  add constraint venue_rooms_id_venue_org_unique unique (id, venue_id, organisation_id);

alter table public.events
  add constraint events_id_org_unique unique (id, organisation_id);

comment on constraint venue_rooms_id_org_unique on public.venue_rooms is
  'Redundant on its own (id is already the primary key). The ordinary tenant-scoped FK target for later phases; events_venue_room_fkey uses venue_rooms_id_venue_org_unique instead, because it pins the venue too. Check pg_constraint for referencing foreign keys before dropping.';
comment on constraint venue_rooms_id_venue_org_unique on public.venue_rooms is
  'Redundant on its own. Target of events_venue_room_fkey, the three-column FK that makes "this event''s room belongs to this event''s venue and to this event''s tenant" a constraint rather than a policy. Do not drop without dropping that FK.';
comment on constraint events_id_org_unique on public.events is
  'Redundant on its own. Target of event_lineup_event_fkey and, from 20260901001000, artist_fee_history_event_fkey -- the constraint FOLLOW-UPS.md § "Phase 3 -- events" requires to exist before artist_fee_history.event_id can be written at all. Do not drop without dropping those.';

alter table public.events
  add constraint events_venue_fkey
    foreign key (venue_id, organisation_id)
    references public.venues (id, organisation_id)
    -- THE COLUMN LIST IS LOAD-BEARING, not stylistic. A bare
    -- `on delete set null` on a COMPOSITE key nulls EVERY referencing column,
    -- organisation_id included, and organisation_id is NOT NULL -- so deleting
    -- any venue an event names would fail outright with 23502. Measured in
    -- this task by dropping the column list, deleting a referenced venue and
    -- reading the error; the Postgres 15+ column-list form restricts the SET
    -- NULL to the nullable column. Same trap, same fix, as
    -- artist_representations_contact_fkey (20260828001132's header).
    on delete set null (venue_id);

alter table public.events
  add constraint events_venue_room_fkey
    foreign key (venue_room_id, venue_id, organisation_id)
    references public.venue_rooms (id, venue_id, organisation_id)
    on delete set null (venue_room_id);

comment on constraint events_venue_fkey on public.events is
  'Tenant-scoped: an event can only name a venue that agrees with it about which organisation it belongs to. `on delete set null (venue_id)` -- the Postgres 15+ column list is REQUIRED, or the SET NULL would also null organisation_id (NOT NULL) and deleting a referenced venue would raise 23502. Both halves measured in Phase 3 Task 1.';

comment on constraint events_venue_room_fkey on public.events is
  'THREE columns, and the one place in Phase 3 that departs from the two-column norm. It makes "this event''s room belongs to this event''s venue AND to this event''s tenant" a constraint rather than a policy -- the same technique and justification as custom_field_values_definition_fkey (20260827232512), which is the existing three-column precedent (schema_invariants D9). Under MATCH SIMPLE a NULL venue_room_id skips the check entirely, which is what keeps "venue booked, room not decided" expressible.';

-- ---------------------------------------------------------------------------
-- event_lineup
-- Which artists play this event, in what order, with what billing. PRD § 6.5's
-- "lineup". Structurally modelled on venue_rooms: a child with its own
-- organisation_id, composite FKs to both parents, no owner_user_id.
-- ---------------------------------------------------------------------------
create table public.event_lineup (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  event_id uuid not null,
  artist_id uuid not null,

  position integer not null default 0 check (position >= 0 and position <= 999),

  billing text not null default 'support'
    check (billing in ('headliner','support','opener','guest','resident','other')),

  -- NOT constrained to fall inside the event's window, on purpose. A club
  -- night that starts at 22:00 on Friday routinely has a 02:00 Saturday
  -- headline slot, and events.ends_at is nullable, so there is frequently no
  -- window to be inside. Only the internal relation is enforced.
  set_starts_at timestamptz,
  set_ends_at timestamptz,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint event_lineup_set_ends_after_starts
    check (set_ends_at is null or (set_starts_at is not null and set_ends_at > set_starts_at))
);

comment on table public.event_lineup is
  'An artist''s slot on an event (PRD § 6.5, "lineup"). ORDERING IS (position, created_at, id), WHICH IS TOTAL AND STABLE, AND `position` IS DELIBERATELY NOT UNIQUE. A partial unique index cannot be deferred, so "move this artist up" would become two statements in one transaction plus a 23505 conflict path -- exactly the cost contact_companies_one_primary_per_contact imposed on Phase 2 Task 4, which is the measured precedent this decision is taken from. Duplicate positions are a display question with a deterministic tiebreak, not an integrity failure. No owner_user_id: a slot''s scope is its event''s scope (20260827232510 note (2)).';

comment on constraint event_lineup_set_ends_after_starts on public.event_lineup is
  'A set that ends without starting is nonsense, so set_ends_at requires set_starts_at. Set times are NOT required to fall inside the event''s own window: a 02:00 headline slot on a Friday-night event is ordinary, and events.ends_at is frequently NULL.';

alter table public.event_lineup
  add constraint event_lineup_event_fkey
    foreign key (event_id, organisation_id)
    references public.events (id, organisation_id) on delete cascade;

alter table public.event_lineup
  add constraint event_lineup_artist_fkey
    foreign key (artist_id, organisation_id)
    references public.artists (id, organisation_id) on delete cascade;

comment on constraint event_lineup_event_fkey on public.event_lineup is
  'Tenant-scoped: a lineup slot can only name an event that agrees with it about which organisation it belongs to. Without the composite form a user could insert a slot into another tenant''s event -- the exact write 20260828001132 proved reachable on venue_rooms and closed.';
comment on constraint event_lineup_artist_fkey on public.event_lineup is
  'Tenant-scoped, same reasoning, on the artist side.';

-- One live slot per artist per event. PARTIAL on `deleted_at is null` so that
-- removing an artist and re-adding them works -- a total unique index would
-- let the soft-deleted row block the new one forever, which is the same trap
-- artist_representations_one_current_primary_per_artist avoids temporally.
create unique index event_lineup_event_artist_live_unique
  on public.event_lineup (event_id, artist_id)
  where deleted_at is null;

comment on index public.event_lineup_event_artist_live_unique is
  'One LIVE slot per artist per event. Partial on deleted_at is null so a removed-then-re-added artist is not blocked by the soft-deleted row.';

-- ---------------------------------------------------------------------------
-- Indexes.
--
-- FK-COVERING ONLY. schema_invariants.sql D3 ("every FK in public has its
-- leading column indexed") runs against this migration, and these are what
-- satisfy it. The LIST indexes -- the
-- `(organisation_id, <sort>, id) include (owner_user_id) where deleted_at is
-- null` shape 20260828180000 established for contacts -- belong to Task 3,
-- which is the task that declares the sorts and can measure the plans. Adding
-- them here would mean shipping index definitions justified by a guess.
-- ---------------------------------------------------------------------------
create index events_organisation_id_idx       on public.events (organisation_id);
create index events_owner_user_id_idx         on public.events (owner_user_id);
create index events_venue_id_org_idx          on public.events (venue_id, organisation_id);
create index events_venue_room_id_org_idx     on public.events (venue_room_id, organisation_id);

create index event_lineup_organisation_id_idx on public.event_lineup (organisation_id);
create index event_lineup_event_id_org_idx    on public.event_lineup (event_id, organisation_id);
create index event_lineup_artist_id_org_idx   on public.event_lineup (artist_id, organisation_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers, by hand.
--
-- 20260828121500 rejected a DDL event trigger that would attach these
-- automatically ("it fires inside migrations AND inside Supabase's own
-- platform upgrades, so a bug in it fails every future deploy") and made each
-- new table's own migration responsible. rls_phase2_crm.sql L5 is the tripwire
-- and L6 counts them: 18 tables before this migration, 20 after.
--
-- The `when` clause is 20260828121500's verbatim: a no-op UPDATE must not move
-- the timestamp, or "last modified" drifts on every save-with-no-edits.
-- ---------------------------------------------------------------------------
drop trigger if exists set_updated_at on public.events;
create trigger set_updated_at before update on public.events
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.event_lineup;
create trigger set_updated_at before update on public.event_lineup
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Grants and RLS.
--
-- The 20260827232507 default-privileges baseline means both tables arrive with
-- an EMPTY ACL, so the revokes below are belt-and-braces rather than the
-- control; they are written out anyway because a reader of this file should
-- not have to go and check another migration to know what the ACL is.
--
-- NO DELETE, on either table, matching all twelve CRM tables: soft delete is
-- the only delete (CLAUDE.md § Non-negotiable rules).
--
-- RLS ON, POLICIES IN TASK 2. This is the safe order and the one "RLS on
-- before access" requires. See this file's header for the D4/D5/D11b interval
-- it opens.
-- ---------------------------------------------------------------------------
revoke all on public.events       from public, anon, authenticated, service_role;
revoke all on public.event_lineup from public, anon, authenticated, service_role;

grant select, insert, update on public.events       to authenticated;
grant select, insert, update on public.event_lineup to authenticated;

alter table public.events       enable row level security;
alter table public.event_lineup enable row level security;

-- Phase 2 (Core CRM), Task 1b: the CRM entity tables.
--
-- Companies, contacts and the join between them; agencies, artists and artist
-- representation/fee history; venues and their rooms.
--
-- Scope note, mirroring Foundation's deliberate Task 3 / Task 4 split: this
-- migration creates TABLES, CONSTRAINTS and INDEXES only. It creates NO
-- policies, NO helper functions and NO permission keys. Those are Phase 2
-- Task 2, which depends on the tables created here.
--
-- RLS *is* enabled on every table below, with zero policies, at the bottom of
-- this file. RLS with no policies denies every row to every non-owner role,
-- which is the correct intermediate state: CLAUDE.md § Non-negotiable rules
-- requires RLS to be on "before the application can reach it", and a table that
-- exists for one migration with RLS off is a table that was reachable.
--
-- ===========================================================================
-- CONVENTIONS -- these hold for every table in this file, stated once
-- ===========================================================================
--
-- (1) TENANCY. Every table carries `organisation_id` with a NOT NULL FK to
--     public.organisations ON DELETE CASCADE. That is the "reliable row ->
--     organisation path" PRD § 11 and CLAUDE.md § Tenancy model require, and
--     it is what Task 2's policies will key on. It is carried on child tables
--     (venue_rooms, artist_fee_history, ...) as well as parents, rather than
--     reached by joining up to the parent: a policy that has to join to find
--     the tenant is a policy that can be got wrong, and the cost is one uuid.
--
--     The redundancy is real -- nothing here stops a venue_room row naming a
--     different organisation than its venue. Task 2 owns closing that; see the
--     per-table notes on venue_rooms and artist_representations, and the
--     composite-FK technique used in 20260827232512 for the one case where the
--     database can enforce it outright.
--
-- (2) RECORD SCOPE (`owner_user_id`). The plan's RLS line requires
--     record-scope filtering for Standard User and Read Only ("assigned
--     records only") but names no column to filter on. Resolution, per the
--     Task 1 brief: a nullable `owner_user_id` referencing auth.users
--     ON DELETE SET NULL, set to the creating user by the application in
--     Task 4.
--
--     NULLABLE and SET NULL, not NOT NULL: a record must survive its creator's
--     account being deleted (GDPR erasure, staff turnover). An unowned record
--     is a real state, and Task 2's policy must decide what an unowned record
--     means for a Standard User rather than assuming it cannot happen.
--
--     IT IS ON THE FIVE TOP-LEVEL ENTITIES ONLY -- companies, contacts,
--     agencies, artists, venues. It is deliberately NOT on the child/join
--     tables (contact_companies, artist_representations, artist_fee_history,
--     venue_rooms). This is a documented deviation from the brief's "every
--     tenant-owned table carries owner_user_id"; the reasoning is in the Task 1
--     report and repeated at each table. Short version: a room's scope is its
--     venue's scope, and a second, independently-writable owner column on the
--     child is a way for the two to disagree -- which is a scope hole, not
--     redundancy.
--
-- (3) SOFT DELETE. `deleted_at timestamptz` on every operational entity;
--     CLAUDE.md § Non-negotiable rules says soft-delete rather than hard
--     deletion. The plan lists it for companies, contacts, artists and venues.
--     It is also added here to `agencies` and `venue_rooms` -- a deliberate
--     deviation, reasoned at each of those tables, because both are
--     operational records that later phases will reference and CLAUDE.md
--     outranks the brief.
--
--     Every child table instead cascades from its parent (ON DELETE CASCADE),
--     because a hard delete of the parent is not a thing the application does.
--
-- (4) TIMESTAMPS. `created_at` / `updated_at timestamptz not null default
--     now()`, UTC (CLAUDE.md § Non-negotiable rules). There is no
--     `set_updated_at` trigger anywhere in this schema -- Foundation does not
--     have one and none is introduced here; `updated_at` is written by the
--     application. Verified: pg_trigger has no non-internal triggers on
--     `public` at all.
--
--     Columns that are calendar facts rather than instants -- a representation
--     start date, the date a fee was agreed -- are `date`, not `timestamptz`.
--     "UTC in the database" is about instants; a booking that started on the
--     3rd started on the 3rd in every timezone, and storing it as an instant
--     invents a time of day that then shifts under conversion.
--
-- (5) VALUE DOMAINS ARE CHECK CONSTRAINTS, NOT ENUM TYPES. Foundation uses
--     `check (status in (...))` throughout (organisation_memberships.status,
--     organisation_subscriptions.billing_cycle/status) and this file matches
--     it. A native enum type buys stricter typing at the cost of ALTER TYPE
--     migrations with their own transactional caveats, and mixing both styles
--     in one schema is worse than either. Where the brief says "enum", read
--     "closed value set".
--
--     BUSINESS uniqueness rules are NOT invented here. Value-domain checks
--     (which strings are legal, is the amount negative) are integrity and
--     belong in the schema; "at most one primary company per contact" and "no
--     two rooms with the same name in a venue" are product rules that change
--     how the UI has to write, and are raised as recommendations in the Task 1
--     report rather than silently imposed. The one exception is
--     contact_companies' (contact_id, company_id) unique constraint, which
--     prevents a duplicate of the same link and is not a product rule.
--
-- (6) GRANTS. There are no `revoke all on public.<table> from anon,
--     authenticated, service_role` lines in this file, and their absence is
--     deliberate rather than an omission. 20260827232507 set an
--     ALTER DEFAULT PRIVILEGES baseline for (postgres, public), so every table
--     created below arrives with an empty ACL -- owner only, nothing for any
--     client role. Read that migration's header before adding a table
--     anywhere, and see the Task 1 report for the introspected proof that the
--     baseline actually bites.
--
--     Task 2 grants DML back narrowly, one grant per policy, exactly as
--     Foundation's design note (e) describes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- pg_trgm
-- Trigram similarity, for the fuzzy half of the dedup workflow (CLAUDE.md
-- § Domain entities: "fuzzy matches are flagged for manual review"). Enabled
-- here, with the trigram indexes below, so that Task 6 -- which builds the
-- dedup UI -- needs no schema migration of its own.
--
-- Installed into `extensions` and referenced schema-qualified
-- (extensions.gin_trgm_ops) for the same reason Foundation's functions pin
-- `search_path`: the operator class must resolve identically whatever
-- search_path the applying connection happens to carry.
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- companies
-- An organisation in the industry as this tenant records it -- a promoter, a
-- venue operator, an agency, an artist's business entity, a supplier.
--
-- NOT a network identity. public.companies is tenant-private (CLAUDE.md § The
-- private/network split); the published, discoverable counterpart is
-- network_profiles in Phase 6, a separate table by design. Nothing in this
-- file may be joined into a discovery path.
--
-- `type` is an ARRAY because PRD § 6.2 says "Companies support type(s)"
-- (plural) -- a venue that also promotes its own nights is one company with
-- two types, not two rows. Suppliers are a type tag here rather than their own
-- table, per CLAUDE.md § Decisions log ("Suppliers: not first-class at MVP").
-- ---------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id uuid references auth.users (id) on delete set null,
  name text not null check (btrim(name) <> ''),
  type text[] not null default '{}'::text[],
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The array's ELEMENT values are constrained, not just its type. A bare
  -- text[] accepts any string, which makes `type` a free-text field wearing an
  -- allowlist's clothes: the UI filters would silently miss 'Promoter' and
  -- 'promotor'. `<@` (contained by) is the array-wise test.
  --
  -- NULL elements are rejected as a side effect and that is correct, not
  -- incidental: array containment treats NULL as not-equal-to-anything, so
  -- ARRAY[NULL]::text[] <@ ARRAY['promoter'] is FALSE, not NULL (measured on
  -- this stack). The check therefore fails closed on '{NULL}'.
  --
  -- The empty array passes (`'{}' <@ anything` is true), which is intended:
  -- an untyped company is a legitimate half-entered record.
  constraint companies_type_allowed check (
    type <@ array[
      'promoter', 'venue', 'agency', 'artist_dj_business', 'supplier', 'other'
    ]::text[]
  )
);

comment on table public.companies is
  'Tenant-private company record (promoter/venue/agency/artist business/supplier). `type` is an array because PRD 6.2 allows a company to hold several types at once. Suppliers are a type tag, not a separate table (CLAUDE.md: suppliers not first-class at MVP). This is NOT a network identity -- the published counterpart is network_profiles (Phase 6) and must stay a separate table.';

comment on column public.companies.owner_user_id is
  'Record scope: the assigned/creating user, for the Standard User and Read Only "assigned records only" rule. Nullable and ON DELETE SET NULL -- a record must outlive its creator''s account. Task 2''s policy decides what an unowned record means.';

create index companies_organisation_id_idx
  on public.companies (organisation_id);
create index companies_owner_user_id_idx
  on public.companies (owner_user_id);

-- ---------------------------------------------------------------------------
-- contacts
-- A person, as this tenant records them. PRD § 6.2 fixes the field list:
-- "name, company, email, socials, website; extensible with phone, title,
-- location and tags". `company` is the join table below, not a column.
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id uuid references auth.users (id) on delete set null,
  name text not null check (btrim(name) <> ''),
  email text,
  phone text,
  title text,
  location text,
  -- A bag of platform -> handle/URL. jsonb rather than columns because the set
  -- of platforms a live-events contact uses changes faster than a migration
  -- cadence (SoundCloud, Bandcamp, Instagram, whatever is next).
  --
  -- Pinned to an OBJECT: without this, `socials` accepts a bare string, a
  -- number or `null` as valid jsonb, and every reader has to defend against
  -- three shapes. Values inside it are still untrusted -- URL protocol
  -- validation (reject javascript:/data:, CLAUDE.md § Non-negotiable rules) is
  -- an application-layer job on the way in and on the way out, and cannot be
  -- expressed here.
  socials jsonb not null default '{}'::jsonb
    check (jsonb_typeof(socials) = 'object'),
  website text,
  tags text[] not null default '{}'::text[],
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.contacts is
  'Tenant-private person record. Company membership lives in contact_companies (many-to-many), never as a column here. `socials` is a jsonb object of platform -> handle; its values are untrusted user content and need protocol validation in the application (CLAUDE.md § Non-negotiable rules), which no constraint here can do. Tenant-private -- not a network identity.';

comment on column public.contacts.tags is
  'Free-text labels. Deliberately NOT allowlisted, unlike companies.type: tags are user-defined by design (PRD 6.2 lists them as an extension of the contact record), where company type is a fixed product vocabulary the UI filters on.';

create index contacts_organisation_id_idx
  on public.contacts (organisation_id);
create index contacts_owner_user_id_idx
  on public.contacts (owner_user_id);

-- Dedup, exact-match half. CLAUDE.md § Domain entities: "exact matches
-- (email/name) auto-merge". That lookup is
--   where organisation_id = $1 and lower(email) = lower($2) and deleted_at is null
-- and without this index it is a sequential scan on every contact insert.
--
-- Scoped by organisation_id first because duplicate detection never crosses a
-- tenant boundary -- two tenants holding the same booking agent's email are
-- not duplicates of each other, and a cross-tenant merge is the worst outcome
-- this feature could produce.
--
-- Deliberately NOT a unique constraint. Auto-merge is a workflow that runs
-- after the write, and legitimate bulk imports arrive with duplicates that the
-- merge queue resolves; a unique index would turn that into a failed import.
create index contacts_org_email_lower_idx
  on public.contacts (organisation_id, lower(email))
  where deleted_at is null and email is not null;

-- ---------------------------------------------------------------------------
-- contact_companies
-- Many-to-many between contacts and companies, founder-confirmed (see
-- .superpowers/sdd/phase-2-core-crm/progress.md). PRD § 6.2 states "multiple
-- contacts per company" and that a contact "belongs to companies" (plural) but
-- never closes the reverse cardinality; the founder read it as many-to-many,
-- on the grounds that an agent who works at an agency and also owns a promoter
-- company is ordinary in this industry.
--
-- NO owner_user_id (convention (2)): this row's record scope is the scope of
-- the contact and the company it joins. A separately-writable owner here could
-- disagree with both, which is a hole rather than a feature.
--
-- Both FKs CASCADE: a link to a hard-deleted parent is meaningless. In normal
-- operation neither parent is ever hard-deleted (both carry deleted_at), so
-- this fires only on genuine removal -- an organisation cascade, or DBA repair.
-- ---------------------------------------------------------------------------
create table public.contact_companies (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Integrity, not a product rule: the same contact linked to the same company
  -- twice is a duplicate row, never a meaningful second relationship.
  constraint contact_companies_contact_company_unique unique (contact_id, company_id)
);

comment on table public.contact_companies is
  'Many-to-many join between contacts and companies (founder-confirmed reading of PRD 6.2, which states the cardinality in only one direction). No owner_user_id: record scope derives from the contact and company being joined. is_primary is NOT constrained to one row per contact -- see the Task 1 report, which recommends a partial unique index and explains why that is a Task 4 write-path decision rather than one to impose here.';

comment on column public.contact_companies.is_primary is
  'Marks the contact''s main company affiliation. Nothing enforces at-most-one per contact yet; a partial unique index (contact_id) where is_primary would, at the cost of making "change the primary" a two-statement operation. Recommended, not decided.';

create index contact_companies_organisation_id_idx
  on public.contact_companies (organisation_id);
-- contact_id is the leading column of contact_companies_contact_company_unique
-- above, so that FK is already indexed -- no separate index. company_id is not,
-- and "who works at this company" is the primary read direction of this table.
create index contact_companies_company_id_idx
  on public.contact_companies (company_id);

-- ---------------------------------------------------------------------------
-- agencies
-- Booking/management agencies. Its own table per PRD § 11's baseline list --
-- unlike Supplier, which CLAUDE.md resolved down to a companies.type tag.
--
-- NAME ONLY. The PRD gives agencies no fields beyond identity, and none are
-- invented here; anything an agency needs later (address, contacts, socials)
-- arrives as an additive migration when a screen actually needs it.
--
-- DELETED_AT IS A DELIBERATE ADDITION beyond the plan's field list. The plan
-- lists soft delete for companies/contacts/artists/venues and is silent on
-- agencies, but CLAUDE.md § Non-negotiable rules ("soft-delete operational
-- records rather than hard deletion") outranks the brief, and an agency is an
-- operational record of exactly the same class as the other four. It also has
-- a concrete consequence: artist_representations references agencies ON DELETE
-- CASCADE, so without a soft-delete marker, removing an agency that has folded
-- destroys the representation history of every artist it ever handled.
-- ---------------------------------------------------------------------------
create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id uuid references auth.users (id) on delete set null,
  name text not null check (btrim(name) <> ''),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agencies is
  'Booking/management agency. Name-only at MVP -- PRD 11 lists the table and PRD 6.3 describes agents managing artists, but defines no agency fields, and none are invented here. deleted_at is an addition beyond the plan (CLAUDE.md soft-delete rule): artist_representations cascades from this table, so a hard delete would take an artist''s representation history with it.';

create index agencies_organisation_id_idx
  on public.agencies (organisation_id);
create index agencies_owner_user_id_idx
  on public.agencies (owner_user_id);

-- ---------------------------------------------------------------------------
-- artists
-- Artist/DJ record. PRD § 6.3 field list: "name, genres, country, city, fee
-- information, agents, socials, website, rider(s), photos/EPK and notes".
--
-- Three of those are deliberately NOT columns here:
--   fee information -> artist_fee_history, because PRD 6.3 is explicit that it
--                      must be "fee history by booking/date/currency rather
--                      than a single mutable number".
--   agents          -> artist_representations, which carries the role,
--                      territory and exclusivity the PRD asks for.
--   riders, EPK     -> documents (Phase 4). They are files, and files go
--                      through the malware-scan/private-bucket pipeline in
--                      SECURITY.md § 6, not into a text column here.
-- ---------------------------------------------------------------------------
create table public.artists (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id uuid references auth.users (id) on delete set null,
  name text not null check (btrim(name) <> ''),
  genres text[] not null default '{}'::text[],
  country text,
  city text,
  socials jsonb not null default '{}'::jsonb
    check (jsonb_typeof(socials) = 'object'),
  website text,
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.artists is
  'Tenant-private artist/DJ record. Fees live in artist_fee_history (PRD 6.3 requires fee history, "rather than a single mutable number"), representation in artist_representations, and riders/EPKs in documents (Phase 4) because they are files and must go through the SECURITY.md s6 upload pipeline. `genres` is free text -- there is no agreed genre vocabulary in this industry and inventing one would be a product decision.';

comment on column public.artists.country is
  'Free text, not an ISO 3166 code. No screen or integration consumes it as a code yet, and a code column would need a lookup table and a migration path for the free-text values the import flow will produce. Revisit when something actually needs to match on it.';

create index artists_organisation_id_idx
  on public.artists (organisation_id);
create index artists_owner_user_id_idx
  on public.artists (owner_user_id);

-- ---------------------------------------------------------------------------
-- artist_representations
-- Who represents an artist, where, and in what capacity. PRD § 6.3: "One agent
-- can manage multiple artists" and "Support more than one representation
-- relationship per artist, with territory and role where needed" -- so this is
-- a table, not a column on artists, and it deliberately has no uniqueness
-- constraint on (artist_id, agency_id): the same agency representing the same
-- artist in two territories, or over two separate periods, is exactly the case
-- the PRD asks for.
--
-- `contact_id` is the named individual agent at that agency, where the tenant
-- knows one. Nullable because "represented by Agency X" is a complete fact on
-- its own, and ON DELETE SET NULL rather than CASCADE because losing the named
-- agent must not delete the representation.
--
-- NO owner_user_id (convention (2)): scope follows the artist.
-- ---------------------------------------------------------------------------
create table public.artist_representations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  artist_id uuid not null references public.artists (id) on delete cascade,
  agency_id uuid not null references public.agencies (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  -- FREE TEXT AT MVP, deliberately. PRD 6.3 names `role` and `territory` as
  -- required attributes and defines no value domain for either. Enumerating
  -- them here would be inventing product vocabulary ("booking agent" vs
  -- "manager" vs "management"; "UK" vs "GB" vs "United Kingdom") with no
  -- founder input and no usage data. Revisit as closed value sets once real
  -- data shows what people actually type -- that is a migration, and a cheap
  -- one, whereas guessing wrong now is a data-cleanup exercise.
  role text,
  territory text,
  is_exclusive boolean not null default false,
  is_primary boolean not null default false,
  -- `date`, not timestamptz: a representation starting on the 3rd started on
  -- the 3rd everywhere. See convention (4).
  started_at date,
  ended_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Both nullable (an open-ended or undated relationship is normal), so the
  -- check only bites when both are present.
  constraint artist_representations_period_ordered check (
    started_at is null or ended_at is null or ended_at >= started_at
  )
);

comment on table public.artist_representations is
  'Representation of an artist by an agency, optionally through a named contact. Intentionally NOT unique on (artist_id, agency_id): PRD 6.3 requires more than one representation relationship per artist, which includes the same agency in different territories or over different periods. role and territory are free text at MVP -- the PRD names them and defines no value domain; enumerating them would be inventing product vocabulary. ended_at IS NULL means current. No owner_user_id: record scope follows the artist.';

comment on column public.artist_representations.is_primary is
  'The artist''s main representation. As with contact_companies.is_primary, at-most-one-per-artist is not enforced; see the Task 1 report.';

create index artist_representations_organisation_id_idx
  on public.artist_representations (organisation_id);
create index artist_representations_artist_id_idx
  on public.artist_representations (artist_id);
-- "Which artists does this agency represent?" is PRD 6.3's "one agent can
-- manage multiple artists" read direction, so this FK earns its index twice.
create index artist_representations_agency_id_idx
  on public.artist_representations (agency_id);
create index artist_representations_contact_id_idx
  on public.artist_representations (contact_id);

-- ---------------------------------------------------------------------------
-- artist_fee_history
-- What an artist was paid, when, in what currency. PRD § 6.3: "Fee history by
-- booking/date/currency rather than a single mutable number."
--
-- EVENT_ID HAS NO FOREIGN KEY YET, AND THAT IS THE POINT OF THIS COMMENT.
-- public.events does not exist until Phase 3, so the constraint cannot be
-- written here. Phase 3's events migration MUST add it:
--
--     alter table public.artist_fee_history
--       add constraint artist_fee_history_event_id_fkey
--       foreign key (event_id) references public.events (id) on delete set null;
--
-- SET NULL, not CASCADE: the fee is a historical fact about the artist that
-- outlives the event record it happened to be attached to. Until that
-- constraint exists, event_id is an unvalidated uuid -- nothing stops a row
-- naming an event that does not exist, or one in another tenant. It is
-- nullable for a second, independent reason the FK will not change: PRD 6.3
-- wants fee history entered for bookings that predate the system entirely,
-- which have no event row and never will.
-- ---------------------------------------------------------------------------
create table public.artist_fee_history (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  artist_id uuid not null references public.artists (id) on delete cascade,
  event_id uuid,
  occurred_on date not null,
  -- Currency + minor units, per CLAUDE.md § Non-functional targets: "GBP only
  -- at MVP; store a currency column and use minor units so multi-currency UI
  -- can be added later without a schema migration". bigint, not integer:
  -- pence, and integer tops out around 21 million pounds, which is not a
  -- headroom argument anyone should have to have later.
  --
  -- The currency check is a SHAPE check (three uppercase letters), not an
  -- ISO 4217 allowlist. A real allowlist is a lookup table, and the product
  -- writes GBP only today; a shape check catches 'gbp', '£' and 'pounds'
  -- without pretending to a validation this phase has not built.
  currency text not null default 'GBP'
    check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor >= 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.artist_fee_history is
  'Fee paid to an artist on a date, in minor units (PRD 6.3 requires fee history rather than a single mutable number). event_id deliberately has NO foreign key: public.events does not exist until Phase 3, whose migration must add it as ON DELETE SET NULL -- see this table''s header comment for the exact statement. It stays nullable afterwards, because historical fees predating the system have no event.';

comment on column public.artist_fee_history.amount_minor is
  'Minor units (pence for GBP). bigint because integer pence caps at ~21M pounds. Constrained non-negative: this column records a fee paid, and a negative fee is a data-entry error, not a refund -- refunds and adjustments are financial_entries (Phase 5), which is where signed amounts belong.';

create index artist_fee_history_organisation_id_idx
  on public.artist_fee_history (organisation_id);
create index artist_fee_history_artist_id_idx
  on public.artist_fee_history (artist_id);
-- Not FK-backed yet (see above), but indexed now for the same reason the FK
-- will want it: "what did this event's lineup cost?" is a Phase 3/Phase 5 read,
-- and adding the FK later takes an exclusive lock that is cheaper against an
-- already-indexed column.
create index artist_fee_history_event_id_idx
  on public.artist_fee_history (event_id)
  where event_id is not null;

-- ---------------------------------------------------------------------------
-- venues
-- PRD § 6.4: "name, address, location, capacity, rooms, contacts, socials,
-- website, technical information and documents". Rooms are venue_rooms below,
-- contacts are contacts + Phase 4's linking pattern, documents are Phase 4.
--
-- `address` and `location` are both kept and are not duplicates: address is
-- the postal address, location is the searchable/displayable place ("Bristol",
-- "South London") that the PRD lists separately and that contacts carries too.
-- ---------------------------------------------------------------------------
create table public.venues (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id uuid references auth.users (id) on delete set null,
  name text not null check (btrim(name) <> ''),
  address text,
  location text,
  -- Nullable: capacity is frequently unknown when a venue is first entered,
  -- and 0 would be a lie that then renders as a real number in the UI.
  capacity integer check (capacity is null or capacity >= 0),
  socials jsonb not null default '{}'::jsonb
    check (jsonb_typeof(socials) = 'object'),
  website text,
  -- Free text: PA, rigging, load-in, power. PRD 6.4 asks for "technical
  -- information" and specifies no structure, and structuring it would be
  -- inventing a spec sheet nobody asked for. Untrusted user content -- it is
  -- sanitised on render (CLAUDE.md § Non-negotiable rules), not here.
  technical_info text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.venues is
  'Tenant-private venue record. address (postal) and location (searchable place) are both PRD 6.4 fields and are not duplicates of each other. technical_info is unstructured by design -- the PRD asks for "technical information" with no schema. Rooms are venue_rooms; venue documents and contacts arrive via Phase 4''s linking pattern. Tenant-private -- not a network identity.';

create index venues_organisation_id_idx
  on public.venues (organisation_id);
create index venues_owner_user_id_idx
  on public.venues (owner_user_id);

-- ---------------------------------------------------------------------------
-- venue_rooms
-- NAME ONLY at MVP. PRD § 6.4 confirms rooms exist and that room-level event
-- assignment is optional, and gives no room-level capacity or tech-spec
-- fields; none are invented here.
--
-- DELETED_AT IS A DELIBERATE ADDITION beyond the plan, for the same reason as
-- agencies and one more: Phase 3's events will optionally reference a room
-- ("optional room-level event assignment", PRD 6.4). Hard-deleting a room that
-- past events were assigned to would either cascade into event history or
-- silently null it out. A closed room is a soft-deleted room.
--
-- NO owner_user_id (convention (2)): a room's scope is its venue's scope.
-- ---------------------------------------------------------------------------
create table public.venue_rooms (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  venue_id uuid not null references public.venues (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.venue_rooms is
  'A room within a venue. Name-only at MVP -- PRD 6.4 confirms rooms and optional room-level event assignment but gives no room-level fields. deleted_at is an addition beyond the plan: Phase 3 events may reference a room, so closing a room must not cascade into event history. No owner_user_id: record scope follows the venue. Name uniqueness within a venue is NOT enforced -- see the Task 1 report.';

create index venue_rooms_organisation_id_idx
  on public.venue_rooms (organisation_id);
create index venue_rooms_venue_id_idx
  on public.venue_rooms (venue_id);

-- ===========================================================================
-- Trigram indexes for the fuzzy-dedup search
-- ===========================================================================
-- CLAUDE.md § Domain entities: "fuzzy matches are flagged for manual review,
-- never auto-merged silently". The plan's Task 6 implements that with pg_trgm
-- similarity on the name column, starting at a 0.6 threshold. These indexes
-- exist now so Task 6 ships a feature, not a migration.
--
-- GIN rather than GiST: GIN is the right choice for `%` / similarity lookups
-- on a mostly-read column -- faster searches, slower updates, and a name is
-- written once and searched on every dedup check and every search box
-- keystroke.
--
-- PARTIAL on `deleted_at is null`, which is a real constraint on the caller
-- and not just a size optimisation: a query that omits `deleted_at is null`
-- CANNOT use these indexes and will sequentially scan. That is the correct
-- trade -- both consumers (dedup, entity search) want live records only, and
-- surfacing a soft-deleted duplicate for merge would be a bug -- but it must
-- be written down, because the failure mode is a slow query rather than a
-- wrong answer, and slow queries are found late.
--
-- NOT scoped by organisation_id, and the measured plan is worth recording
-- because it is not the obvious one. Against 20 organisations x 1500 contacts,
--
--   where organisation_id = $1 and deleted_at is null and name % 'Annie Mack'
--
-- plans as a Bitmap Index Scan on this index with `organisation_id = $1`
-- applied as a HEAP FILTER afterwards -- not as a bitmap AND against
-- contacts_organisation_id_idx. Trigram similarity is selective enough that
-- the tenant restriction is cheap to apply last. A composite
-- (organisation_id, name) GIN index would need btree_gin, a second extension,
-- and has no measured gain to justify it at these row counts. Revisit if a
-- single tenant's row count ever dominates the table.
--
-- THAT PLAN IS ALSO THE REASON THIS PARAGRAPH EXISTS. Because the tenant
-- filter is applied AFTER the index scan rather than by it, Task 2 and Task 6
-- must still pass organisation_id explicitly in every dedup and search query.
-- The index spans every tenant; a query that omits the tenant filter reads
-- other organisations' names off it, and only RLS is then standing between
-- that and a cross-tenant disclosure.
create index companies_name_trgm_idx on public.companies
  using gin (name extensions.gin_trgm_ops) where deleted_at is null;
create index contacts_name_trgm_idx on public.contacts
  using gin (name extensions.gin_trgm_ops) where deleted_at is null;
create index artists_name_trgm_idx on public.artists
  using gin (name extensions.gin_trgm_ops) where deleted_at is null;
create index venues_name_trgm_idx on public.venues
  using gin (name extensions.gin_trgm_ops) where deleted_at is null;

-- ===========================================================================
-- Row Level Security -- enabled, with ZERO policies
-- ===========================================================================
-- RLS with no policies denies every row to every non-owner role. That is the
-- correct state for the window between this migration and Task 2: CLAUDE.md
-- § Non-negotiable rules requires "RLS on every tenant-owned table BEFORE the
-- application can reach it", and a table that spends one migration with RLS
-- off is a table that was reachable, if only by a service-role key.
--
-- Combined with the ALTER DEFAULT PRIVILEGES baseline (20260827232507), which
-- leaves every table below with an empty ACL, these tables are currently
-- unreachable by two independent controls rather than one.
--
-- NOT FORCED, matching Foundation's design note (d): these tables are owned by
-- `postgres`, and a table owner is exempt from its own RLS unless FORCE ROW
-- LEVEL SECURITY is set. That exemption is what lets SECURITY DEFINER helpers
-- work at all. No client role owns any of these tables, so it does not weaken
-- the tenant boundary.
alter table public.companies              enable row level security;
alter table public.contacts               enable row level security;
alter table public.contact_companies      enable row level security;
alter table public.agencies               enable row level security;
alter table public.artists                enable row level security;
alter table public.artist_representations enable row level security;
alter table public.artist_fee_history     enable row level security;
alter table public.venues                 enable row level security;
alter table public.venue_rooms            enable row level security;

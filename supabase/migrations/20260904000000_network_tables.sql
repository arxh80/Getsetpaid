-- Phase 6 (Network), Task 1a: the three network tables --
-- public.network_profiles, public.network_links and
-- public.network_connection_requests.
--
-- Scope note, mirroring 20260903000000 / 20260901000000 exactly: this migration
-- creates the TABLES, their CONSTRAINTS, the closed-vocabulary CHECK helper,
-- INDEXES, GRANTS and two updated_at triggers, and adds the `'network_profile'`
-- arm to private.entity_org_unchanged(). It creates NO policies, NO permission
-- keys and NO entitlement helper. Those are Task 1b/1c/1d (20260904001000,
-- 20260904002000, 20260904003000), which depend on the tables created here.
--
-- RLS IS ENABLED AT THE BOTTOM OF THIS FILE, with zero policies. RLS with no
-- policies denies every row to every non-owner role, which is the correct
-- intermediate state (CLAUDE.md § Non-negotiable rules: RLS on "before the
-- application can reach it"). This is the same deliberate interval events
-- (Phase 3), the operations tables (Phase 4) and financial_entries (Phase 5)
-- each opened.
--
-- MEASURED CONSEQUENCE, stated so a reviewer does not have to discover it:
-- between this migration and 20260904003000, schema_invariants.sql D4 and D5
-- FAIL -- a grant with no policy behind it reaches no rows, which is the safe
-- direction. Expected intermediate values: D4 '3' (three tables with zero
-- policies), D5 '9' (SELECT/INSERT/UPDATE on each of the three, none with a
-- policy behind it). Both are back to '0' after 20260904003000, and a reviewer
-- of that file checks they went GREEN rather than that they were silenced.
-- D11b is UNCHANGED by this phase: none of the three tables joins to a parent
-- named in invariants.child_parent, so no new expression enters that census.
--
-- ===========================================================================
-- N1: THESE THREE TABLES ARE THE ONLY TABLES THIS PHASE CREATES
-- ===========================================================================
-- No column is added to companies, artists, venues, agencies, contacts, notes,
-- documents, financial_entries or events that carries network state (Global
-- Constraints N1). A network identity is a SEPARATE CONCEPT IN A SEPARATE
-- TABLE (CLAUDE.md § The private/network split), and the only bridge between
-- the two worlds is public.network_links, which is private to the linking
-- organisation and reaches the network side by id alone.
--
-- ===========================================================================
-- CONVENTIONS -- inherited from 20260903000000, restated only where this file
-- makes a choice that file did not
-- ===========================================================================
--
-- (1) TENANCY. All three carry `organisation_id`-shaped NOT NULL columns with
--     ON DELETE CASCADE FKs to public.organisations.
--     network_connection_requests carries TWO of them (from_organisation_id
--     and to_organisation_id) because it is genuinely BI-TENANT (Q83) -- it is
--     the one table in the product that two organisations both own a side of,
--     and it is therefore the stated exemption to schema_invariants D10's
--     "every table carries a NOT NULL organisation_id".
--
-- (2) VALUE DOMAINS ARE CHECK CONSTRAINTS, NOT ENUM TYPES (20260901000000
--     note (3)). `entity_kind`, `status` and the field-visibility vocabulary
--     are closed value sets enforced by CHECKs; lib/network/fields.ts is the
--     request-side mirror, bound to them by
--     tests/integration/network/field-vocabulary-matches-db.test.ts.
--
-- (3) SOFT DELETE on network_profiles and network_links. NO DELETE GRANT
--     anywhere: soft delete is the only delete, and it is an UPDATE of
--     `deleted_at`. network_connection_requests has NO deleted_at -- a request
--     is never deleted, it moves to a terminal `status` (Q79), which is a
--     richer record than a tombstone and is what the live-pair unique index
--     below reads.
--
-- (4) TIMESTAMPS. UTC (`timestamptz`), `updated_at` maintained by a trigger
--     added BY HAND at the bottom, named exactly `set_updated_at`
--     (rls_phase2_crm.sql L5/L6). TWO new triggers this phase: on
--     network_profiles and network_connection_requests. NOT on network_links,
--     which has no `updated_at` column -- a link is created or soft-deleted,
--     never edited. L6's expected count therefore rises from 29 to 31.
--
-- (5) NO owner_user_id ON ANY OF THE THREE. Network scope is ROLE-BASED, not
--     owner-record-based: the roles that hold view_network /
--     manage_network_profile / manage_network_connections are either
--     full-scope or (in the read case) every role in the product, so there is
--     no record-scope disjunction on any network policy and no owner column
--     for one to read. Same reasoning financial_entries states in its note (2),
--     and the reason `created_by` is present but never a policy term.
--
-- (6) DISCOVERY IS NOT ORGANISATION-SCOPED. Every other list in this product
--     is a tenant's own list; the network directory spans every tenant. That
--     single fact drives the deviation on the covering index below (Constraint
--     9) and the shape of the SELECT (directory) policy in 20260904003000.

-- ===========================================================================
-- THE CLOSED VISIBILITY VOCABULARY, AS A CHECK
-- ===========================================================================
-- field_visibility is jsonb, and jsonb has no schema. Left unconstrained it
-- would accept `{"contacts_email":"netwrok"}` -- a typo in either half silently
-- means "hidden" at read time (the views test for an exact string), so a user
-- who published a field would see it not published and have nothing to
-- diagnose. Worse in the other direction: an unknown KEY that later becomes a
-- real column would arrive pre-set to whatever a client once wrote.
--
-- A CHECK MAY NOT CONTAIN A SUBQUERY (0A000), and jsonb_each_text needs one.
-- The 20260829011500 / 20260829010000 precedent is exactly this situation
-- (private.custom_field_options_valid): the guard ships as an IMMUTABLE
-- function called from the CHECK. THE FORM THAT SHIPPED HERE IS THE SAME ONE:
-- a `language sql immutable set search_path = ''` function, granted EXECUTE to
-- `authenticated`, because a CHECK expression is evaluated as the INSERTING
-- role and without the grant every client insert would fail with a PRIVILEGE
-- error (42501) from the constraint rather than a constraint violation (23514)
-- -- a refusal nobody could diagnose. That distinction is MEASURED, not
-- assumed: rls_phase6_network.sql's § NA drives an authenticated INSERT with a
-- malformed vocabulary and asserts denied(23514), with a well-formed positive
-- control, exactly as U20/U20a do for the options check.
--
-- NOTE WHAT IS DELIBERATELY *NOT* A KEY: `display_name` and `entity_kind` are
-- ALWAYS network-visible (Q71) and are therefore REJECTED as keys by this
-- function. That is the point rather than an omission -- a level that cannot
-- be set cannot be mis-set, and the two always-visible fields have no level to
-- get wrong. lib/network/fields.ts states the same two facts on the TypeScript
-- side (ALWAYS_NETWORK_FIELDS) and the vocabulary test binds them.
--
-- Postgres does not revalidate existing rows when this body changes, so
-- tightening the rule here tightens it for NEW rows only; a migration meaning
-- to tighten it for all rows must revalidate the constraint as well (the same
-- caveat 20260829011500 records).
-- ===========================================================================
create or replace function private.network_visibility_is_valid(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null
     and pg_catalog.jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from pg_catalog.jsonb_each_text(p) kv
        where kv.key not in ('headline','bio','city','region','country','website_url','contact_email')
           or kv.value not in ('hidden','network','connections'));
$$;

comment on function private.network_visibility_is_valid(jsonb) is
  'The CLOSED field-visibility vocabulary (Q71/Q75), enforced in the database rather than only in lib/network/fields.ts. True iff p is a jsonb object whose every key is one of the seven PUBLISHABLE fields and whose every value is one of the three levels (hidden/network/connections). A function rather than an inline CHECK because a CHECK may not contain a subquery (0A000) and jsonb_each_text needs one -- the private.custom_field_options_valid precedent (20260829010000/20260829011500). GRANTED to `authenticated` because a CHECK expression is evaluated as the inserting role; rls_phase6_network.sql § NA measures that a client insert gets a CHECK violation (23514) and not a privilege error (42501). display_name and entity_kind are DELIBERATELY REJECTED as keys: they are always network-visible, so they have no level, and a level that cannot be set cannot be mis-set. Postgres does not revalidate existing rows when this body changes.';

revoke all on function private.network_visibility_is_valid(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.network_visibility_is_valid(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- network_profiles
--
-- One organisation's PUBLISHED identity for one of its own private records.
-- PRD § 8 (the industry network). This is the table the whole private/network
-- split turns on, and three of its design decisions are load-bearing:
--
--  * Q75 -- IT CARRIES ITS OWN COPY OF EVERY PUBLISHED VALUE, never a pointer
--    into the private record. A view that resolved `display_name` by joining
--    public.companies would put a tenant-private table in the discovery path,
--    which is precisely what N2 forbids and what the dependency assertion
--    measures. Publishing is an explicit copy, and editing the private record
--    does not silently republish anything.
--
--  * Q74 -- entity_kind + entity_id name the org's OWN private record this
--    profile speaks for, so the org can find it again and so the INSERT policy
--    can require "you may only publish a record you could manage". Neither
--    column is projected by either discovery view.
--
--  * Q81 -- `status` is draft or published, and `published_at` is present iff
--    published. A downgrade never hides your own data (the SELECT-own policy
--    carries no tier term); it refuses new WRITES.
-- ---------------------------------------------------------------------------
create table public.network_profiles (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,

  -- Q74. The FOUR entity kinds a network identity can speak for. Contacts are
  -- absent on purpose: a contact is a PERSON inside someone's address book,
  -- and publishing a person's details as an industry identity is a consent
  -- question this MVP does not answer. lib/network/fields.ts mirrors this set.
  entity_kind text not null
    check (entity_kind in ('company','artist','venue','agency')),

  -- The org's own private record this profile speaks for. POLYMORPHIC across
  -- four tables -- see the header block below on why there is deliberately NO
  -- foreign key here.
  entity_id uuid not null,

  -- Q81. A profile is a draft until it is published; publishing is the act
  -- that makes it discoverable, and it is reversible (unpublish).
  status text not null default 'draft'
    check (status in ('draft','published')),

  -- Q71/Q75/N3. field -> level, for the seven publishable fields. Constrained
  -- to the closed vocabulary by network_profiles_visibility_vocabulary below,
  -- and to "hidden means NULL" by network_profiles_hidden_fields_are_null.
  -- Default '{}' means every field is hidden (the views coalesce a missing key
  -- to hidden), which is the correct default for an opt-in control.
  field_visibility jsonb not null default '{}'::jsonb,

  -- The published VALUE columns. This table's own copy (Q75), never a pointer.
  -- display_name is NOT NULL and always network-visible (Q71) -- a profile
  -- with no name is not discoverable, so there is nothing to publish.
  display_name text not null,
  headline text,
  bio text,
  city text,
  region text,
  country text,
  website_url text,
  contact_email text,

  -- Q81: set when status becomes 'published', cleared when it becomes 'draft'.
  -- The biconditional is a CHECK below, so the two cannot drift.
  published_at timestamptz,

  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.network_profiles is
  'One organisation''s PUBLISHED identity for one of its own private records (PRD § 8). The ONLY table in the schema any other tenant can read a row of, and only when status=''published'' and only through public.network_directory / public.network_connected_profiles -- the base table''s directory SELECT policy deliberately does not constrain WHICH COLUMNS are legible, and the masking VIEWS are that control (20260904003000, 20260904004000). Carries its OWN COPY of every published value (Q75), never a pointer into the private record: a view resolving display_name by joining public.companies would put a tenant-private table in a discovery path, which N2 forbids and the pg_depend assertion measures. entity_kind/entity_id name the org''s own private record and are NEVER projected by either view. Soft-deleted, never hard-deleted; no DELETE grant.';

comment on column public.network_profiles.entity_id is
  'The organisation''s OWN private record this profile speaks for (Q74). POLYMORPHIC across companies/artists/venues/agencies, so it deliberately carries NO foreign key -- see the migration header. Referential integrity is private.entity_is_manageable(entity_kind, entity_id, organisation_id) in the INSERT/UPDATE policies, exactly as the four operations link tables do for their target end. NEVER projected by public.network_directory or public.network_connected_profiles: a discovery result identifies a PROFILE, never a tenant''s private record.';

comment on column public.network_profiles.field_visibility is
  'field -> level for the seven publishable fields (Q71/Q75). Levels are hidden / network / connections. Default ''{}'' means everything hidden, which is the correct default for an opt-in control (CLAUDE.md § The private/network split: "publishing is opt-in per field"). Constrained to the closed vocabulary by network_profiles_visibility_vocabulary and to "hidden stores NULL" by network_profiles_hidden_fields_are_null -- N3 is ENFORCED, not intended, because a masked-but-stored value is one policy bug away from a leak and a NULL is not.';

-- ---------------------------------------------------------------------------
-- Constraints, each with its reason.
--
-- network_profiles_id_org_unique is redundant on its own (id is the primary
-- key) and exists only as a future child-FK target -- the same trade
-- events_id_org_unique and financial_entries_id_org_unique make. NOTE that
-- network_links deliberately does NOT use it; see that table's header.
-- ---------------------------------------------------------------------------
alter table public.network_profiles
  add constraint network_profiles_id_org_unique unique (id, organisation_id);

-- Q74: ONE profile per private record. Partial so a soft-deleted profile does
-- not block republishing the same record later.
create unique index network_profiles_entity_unique
  on public.network_profiles (organisation_id, entity_kind, entity_id)
  where deleted_at is null;

-- Q81: a published profile has a published_at; a draft does not.
alter table public.network_profiles
  add constraint network_profiles_published_at_iff_published check (
    (status = 'published') = (published_at is not null));

-- ===========================================================================
-- NO COMPOSITE FK FROM entity_id TO companies/artists/venues/agencies, AND
-- THIS IS DELIBERATE
-- ===========================================================================
-- `entity_id` is POLYMORPHIC across four tables (the `*_links` precedent,
-- 20260902002000): you cannot write a foreign key to a union. Referential
-- integrity for it is carried by
-- private.entity_is_manageable(entity_kind, entity_id, organisation_id) in the
-- INSERT/UPDATE policies (20260904003000), exactly as the four operations link
-- tables do for their TARGET end -- Constraint 3's stated exception for a
-- polymorphic target. Written out here because a reviewer reads a missing FK
-- as an omission, and on this table of all tables that would be the wrong
-- thing to wave through.
-- ===========================================================================

-- ===========================================================================
-- N3, ENFORCED RATHER THAN INTENDED: A HIDDEN FIELD STORES NULL
-- ===========================================================================
-- Global Constraints N3: "Publishing is opt-in per field, and opting out
-- REMOVES the value. A masked-but-stored value is one policy bug away from a
-- leak; a NULL is not." The two masking views are a READ-time control; this
-- CHECK is the WRITE-time one, and it is the half that survives a mistake in
-- the other. A `coalesce(..., 'hidden')` on each key means a key that is
-- absent from field_visibility counts as hidden, which matches the views'
-- behaviour exactly (they test for an exact level string, so a missing key
-- resolves to NULL there too).
--
-- The application must NOT surface a violation of this as a raw 23514:
-- lib/network/profiles.ts NULLs the value column in the SAME UPDATE that sets
-- a field to hidden (setFieldVisibilityAction), so the constraint is a
-- backstop for a direct PostgREST PATCH rather than a path the UI can reach.
-- ===========================================================================
alter table public.network_profiles
  add constraint network_profiles_hidden_fields_are_null check (
    (coalesce(field_visibility->>'headline','hidden')      <> 'hidden' or headline      is null) and
    (coalesce(field_visibility->>'bio','hidden')           <> 'hidden' or bio           is null) and
    (coalesce(field_visibility->>'city','hidden')          <> 'hidden' or city          is null) and
    (coalesce(field_visibility->>'region','hidden')        <> 'hidden' or region        is null) and
    (coalesce(field_visibility->>'country','hidden')       <> 'hidden' or country       is null) and
    (coalesce(field_visibility->>'website_url','hidden')   <> 'hidden' or website_url   is null) and
    (coalesce(field_visibility->>'contact_email','hidden') <> 'hidden' or contact_email is null)
  );

alter table public.network_profiles
  add constraint network_profiles_visibility_vocabulary
    check (private.network_visibility_is_valid(field_visibility));

comment on constraint network_profiles_hidden_fields_are_null on public.network_profiles is
  'N3, enforced rather than intended: a field whose visibility is `hidden` (or absent, which coalesces to hidden) stores NULL in its value column. The masking views are the READ-time control; this is the WRITE-time one, and it is the half that survives a mistake in the other -- a masked-but-stored value is one policy bug away from a leak, a NULL is not. lib/network/profiles.ts NULLs the column in the same UPDATE that hides the field, so the UI never reaches this as a raw 23514.';

comment on constraint network_profiles_visibility_vocabulary on public.network_profiles is
  'The closed vocabulary (Q71) in the database as well as in lib/network/fields.ts: seven known keys, three known levels. Delegates to private.network_visibility_is_valid because a CHECK may not contain a subquery. display_name and entity_kind are rejected as keys on purpose -- they are always network-visible and have no level.';

-- ---------------------------------------------------------------------------
-- network_links
--
-- Q82: "this network profile is the same entity as my private record."
-- PRIVATE TO THE LINKING ORGANISATION AND TO NOBODY ELSE. The counterparty is
-- never told they have been linked, there is no notification, no reciprocal
-- row, and -- critically -- NO POLICY GIVING THE PROFILE'S OWNER ANY READ OF
-- THIS TABLE. Knowing who has filed you in their CRM is itself commercially
-- sensitive information, and it is not the network's to disclose.
-- ---------------------------------------------------------------------------
create table public.network_links (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  network_profile_id uuid not null references public.network_profiles (id) on delete cascade,
  private_entity_type text not null
    check (private_entity_type in ('company','artist','venue','agency')),
  private_entity_id uuid not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index network_links_unique
  on public.network_links (organisation_id, private_entity_type, private_entity_id, network_profile_id)
  where deleted_at is null;

-- ===========================================================================
-- network_profile_id IS A SINGLE-COLUMN FK, AND THIS IS THE ONE EXEMPTION IN
-- THE PHASE TO CONSTRAINT 4
-- ===========================================================================
-- Constraint 4 requires every child/link table to carry a tenant-scoped
-- COMPOSITE foreign key (parent_id, organisation_id) -> parent (id,
-- organisation_id), because a plain single-column FK is the defect that
-- produced a proven cross-tenant write in Phase 2 (20260828001132).
--
-- HERE, THE PROFILE IT POINTS AT IS OWNED BY A DIFFERENT TENANT -- THAT IS THE
-- ENTIRE POINT OF A LINK -- SO THE COMPOSITE (network_profile_id,
-- organisation_id) FORM CONSTRAINT 4 MANDATES EVERYWHERE ELSE WOULD FORBID THE
-- ONLY LINK WORTH MAKING. It would resolve against
-- network_profiles_id_org_unique and demand that the profile belong to the
-- LINKING organisation, i.e. that you may only link your own profiles to your
-- own records, which is not a feature.
--
-- ITS REPLACEMENT GUARD (this task ships it; Task 5 re-asserts it):
--   1. The SELECT/INSERT/UPDATE policies on network_links carry no predicate
--      reading anything from network_profiles other than `id` and `status`.
--   2. The table has NO policy granting any read to a non-owning organisation.
-- Both are structural assertions in rls_phase6_network.sql § NS, and
-- schema_invariants.sql D8/D8b carry the exemption by name.
--
-- The PRIVATE end (private_entity_type, private_entity_id) is polymorphic
-- across the same four kinds and takes Constraint 3's stated exception: its
-- integrity is private.entity_is_manageable in the write policies.
-- ===========================================================================
comment on table public.network_links is
  'Q82: "this network profile is the same entity as my private record." PRIVATE TO THE LINKING ORGANISATION. There is no counterparty path at all -- no notification, no reciprocal row, and no policy giving the profile''s owner any read of this table, because knowing who has filed you in their CRM is itself commercially sensitive. `network_profile_id` is a SINGLE-COLUMN FK and it is the ONE deliberate exemption to Constraint 4 in this phase: the profile is owned by a DIFFERENT tenant, which is the point of a link, so the composite form would forbid the only link worth making. Its replacement guard is structural: the policies read nothing from network_profiles but `id` and `status`, and no policy grants a non-owning organisation any read. Soft-deleted; no updated_at (a link is created or removed, never edited).';

comment on constraint network_links_network_profile_id_fkey on public.network_links is
  'SINGLE-COLUMN ON PURPOSE -- the one exemption to Constraint 4 in this phase. The profile it points at is owned by a DIFFERENT tenant (that is the entire point of a link), so a composite (network_profile_id, organisation_id) FK would resolve against network_profiles_id_org_unique and permit only self-links. schema_invariants D8/D8b carry the exemption by name plus its replacement assertion; rls_phase6_network.sql § NS is the replacement guard.';

-- ---------------------------------------------------------------------------
-- network_connection_requests
--
-- Q83: BI-TENANT. The one table in the product two organisations both own a
-- side of, and therefore the one exemption to schema_invariants D10 ("every
-- table carries a NOT NULL organisation_id"): it carries TWO, and either one
-- being the caller's is what its SELECT policy reads.
--
-- Request-to-connect is CLAUDE.md § The private/network split's discovery
-- model. An ACCEPTED request changes exactly one thing (N4): fields the
-- publisher marked `connections` resolve for the connected organisation
-- through public.network_connected_profiles. It grants NO access to any tenant
-- table -- not notes, not ratings, not financials, not documents, not events.
-- ---------------------------------------------------------------------------
create table public.network_connection_requests (
  id uuid primary key default gen_random_uuid(),
  from_organisation_id uuid not null references public.organisations (id) on delete cascade,
  -- Q78: a request is sent FROM one of your published profiles, not from a
  -- bare organisation. It is how the recipient knows who is asking.
  from_network_profile_id uuid not null references public.network_profiles (id) on delete cascade,
  to_organisation_id uuid not null references public.organisations (id) on delete cascade,
  to_network_profile_id uuid not null references public.network_profiles (id) on delete cascade,

  -- Q79. pending -> accepted | declined | withdrawn. declined is TERMINAL;
  -- withdrawn frees the pair for exactly one retry (the partial unique index
  -- below is what makes that true).
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','withdrawn')),

  -- ===================================================================
  -- DEVIATION FROM THE BRIEF, STATED (Constraint 13).
  --
  -- The brief specifies `requested_by uuid not null default auth.uid()
  -- references auth.users (id) on delete set null`, which is
  -- self-contradictory: deleting that auth user would fire the SET NULL and
  -- immediately violate the NOT NULL, so the delete aborts with 23502 and the
  -- account can never be removed. THIS COLUMN IS THEREFORE NULLABLE, matching
  -- the `created_by` convention every other table in this schema uses
  -- (financial_entries, events, tasks, network_profiles above). The audit
  -- trail survives the actor's account being removed in public.audit_events,
  -- which is the table that carries that guarantee (its actor_user_id
  -- deliberately has no ON DELETE action at all).
  -- ===================================================================
  requested_by uuid default auth.uid() references auth.users (id) on delete set null,
  responded_by uuid references auth.users (id) on delete set null,

  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.network_connection_requests
  add constraint network_connection_requests_not_self
    check (from_organisation_id <> to_organisation_id);

alter table public.network_connection_requests
  add constraint network_connection_requests_responded_iff_terminal
    check ((status = 'pending') = (responded_at is null));

-- Q79: declined is terminal; withdrawn frees the pair for one retry.
create unique index network_connection_requests_live_pair
  on public.network_connection_requests (from_organisation_id, to_network_profile_id)
  where status in ('pending','accepted','declined');

comment on table public.network_connection_requests is
  'The request-to-connect record (Q83, CLAUDE.md § The private/network split). BI-TENANT: two organisations each own a side, which makes this the ONE stated exemption to schema_invariants D10''s "every table carries a NOT NULL organisation_id" -- it carries TWO, and its replacement assertion is that BOTH are NOT NULL with a cascading FK to public.organisations. An ACCEPTED request changes EXACTLY ONE THING (N4): fields the publisher marked `connections` resolve for the connected organisation through public.network_connected_profiles. It grants NO access to any tenant table -- notes, ratings, financial entries, documents, events, activity, tasks and meetings are all unreachable from a connected counterparty by construction. Never deleted: a request moves to a terminal status (Q79), which is a richer record than a tombstone.';

comment on constraint network_connection_requests_not_self on public.network_connection_requests is
  'An organisation cannot address a connection request at itself. 23514 rather than a policy refusal so it holds for every writer including one RLS does not apply to.';

comment on index public.network_connection_requests_live_pair is
  'Q79: declined is TERMINAL and withdrawn frees the pair for exactly one retry. Partial on status in (pending,accepted,declined) -- so a second request to the same profile is 23505 while any of those three stands, and becomes possible again only once the sender withdraws. The pair is (from_organisation_id, to_network_profile_id): an organisation, not a profile, is the unit on the sending side, because Q80''s symmetry is org-to-org.';

comment on column public.network_connection_requests.requested_by is
  'Nullable with ON DELETE SET NULL, matching the created_by convention every other table uses. DELIBERATE DEVIATION from the Task 1 brief, which specified `not null default auth.uid() ... on delete set null` -- that combination is self-contradictory (the SET NULL would violate the NOT NULL and abort the auth.users delete with 23502, so the account could never be removed). The audit trail that must survive an actor being deleted is public.audit_events, whose actor_user_id deliberately carries no ON DELETE action at all.';

-- ---------------------------------------------------------------------------
-- Indexes.
--
-- FK-covering (schema_invariants D3) plus the discovery covering index.
-- ---------------------------------------------------------------------------
create index network_profiles_organisation_id_idx on public.network_profiles (organisation_id);
create index network_profiles_created_by_idx      on public.network_profiles (created_by);

-- ===========================================================================
-- THE DISCOVERY COVERING INDEX. DELIBERATE DEVIATION FROM THE STANDARD
-- (organisation_id, sort, id) SHAPE (Constraint 9).
--
-- Discovery is NOT organisation-scoped -- it is the one list in the product
-- that spans every tenant -- so the leading column is the published-state
-- predicate, not the tenant. An index led by organisation_id would be useless
-- to a query whose WHERE clause never names one. Stated here AND in
-- NETWORK_DIRECTORY_LIST's SortOption.backedBy comment
-- (lib/network/discovery-list.ts), or a reviewer reads it as an omission --
-- the same treatment financial_entries' `include (event_id)` deviation gets.
-- ===========================================================================
create index network_profiles_directory_idx
  on public.network_profiles (status, display_name, id)
  include (entity_kind, city, country)
  where deleted_at is null;

comment on index public.network_profiles_directory_idx is
  'Covers the network directory''s default sort (display_name asc) and its keyset range, live rows only. LEADS WITH `status`, NOT `organisation_id`, and that is the deliberate Constraint 9 deviation: discovery is the one list in the product that is not organisation-scoped, so a tenant-led index would never be used. INCLUDE carries the three columns the result card renders beyond the key (entity_kind, city, country), making the directory page an index-only scan over published live profiles. lib/network/discovery-list.ts''s NETWORK_DIRECTORY_LIST.backedBy names this index.';

create index network_links_organisation_id_idx    on public.network_links (organisation_id);
create index network_links_network_profile_id_idx on public.network_links (network_profile_id);
create index network_links_created_by_idx         on public.network_links (created_by);

create index network_connection_requests_from_org_idx     on public.network_connection_requests (from_organisation_id);
create index network_connection_requests_to_org_idx       on public.network_connection_requests (to_organisation_id);
create index network_connection_requests_from_profile_idx on public.network_connection_requests (from_network_profile_id);
create index network_connection_requests_to_profile_idx   on public.network_connection_requests (to_network_profile_id);
create index network_connection_requests_requested_by_idx on public.network_connection_requests (requested_by);
create index network_connection_requests_responded_by_idx on public.network_connection_requests (responded_by);

-- ---------------------------------------------------------------------------
-- updated_at triggers, by hand (Constraint 8).
--
-- Named exactly `set_updated_at` (rls_phase2_crm.sql L5 asserts that name; L6
-- counts them). TWO of them: network_profiles and network_connection_requests.
-- NOT network_links, which has no updated_at column.
--
-- L6's expected count therefore rises by 2: 29 tables before this migration,
-- 31 after. A reviewer checks that arithmetic.
--
-- The `when` clause is the verbatim one: a no-op UPDATE must not move the
-- timestamp.
-- ---------------------------------------------------------------------------
drop trigger if exists set_updated_at on public.network_profiles;
create trigger set_updated_at before update on public.network_profiles
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.network_connection_requests;
create trigger set_updated_at before update on public.network_connection_requests
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- private.entity_org_unchanged() -- the `network_profile` arm.
--
-- The network_profiles UPDATE policy (20260904003000) calls
-- entity_org_unchanged('network_profile', id, organisation_id) in WITH CHECK,
-- pinning both organisation_id and id immutable through the client UPDATE --
-- closing the tenant-to-tenant transfer a user who is an admin of two
-- organisations could otherwise perform in one statement (20260828140500
-- IMP-3). network_profiles has no owner column, so this is the ONLY thing
-- pinning it, exactly as with financial_entries.
--
-- The body below is the DEPLOYED one, read out of pg_get_functiondef() on the
-- live database (Constraint 1/13) plus one arm -- NOT reconstructed from
-- memory, because several migrations have rewritten this function since it was
-- introduced. `create or replace function` is the additive form.
--
-- NO ARM FOR network_links OR network_connection_requests, and both omissions
-- are deliberate:
--   * network_links' UPDATE policy is the soft-delete path only, and its
--     organisation_id is pinned by the SELECT/UPDATE `USING` term plus the
--     unique index; more to the point, an arm here would have to resolve
--     against a table whose network_profile_id belongs to another tenant, and
--     this guard's contract is "the row under p_id still has organisation_id =
--     p_org_id", which for network_links means only its OWN organisation_id --
--     already pinned by the policy's USING clause reading the same column.
--   * network_connection_requests has NO single organisation_id column to pin
--     (it is bi-tenant), so the guard's signature does not fit it. Its
--     equivalent protection is the pair of narrow UPDATE policies plus the
--     BEFORE UPDATE transition guard in 20260904003000.
-- ---------------------------------------------------------------------------
create or replace function private.entity_org_unchanged(
  p_entity_type text,
  p_id          uuid,
  p_org_id      uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_entity_type
    -- The top-level entities.
    when 'company' then exists (
      select 1 from public.companies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'contact' then exists (
      select 1 from public.contacts e where e.id = p_id and e.organisation_id = p_org_id)
    when 'agency' then exists (
      select 1 from public.agencies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist' then exists (
      select 1 from public.artists e where e.id = p_id and e.organisation_id = p_org_id)
    when 'venue' then exists (
      select 1 from public.venues e where e.id = p_id and e.organisation_id = p_org_id)
    when 'event' then exists (
      select 1 from public.events e where e.id = p_id and e.organisation_id = p_org_id)
    -- Organisation configuration.
    when 'custom_field_definition' then exists (
      select 1 from public.custom_field_definitions e where e.id = p_id and e.organisation_id = p_org_id)
    -- IMP-3: the child/join tables that carry an UPDATE policy. Named after
    -- the TABLE, not after a CRM entity type.
    when 'contact_company' then exists (
      select 1 from public.contact_companies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist_representation' then exists (
      select 1 from public.artist_representations e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist_fee' then exists (
      select 1 from public.artist_fee_history e where e.id = p_id and e.organisation_id = p_org_id)
    when 'venue_room' then exists (
      select 1 from public.venue_rooms e where e.id = p_id and e.organisation_id = p_org_id)
    when 'custom_field_value' then exists (
      select 1 from public.custom_field_values e where e.id = p_id and e.organisation_id = p_org_id)
    -- PHASE 3 TASK 2, alongside event_lineup_update_via_event below.
    when 'event_lineup' then exists (
      select 1 from public.event_lineup e where e.id = p_id and e.organisation_id = p_org_id)
    -- PHASE 4 TASK 1: the four top-level operational entities (named after the
    -- entity) and the four link tables (named after the TABLE). Each carries an
    -- UPDATE policy in Task 2 that pins (id, organisation_id) through this
    -- guard. document_versions is absent on purpose -- dormant, no UPDATE.
    when 'task' then exists (
      select 1 from public.tasks e where e.id = p_id and e.organisation_id = p_org_id)
    when 'meeting' then exists (
      select 1 from public.meetings e where e.id = p_id and e.organisation_id = p_org_id)
    when 'note' then exists (
      select 1 from public.notes e where e.id = p_id and e.organisation_id = p_org_id)
    when 'document' then exists (
      select 1 from public.documents e where e.id = p_id and e.organisation_id = p_org_id)
    when 'task_link' then exists (
      select 1 from public.task_links e where e.id = p_id and e.organisation_id = p_org_id)
    when 'meeting_link' then exists (
      select 1 from public.meeting_links e where e.id = p_id and e.organisation_id = p_org_id)
    when 'note_link' then exists (
      select 1 from public.note_links e where e.id = p_id and e.organisation_id = p_org_id)
    when 'document_link' then exists (
      select 1 from public.document_links e where e.id = p_id and e.organisation_id = p_org_id)
    -- PHASE 5 TASK 1, alongside financial_entries_update_manage_finance in
    -- 20260903003000. financial_entries has no owner column, so this is the
    -- ONLY thing pinning its (id, organisation_id) against a two-org admin.
    when 'financial_entry' then exists (
      select 1 from public.financial_entries e where e.id = p_id and e.organisation_id = p_org_id)
    -- PHASE 6 TASK 1, alongside network_profiles_update_manage_profile in
    -- 20260904003000. Same reasoning as financial_entry: network_profiles has
    -- no owner column, so this is the only thing pinning (id, organisation_id)
    -- against an admin of two organisations moving a published profile -- and
    -- on THIS table that transfer would move a cross-tenant-readable row
    -- between tenants, which is the worst version of the defect.
    when 'network_profile' then exists (
      select 1 from public.network_profiles e where e.id = p_id and e.organisation_id = p_org_id)
    else false
  end;
$$;

comment on function private.entity_org_unchanged(text, uuid, uuid) is
  'UPDATE guard: true iff the row stored under p_id (read on the statement-start snapshot, STABLE) still has organisation_id = p_org_id. Called from WITH CHECK with the NEW values, so it pins BOTH organisation_id and id immutable through the client UPDATE policies -- closing the tenant-to-tenant record transfer available to a user who holds the manage key in two organisations, which multi-org membership at MVP makes an ordinary case. TWENTY-THREE tables since Phase 6 Task 1: the six top-level entities, custom_field_definitions, the six child/join tables, the four operational entities and their four link tables, public.financial_entries, and public.network_profiles -- added by 20260904000000 alongside network_profiles_update_manage_profile which calls it. network_links and network_connection_requests deliberately have no arm; see 20260904000000''s header. Fail-closed if p_id names no row.';

revoke all on function private.entity_org_unchanged(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.entity_org_unchanged(text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Grants and RLS.
--
-- The 20260827232507 default-privileges baseline means the tables arrive with
-- an EMPTY ACL, so the revoke is belt-and-braces; written out anyway so a
-- reader knows the ACL without going to another file.
--
-- N6: `anon` GETS NOTHING. Q70's "no public, logged-out profiles at MVP" is
-- enforced by the GRANT, not by the absence of a route -- the anon key ships
-- in every browser bundle, so a route that does not exist is not a control.
-- schema_invariants D6 counts anon grants on the roster; § NG in
-- rls_phase6_network.sql counts them across all three tables AND both views,
-- with the denominator stated.
--
-- NO DELETE anywhere: soft delete is the only delete on profiles and links
-- (CLAUDE.md § Non-negotiable rules), and a connection request is never
-- deleted at all -- it moves to a terminal status.
--
-- RLS ON, POLICIES IN 20260904003000. The safe order "RLS on before access"
-- requires. See this file's header for the D4/D5 interval it opens.
-- ---------------------------------------------------------------------------
revoke all on public.network_profiles, public.network_links,
              public.network_connection_requests
  from public, anon, authenticated, service_role;
grant select, insert, update on public.network_profiles            to authenticated;
grant select, insert, update on public.network_links               to authenticated;
grant select, insert, update on public.network_connection_requests to authenticated;
alter table public.network_profiles            enable row level security;
alter table public.network_links               enable row level security;
alter table public.network_connection_requests enable row level security;

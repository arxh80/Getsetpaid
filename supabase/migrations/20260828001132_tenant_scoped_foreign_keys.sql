-- Phase 2 (Core CRM), Task 1 fix round 1: close the cross-tenant write.
--
-- ===========================================================================
-- THE DEFECT (proven, not theorised)
-- ===========================================================================
--
-- 20260827232510 gave every child table its own `organisation_id` AND a plain
-- single-column foreign key to its parent, and tied the two to nothing. So a
-- row could name a parent in one tenant while claiming a different tenant as
-- its own. Reproduced on the shipped schema, four separate tables:
--
--   venue_rooms            org A row inside org B's venue        INSERT 0 1
--   contact_companies      org A contact linked to org B company INSERT 0 1
--   contact_companies      organisation_id matching NEITHER parent INSERT 0 1
--   artist_representations org A row over org B's artist+agency  INSERT 0 1
--   artist_fee_history     org A fee row against org B's artist  INSERT 0 1
--
-- An independent reviewer took it further and proved it end to end with two
-- real users and real JWT claims, against exactly the RLS shape that
-- migration's own header endorses for child tables (org-keyed WITH CHECK, plus
-- the parent-derived SELECT this task's report told Task 2 to write):
--
--   * the attacker cannot SEE the victim's venue           -> 0 rows
--   * the attacker CAN insert a room into it               -> INSERT 0 1
--   * the victim's own venue page then renders the
--     attacker's text                                      -> confirmed
--
-- That is a tenant-breakout write, the highest-priority class in SECURITY.md
-- § 10, and no control shipped in Phase 2 Task 1 stopped it.
--
-- The galling part: 20260827232512 identified this exact hole class, argued it
-- at length, and closed it -- for `custom_field_values` alone, via a composite
-- foreign key. The technique was already in the schema. It was simply not
-- applied to the other five instances. This migration applies it everywhere it
-- applies.
--
-- ===========================================================================
-- THE FIX, AND WHY IT IS A CONSTRAINT RATHER THAN A POLICY
-- ===========================================================================
--
-- Each child FK is widened from (parent_id) to (parent_id, organisation_id),
-- pointing at a matching unique constraint on the parent. A row can then only
-- name a parent that agrees with it about which tenant it is in -- there is no
-- combination of columns that expresses the attack any more.
--
-- This deliberately does NOT wait for Task 2's policies. A policy is evaluated
-- per role and per operation and can be got wrong; a foreign key is evaluated
-- by the storage engine for every writer, including SECURITY DEFINER functions
-- that bypass RLS entirely and including DBA repair. For a tenant boundary,
-- the constraint is the floor and the policy is the ceiling. SECURITY.md § 2
-- puts RLS first because RLS is what decides *rows*; this decides what rows can
-- exist at all, which is a different and stronger statement.
--
-- ===========================================================================
-- WHAT THE REVIEW'S PRESCRIBED SQL GOT WRONG -- do not revert this
-- ===========================================================================
--
-- The review specified, for the nullable contact reference:
--
--     add constraint artist_representations_contact_fkey
--       foreign key (contact_id, organisation_id)
--       references public.contacts (id, organisation_id) on delete set null;
--
-- Applied verbatim, that is a latent production outage. A bare ON DELETE SET
-- NULL on a COMPOSITE foreign key nulls EVERY referencing column, not just the
-- nullable one. Measured:
--
--     ERROR:  null value in column "organisation_id" of relation
--             "artist_representations" violates not-null constraint
--     CONTEXT: UPDATE ONLY "public"."artist_representations"
--              SET "contact_id" = NULL, "organisation_id" = NULL ...
--
-- So deleting any contact named by a representation would have failed outright.
-- The review's own note asked for verification of the MATCH SIMPLE NULL *insert*
-- behaviour, which is a different control and which does hold -- it reached the
-- right conclusion about the wrong mechanism.
--
-- The correct form is the Postgres 15+ column list, which restricts the SET
-- NULL to the column that is actually nullable. This stack is Postgres 17
-- (supabase/config.toml, `major_version = 17`), so it is available:
--
--     on delete set null (contact_id)
--
-- Measured after the fix: contact_id becomes NULL, organisation_id is intact.
--
-- ===========================================================================
-- SIDE EFFECTS, ALL MEASURED RATHER THAN REASONED
-- ===========================================================================
--
-- (a) RE-HOMING IS NOW BLOCKED IN BOTH DIRECTIONS, which is a bonus the review
--     did not test for on these tables (it tested it only on
--     custom_field_definitions). No ON UPDATE action is specified, so the
--     default NO ACTION applies:
--
--       moving a PARENT to another tenant while children reference it
--         ERROR: update or delete on table "venues" violates foreign key
--                constraint "venue_rooms_venue_fkey" on table "venue_rooms"
--       moving a CHILD to another tenant
--         ERROR: insert or update on table "venue_rooms" violates foreign key
--                constraint "venue_rooms_venue_fkey"
--
--     Both are correct. A record does not change tenant; that is an export and
--     a re-import, and it must not be a column edit.
--
-- (b) ORGANISATION DELETION STILL CASCADES CLEANLY. Each child now has two or
--     three overlapping cascade paths (its own organisation_id FK, plus one or
--     two composite parent FKs). Postgres handles the overlap; measured with a
--     full `delete from organisations`, rooms went 1 -> 0 with no error.
--
-- (c) NO NEW INDEXES ARE NEEDED, and this was measured rather than assumed --
--     it is the same question M2 of the review corrected this task on. The
--     existing single-column FK indexes lead on the parent id, which is the
--     selective column, so the composite lookup plans as a Bitmap Index Scan on
--     the EXISTING index with organisation_id as a heap filter. Against 200
--     venues x 150 rooms:
--
--       Bitmap Heap Scan on venue_rooms
--         Filter: (organisation_id = ...)
--         ->  Bitmap Index Scan on venue_rooms_venue_id_idx
--
--     No sequential scan. Adding (parent_id, organisation_id) composites would
--     duplicate five existing indexes for no measured gain.
--
-- (d) THE PARENTS GAIN A REDUNDANT UNIQUE CONSTRAINT each. `id` is already the
--     primary key, so `unique (id, organisation_id)` adds no integrity to the
--     parent -- it exists only because Postgres requires a unique constraint on
--     exactly the referenced column list. Identical trade to
--     custom_field_definitions_id_org_entity_unique in 20260827232512, and
--     labelled the same way.
--
-- WHAT THIS STILL DOES NOT FIX: custom_field_values.entity_id and
-- merges.winner_id/loser_id remain polymorphic and unenforceable by any
-- foreign key. Those are Task 2's, via the EXISTS-per-entity-type dispatch
-- 20260827232512's header describes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Parents: the unique constraint each composite FK has to point at.
-- ---------------------------------------------------------------------------
alter table public.venues
  add constraint venues_id_org_unique unique (id, organisation_id);
alter table public.contacts
  add constraint contacts_id_org_unique unique (id, organisation_id);
alter table public.companies
  add constraint companies_id_org_unique unique (id, organisation_id);
alter table public.artists
  add constraint artists_id_org_unique unique (id, organisation_id);
alter table public.agencies
  add constraint agencies_id_org_unique unique (id, organisation_id);

comment on constraint venues_id_org_unique on public.venues is
  'Redundant on its own (id is already the primary key). Exists solely as the target of venue_rooms_venue_fkey, the tenant-scoped composite foreign key -- Postgres requires a unique constraint on exactly the referenced column list. Do not drop without dropping that FK.';
comment on constraint contacts_id_org_unique on public.contacts is
  'Redundant on its own. Target of contact_companies_contact_fkey and artist_representations_contact_fkey. Do not drop without dropping those.';
comment on constraint companies_id_org_unique on public.companies is
  'Redundant on its own. Target of contact_companies_company_fkey. Do not drop without dropping it.';
comment on constraint artists_id_org_unique on public.artists is
  'Redundant on its own. Target of artist_representations_artist_fkey and artist_fee_history_artist_fkey. Do not drop without dropping those.';
comment on constraint agencies_id_org_unique on public.agencies is
  'Redundant on its own. Target of artist_representations_agency_fkey. Do not drop without dropping it.';

-- ---------------------------------------------------------------------------
-- 2. Children: swap each single-column FK for its tenant-scoped composite.
--
-- Drop-and-add in one ALTER per table so the table is never momentarily
-- unconstrained: a single ALTER TABLE statement is atomic, and it holds one
-- ACCESS EXCLUSIVE lock rather than two.
-- ---------------------------------------------------------------------------

alter table public.venue_rooms
  drop constraint venue_rooms_venue_id_fkey,
  add  constraint venue_rooms_venue_fkey
       foreign key (venue_id, organisation_id)
       references public.venues (id, organisation_id)
       on delete cascade;

comment on constraint venue_rooms_venue_fkey on public.venue_rooms is
  'Tenant-scoped: a room can only name a venue that agrees with it about which organisation it belongs to. Replaces a single-column venue_id FK under which an attacker could insert a room into another tenant''s venue -- proven end to end, see this migration''s header.';

alter table public.contact_companies
  drop constraint contact_companies_contact_id_fkey,
  drop constraint contact_companies_company_id_fkey,
  add  constraint contact_companies_contact_fkey
       foreign key (contact_id, organisation_id)
       references public.contacts (id, organisation_id)
       on delete cascade,
  add  constraint contact_companies_company_fkey
       foreign key (company_id, organisation_id)
       references public.companies (id, organisation_id)
       on delete cascade;

comment on constraint contact_companies_contact_fkey on public.contact_companies is
  'Tenant-scoped. With its company-side twin it also closes the third variant of the defect: a link row whose organisation_id matched NEITHER parent was previously accepted.';

alter table public.artist_representations
  drop constraint artist_representations_artist_id_fkey,
  drop constraint artist_representations_agency_id_fkey,
  drop constraint artist_representations_contact_id_fkey,
  add  constraint artist_representations_artist_fkey
       foreign key (artist_id, organisation_id)
       references public.artists (id, organisation_id)
       on delete cascade,
  add  constraint artist_representations_agency_fkey
       foreign key (agency_id, organisation_id)
       references public.agencies (id, organisation_id)
       on delete cascade,
  -- The column list on SET NULL is load-bearing, not stylistic. See the header:
  -- without it, deleting a contact tries to null organisation_id too, which is
  -- NOT NULL, and the delete fails.
  add  constraint artist_representations_contact_fkey
       foreign key (contact_id, organisation_id)
       references public.contacts (id, organisation_id)
       on delete set null (contact_id);

comment on constraint artist_representations_contact_fkey on public.artist_representations is
  'Tenant-scoped, and nullable. `on delete set null (contact_id)` -- the Postgres 15+ column list is REQUIRED here: a bare SET NULL on a composite key nulls every referencing column including organisation_id, which is NOT NULL, so deleting any referenced contact would fail. Under MATCH SIMPLE a NULL contact_id skips the check entirely, which is what makes "represented by the agency, no named agent" expressible. Both behaviours are measured, not assumed.';

alter table public.artist_fee_history
  drop constraint artist_fee_history_artist_id_fkey,
  add  constraint artist_fee_history_artist_fkey
       foreign key (artist_id, organisation_id)
       references public.artists (id, organisation_id)
       on delete cascade;

comment on constraint artist_fee_history_artist_fkey on public.artist_fee_history is
  'Tenant-scoped. Note this covers artist_id only -- event_id cannot be foreign-keyed until public.events exists, and is held NULL by a temporary CHECK until Phase 3 (see 20260828001134).';

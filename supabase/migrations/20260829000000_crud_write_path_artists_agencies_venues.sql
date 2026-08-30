-- Phase 2 (Core CRM), Task 4b: the write path for artists, agencies and venues.
--
-- Three things, in the order Task 4's report says they have to happen:
--
--   1. The list indexes every new list needs, because `backedBy` in
--      lib/list/spec.ts is a REQUIRED field naming a REAL index and the three
--      entities had none. Two live sorts plus one deleted sort each, in the
--      exact shape 20260828230000 uses for companies.
--   2. One more index, for the artist fee-history panel, which is a paginated
--      list wearing a detail-page section's clothes.
--   3. public.set_artist_primary_representation(), the artist_representations
--      copy of public.set_contact_primary_company() -- with the organisation
--      term (20260828234500) and the temporal scope
--      (20260828230000's column comment on artist_representations.is_primary).
--
-- Additive only. No existing migration is edited; new indexes and one
-- `create or replace function`. Nothing here needs a policy
-- (`create or replace policy` does not exist in Postgres -- 42601), and the
-- function is SECURITY INVOKER precisely so 20260828121000's and
-- 20260828140500's policies keep deciding both of its statements.

-- ===========================================================================
-- 1. The list indexes
-- ===========================================================================
-- FOLLOW-UPS.md § "Opened by Task 3": a column may be in a list's sort
-- allowlist only if it is NOT NULL and has an index of this exact shape:
--
--   create index <table>_org_<column>_id_live_idx
--     on public.<table> (organisation_id, <sort column>, id)
--     include (owner_user_id)
--     where deleted_at is null;
--
-- Every element is load-bearing and 20260828180000 carries the measurements:
--   * organisation_id LEADING, because the list always pins it by equality and
--     that is what makes the index reachable at all (7x on contacts);
--   * id as the last key column, because keyset pagination compares
--     (sort column, id) and the tie-break has to be in the index;
--   * include (owner_user_id), because the RLS record-scope term reads that
--     column and without it a Standard User's page costs a heap fetch per
--     candidate row (3.170 ms -> 1.545 ms, Heap Fetches: 0);
--   * the partial predicate, because lib/list/query.ts always writes
--     `deleted_at is null` and a partial index is both smaller and the only
--     one the plan can use.
--
-- ASCENDING ONLY. organisation_id is pinned by equality and a btree scans
-- backwards, so one index serves both directions.

create index artists_org_name_id_live_idx
  on public.artists (organisation_id, name, id)
  include (owner_user_id)
  where deleted_at is null;

create index artists_org_updated_at_id_live_idx
  on public.artists (organisation_id, updated_at, id)
  include (owner_user_id)
  where deleted_at is null;

create index agencies_org_name_id_live_idx
  on public.agencies (organisation_id, name, id)
  include (owner_user_id)
  where deleted_at is null;

create index agencies_org_updated_at_id_live_idx
  on public.agencies (organisation_id, updated_at, id)
  include (owner_user_id)
  where deleted_at is null;

create index venues_org_name_id_live_idx
  on public.venues (organisation_id, name, id)
  include (owner_user_id)
  where deleted_at is null;

create index venues_org_updated_at_id_live_idx
  on public.venues (organisation_id, updated_at, id)
  include (owner_user_id)
  where deleted_at is null;

comment on index public.artists_org_name_id_live_idx is
  'Keyset pagination for the artists list, name sort. Mirrors contacts_org_name_id_live_idx; see 20260828180000 for the measurements behind the shape. lib/crm/artists-list.ts names this index in `backedBy` and the sort is not allowed to exist without it.';
comment on index public.artists_org_updated_at_id_live_idx is
  'Keyset pagination for the artists list, updated sort. updated_at is maintained by the trigger in 20260828121500 and is not client-writable, which is what makes it safe to order by.';
comment on index public.agencies_org_name_id_live_idx is
  'Keyset pagination for the agencies list, name sort. See artists_org_name_id_live_idx.';
comment on index public.agencies_org_updated_at_id_live_idx is
  'Keyset pagination for the agencies list, updated sort. See artists_org_updated_at_id_live_idx.';
comment on index public.venues_org_name_id_live_idx is
  'Keyset pagination for the venues list, name sort. See artists_org_name_id_live_idx.';
comment on index public.venues_org_updated_at_id_live_idx is
  'Keyset pagination for the venues list, updated sort. See artists_org_updated_at_id_live_idx.';

-- The restore views. One sort each -- "most recently deleted first" is the
-- only ordering a restore queue is ever read in, and every sort in the
-- allowlist costs an index.
--
-- `notNull: true` on that sort option is true OF THE ROWS THIS INDEX COVERS
-- rather than of the column, because the predicate below constrains it. Said
-- out loud here and in lib/crm/*-list.ts because keyset pagination over a
-- genuinely nullable column silently drops a contiguous band of rows.
create index artists_org_deleted_at_id_idx
  on public.artists (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

create index agencies_org_deleted_at_id_idx
  on public.agencies (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

create index venues_org_deleted_at_id_idx
  on public.venues (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

comment on index public.artists_org_deleted_at_id_idx is
  'Keyset pagination for the deleted-artists (restore) view, which is a separate route from the list. The partial predicate is what makes deleted_at NOT NULL for every row this index covers -- the sort option''s `notNull: true` is true of the indexed set, not of the column.';
comment on index public.agencies_org_deleted_at_id_idx is
  'Keyset pagination for the deleted-agencies (restore) view. See artists_org_deleted_at_id_idx.';
comment on index public.venues_org_deleted_at_id_idx is
  'Keyset pagination for the deleted-venues (restore) view. See artists_org_deleted_at_id_idx.';

-- ===========================================================================
-- 2. The artist fee-history index
-- ===========================================================================
-- PRD 6.3 requires fee HISTORY on the artist, and Task 4b ships the READ half
-- of it (no create/edit form -- fee entry belongs with events and bookings in
-- Phase 5). It is rendered through lib/list/, which means it is a real list
-- endpoint with keyset pagination, which means it needs a real index.
--
-- TWO EQUALITY COLUMNS, NOT ONE. Every other list in this phase pins only
-- organisation_id; this one is a panel on ONE artist, so the query also pins
-- artist_id, and it goes second so the range on occurred_on stays a range.
--
-- NO `include (owner_user_id)`: artist_fee_history has no such column
-- deliberately (20260827232510 convention (2) -- a child's record scope is its
-- parent's, and a second independently-writable owner is a way for the two to
-- disagree). The record-scope term in artist_fee_history_select_via_artist
-- reads public.artists.owner_user_id, which this index cannot cover.
--
-- `occurred_on` is NOT NULL in the table definition, so the sort option's
-- `notNull: true` is true of the COLUMN here, unlike the deleted views above.
create index artist_fee_history_org_artist_occurred_on_id_live_idx
  on public.artist_fee_history (organisation_id, artist_id, occurred_on, id)
  where deleted_at is null;

comment on index public.artist_fee_history_org_artist_occurred_on_id_live_idx is
  'Keyset pagination for the fee-history panel on an artist detail page. Two equality columns (organisation_id, artist_id) then the sort column, because the panel is scoped to one artist. lib/crm/artists-list.ts names it in `backedBy`. No INCLUDE: this table has no owner_user_id by design -- record scope comes from public.artists through the policy''s EXISTS.';

-- ===========================================================================
-- 3. set_artist_primary_representation()
-- ===========================================================================
-- The artist_representations copy of public.set_contact_primary_company().
-- Everything that function's header (20260828230000) and 20260828234500's
-- header argue applies here unchanged, so it is not repeated: the operation is
-- genuinely two statements, a partial unique index cannot be deferred, a
-- single UPDATE doing both is checked per row and therefore order-dependent,
-- supabase-js issues one HTTP request per statement, and a function body is
-- the only place a transaction can be. S1/S2/S3 in the RLS suite pin the
-- measurement for contact_companies; T1/T2/T3 pin it for this table.
--
-- THREE ARGUMENTS, AND THE ORGANISATION IS NOT OPTIONAL. 20260828234500's
-- header says it in terms and this is the copy it was written for: RLS answers
-- "may this caller write this row"; `organisation_id = p_organisation_id`
-- answers "is this row the one this URL is about". A multi-org member is where
-- those diverge -- the 2-arg set_contact_primary_company() let an admin of two
-- workspaces promote a company on the other workspace's contact from this
-- one's URL, and it returned 1. There is deliberately NO 2-arg overload of
-- this function, ever: PostgREST resolves an RPC by the argument NAMES in the
-- request body, so a granted unscoped variant is one missing JSON key away.
--
-- ===========================================================================
-- THE ONE DIFFERENCE FROM THE CONTACT VERSION: THE TEMPORAL SCOPE
-- ===========================================================================
-- The two indexes have different predicates:
--
--   contact_companies_one_primary_per_contact
--     ON (contact_id) WHERE is_primary
--   artist_representations_one_current_primary_per_artist
--     ON (artist_id)  WHERE is_primary AND ended_at IS NULL AND deleted_at IS NULL
--
-- So BOTH statements below are scoped `ended_at is null and deleted_at is
-- null`, matching that predicate exactly. Measured on this database before
-- this function was written -- one artist, one open-ended primary, then:
--
--   + a primary with ended_at = 2099-01-01   INSERT 0 1   is_primary rows: 2
--   + a primary with ended_at = 2098-01-01   INSERT 0 1   is_primary rows: 3
--   + a primary with ended_at = 2023-01-01   INSERT 0 1   is_primary rows: 4
--   + a SECOND OPEN-ENDED primary            23505        duplicate key value
--                                                         violates unique
--                                                         constraint
--
-- WHY THE DEMOTE MUST CARRY `ended_at is null`: an artist whose primary was
-- Agency X from 2020 to 2023 must keep that row `is_primary = true`. A demote
-- that ignores ended_at rewrites history -- it would silently erase the answer
-- to "who represented them then", which is the whole point of a table with a
-- period on it rather than a column on the artist.
--
-- WHY THE DEMOTE MUST CARRY `deleted_at is null`: same argument, plus
-- deleteRepresentationAction's own contract -- restore has to bring the record
-- back as it was, and a demote that reached into soft-deleted rows would make
-- restore bring back something else.
--
-- WHY THE PROMOTE CARRIES BOTH TOO, which the contact version has no analogue
-- for. Without them this function could demote the live open-ended primary and
-- promote an ENDED or SOFT-DELETED row in its place, leaving the artist with
-- no current primary at all and one marked on a row the product does not show
-- as current. Both statements therefore operate on exactly the set the index
-- constrains, and a promote that matches nothing RAISES -- so the demote rolls
-- back with it, for the reason the contact version gives.
--
-- WHY `artist_id = p_artist_id` IS ON THE PROMOTE AS WELL AS THE ID. The id
-- alone would let a representation belonging to a DIFFERENT artist in the same
-- workspace be promoted from this artist's page -- and the demote, which is
-- keyed on p_artist_id, would already have cleared this artist's primary. Two
-- artists damaged by one forged form post. The organisation term does not
-- catch this: both artists are in the same organisation.
--
-- SECURITY INVOKER, and that is the whole security argument. Both statements
-- run as the caller under artist_representations_update_via_artist, which
-- requires 'manage_artists' on the artist's organisation, record scope over
-- the parent artist, private.crm_write_organisations() on the WITH CHECK side,
-- and -- as of 20260829001000 -- that the parent artist is not soft-deleted.
-- No `set search_path` and no `security definer`: SECURITY.md § 2's pinned
-- search_path requirement is about SECURITY DEFINER functions, which run with
-- the definer's rights. This one runs with the caller's, and every object it
-- names is schema-qualified anyway.
create or replace function public.set_artist_primary_representation(
  p_artist_id uuid,
  p_representation_id uuid,
  p_organisation_id uuid
)
returns integer
language plpgsql
as $$
declare
  v_promoted integer := 0;
  v_demoted  integer := 0;
begin
  -- DEMOTE FIRST, ALWAYS. The reverse order raises 23505 against the
  -- non-deferrable partial unique index.
  --
  -- `is distinct from` rather than `<>` so a null p_representation_id -- "this
  -- artist has no primary representation" -- demotes and promotes nothing.
  -- Re-nominating the representation that is ALREADY primary is a no-op that
  -- still reports 1, because from the caller's side the write applied: the
  -- state they asked for is the state that holds.
  update public.artist_representations
     set is_primary = false
   where organisation_id = p_organisation_id
     and artist_id = p_artist_id
     and is_primary
     -- The index's predicate, exactly. See the header: without these two an
     -- ordinary "make this agency primary" rewrites the artist's history.
     and ended_at is null
     and deleted_at is null
     and (p_representation_id is null or id is distinct from p_representation_id);
  get diagnostics v_demoted = row_count;

  if p_representation_id is null then
    -- CLEARING. Zero rows demoted has to be an error, for the reason
    -- set_contact_primary_company() gives at length: with no promote to follow
    -- it, the count of an accepted no-op and the count of a refusal are both
    -- 0, and asking a second question to tell them apart would be asking
    -- whether a row the caller may not write exists -- the oracle this schema
    -- is careful not to build.
    --
    -- REACHABLE BY A RACE AS WELL AS BY A REFUSAL. Under READ COMMITTED two
    -- overlapping calls, one promoting and one clearing, can leave the clear
    -- with v_demoted = 0 at a moment when a primary demonstrably exists. The
    -- transaction still rolls back whole, which is the property that matters;
    -- the message is the part that is wrong, and lib/crm/artists.ts carries
    -- the honest one for the 23505 half of the same race.
    if v_demoted = 0 then
      raise exception
        'no current primary representation to clear, or artist_representations not writable by this caller in this workspace'
        using errcode = '42501';
    end if;
    return 0;
  end if;

  update public.artist_representations
     set is_primary = true
   where organisation_id = p_organisation_id
     -- Both, not just the id. See the header: the id alone lets another
     -- artist's representation be promoted from this artist's page, after the
     -- demote has already cleared this artist's primary.
     and artist_id = p_artist_id
     and id = p_representation_id
     and ended_at is null
     and deleted_at is null;
  get diagnostics v_promoted = row_count;

  -- ZERO ROWS PROMOTED MUST NOT COMMIT THE DEMOTION. Otherwise the one thing
  -- this function exists to prevent -- an artist left with no primary because
  -- half the operation applied -- is reachable through an ordinary refusal.
  -- Raising rolls the demotion back with it.
  --
  -- 42501 (insufficient_privilege) rather than a bespoke code. PostgREST maps
  -- it to 403, which is what the caller needs to see, and it does not
  -- distinguish "the policy refused you" from "no such representation" from
  -- "wrong workspace" from "that representation has ended" -- which it must
  -- not, because from outside the tenant the first three are the same fact and
  -- telling them apart is an existence oracle for another organisation's rows.
  if v_promoted = 0 then
    raise exception
      'artist_representations row not writable by this caller in this workspace, or it is not a current representation'
      using errcode = '42501';
  end if;

  -- The count, not a boolean and not void. The caller has to be able to tell
  -- an applied write from an accepted no-op, and every other mutating path in
  -- this application does that by reading a row count (lib/crm/write.ts).
  return v_promoted;
end;
$$;

comment on function public.set_artist_primary_representation(uuid, uuid, uuid) is
  'Sets (or, with a null representation, clears) an artist''s CURRENT primary representation as ONE transaction, within ONE organisation. Required, not convenience: artist_representations_one_current_primary_per_artist is a partial unique index and cannot be deferred, so demote-then-promote in one transaction is the only correct order. p_organisation_id is MANDATORY and is not redundant with RLS -- RLS answers "may this caller write this row", the organisation term answers "is this row the one this URL is about", and a multi-org member is where those diverge (20260828234500). There is deliberately no 2-arg overload: PostgREST resolves an RPC by argument NAME, so an unscoped variant would be one missing JSON key away. BOTH statements are scoped `ended_at is null and deleted_at is null`, matching the index predicate exactly: a demote that ignored ended_at would rewrite the artist''s representation history, and a promote that ignored it could leave the artist with no CURRENT primary while marking one on a row the product does not show as current. The promote also carries artist_id, because the id alone would let another artist''s representation be promoted after this artist''s primary had been demoted. SECURITY INVOKER: it adds no privilege, and every refusal the RLS policies make against a direct PATCH they make against this. Returns the number of rows promoted (0 only when clearing).';

grant execute on function public.set_artist_primary_representation(uuid, uuid, uuid) to authenticated;

-- ===========================================================================
-- THE RESIDUAL GAP, RESTATED WHERE THE WRITE PATH IS
-- ===========================================================================
-- FOLLOW-UPS.md: this index enforces one OPEN-ENDED primary, not one CURRENT
-- one, because `current_date` is not IMMUTABLE and cannot appear in a partial
-- index predicate (nor in a CHECK constraint). A representation with
-- `ended_at = '2099-01-01'` is outside the predicate, so it can carry
-- `is_primary` alongside an open-ended primary -- measured above, four such
-- rows on one artist.
--
-- TASK 4b'S DECISION: ACCEPT THE GAP. A representation that ends on a known
-- future date is an ordinary industry fact -- an agency agreement with a
-- notice period, a territory deal that lapses at year end -- and people record
-- it when they sign it, not on the day it takes effect. Rejecting a
-- future-dated `ended_at` (the alternative) would forbid a true fact in order
-- to protect an index name, and it would have to be a trigger or
-- application-only, since a CHECK cannot call current_date either.
--
-- SO THE AMBIGUITY IS A DISPLAY QUESTION, AND THE TIE-BREAK RULE IS WRITTEN
-- WHERE READS HAPPEN (lib/crm/queries.ts, loadRepresentationsForArtist):
--
--   The CURRENT primary is the representation with `is_primary` and
--   `ended_at is null`. The index guarantees there is at most one, and that
--   is the only row the product labels "Primary".
--   Any other `is_primary` row is labelled with its period instead --
--   "Primary until <date>" when the end date is in the future, "Was primary"
--   when it has passed -- and never as the current primary.
--
-- THIS FUNCTION CANNOT CREATE THE AMBIGUOUS STATE, which is why accepting it
-- is cheap: the promote refuses anything with an `ended_at`, so "make this
-- primary" on a representation that ends in 2099 is a 42501, not a second
-- primary. The state is reachable only by EDITING an already-primary
-- historical row to carry a future end date, which is a deliberate act on a
-- row the form shows as "Was primary".

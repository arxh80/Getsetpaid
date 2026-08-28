-- Phase 2 (Core CRM), Task 4b: put the "a deleted record's children cannot be
-- changed" rule behind the database, on the PARENT end, for the two child
-- tables Task 4b opens write paths to.
--
-- Additive only. Five `alter policy` statements, no existing migration edited,
-- and no new policy created (`create or replace policy` does not exist in
-- Postgres -- 42601). The bodies below are 20260828140500's, verbatim, with
-- ONE new conjunct: `p.deleted_at is null`.
--
-- 20260828235000 did exactly this for contact_companies and left the
-- instruction in its own header:
--
--     `artist_representations_*_via_artist` has the same shape and will want
--     the same conjunct on `artists.deleted_at` -- and the same restraint
--     about the agency/contact ends, for the same Q3a reason.
--
-- This is that migration. It also covers venue_rooms, which 20260828235000 did
-- not mention because Task 4 had no venue screens.
--
-- ===========================================================================
-- WHY THE PARENT AND NOT THE OTHER ENDS
-- ===========================================================================
-- artist_representations names three parents -- artist, agency, contact -- and
-- ONE of them is its scope. 20260828121000 chose the artist (Q3a): the artist
-- is the record the representation is about, and the agency and contact are
-- who represents them. So:
--
--   * THE ARTIST END GOES IN THE POLICY. It is already the row every one of
--     these policies reaches EXISTS against, so adding `p.deleted_at is null`
--     costs nothing and reads no row the caller could not already read.
--
--   * THE AGENCY AND CONTACT ENDS STAY APPLICATION-ONLY (lib/crm/artists.ts,
--     `liveInOrg`). An `agencies.deleted_at is null` term would have to READ
--     THE AGENCY ROW, and a policy predicate is evaluated as the caller. Q3a
--     deliberately permits a record-scoped user who owns the artist to record
--     a representation naming an agency they cannot see, so such a term would
--     collapse "the agency is deleted" into "I cannot see the agency" and
--     start refusing writes against perfectly live agencies. That is the same
--     asymmetry 20260828235000 argued for the company end of
--     contact_companies, and it is measured the same way: T28 asserts the
--     database REFUSES on the artist end, T28b asserts it still PERMITS when
--     the only deleted end is the agency.
--
-- venue_rooms has only ONE parent and nothing to be restrained about: a room
-- is a pure child of its venue, scope follows the venue, and there is no
-- second entity to disclose. So its half of this migration is one-sided.
--
-- ===========================================================================
-- SELECT IS UNTOUCHED, and that is the whole of design note (g)
-- ===========================================================================
-- A deleted artist's representations and a deleted venue's rooms stay
-- READABLE: the detail route renders them next to the "Deleted" notice so a
-- user can see what restoring would bring back, and the restore queue reads
-- the record itself. Only the WRITE verbs change. There is no DELETE policy on
-- either table -- both carry `deleted_at` and removal is an UPDATE -- so
-- INSERT and UPDATE is the whole surface.

-- ---------------------------------------------------------------------------
-- artist_representations
-- ---------------------------------------------------------------------------

-- INSERT. WITH CHECK only; a refused insert is a loud 403.
alter policy "artist_representations_insert_via_artist" on public.artist_representations
  with check (
    artist_representations.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.artists p
      where p.id = artist_representations.artist_id
        and p.organisation_id = artist_representations.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- UPDATE. The conjunct goes in BOTH halves: USING sees the OLD artist_id and
-- WITH CHECK the NEW one, so without it in USING a representation could still
-- be moved OFF a deleted artist, and without it in WITH CHECK one could be
-- moved ON to a deleted artist.
--
-- This is also what makes soft-DELETING and RESTORING a representation refuse
-- while the artist is deleted, since both of those are UPDATEs on this table.
alter policy "artist_representations_update_via_artist" on public.artist_representations
  using (
    exists (
      select 1 from public.artists p
      where p.id = artist_representations.artist_id
        and p.organisation_id = artist_representations.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    artist_representations.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('artist_representation', artist_representations.id, artist_representations.organisation_id)
    and exists (
      select 1 from public.artists p
      where p.id = artist_representations.artist_id
        and p.organisation_id = artist_representations.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

comment on policy "artist_representations_update_via_artist" on public.artist_representations is
  'Scoped by the ARTIST (Q3a), which must be LIVE: `p.deleted_at is null` in both USING and WITH CHECK, so a soft-deleted artist''s representations cannot be edited, soft-deleted, restored, or repointed either off it or on to it. The AGENCY and CONTACT ends are deliberately not checked here -- an agencies.deleted_at term would have to read a row a record-scoped caller may not see, and would collapse "deleted" into "invisible", breaking the Q3a case where a Standard User records a representation naming an agency they do not own. Those ends are checked by lib/crm/artists.ts (liveInOrg) only. Measured at T28 / T28b in supabase/tests/rls_phase2_crm.sql. set_artist_primary_representation() is SECURITY INVOKER, so this policy decides both of its statements too.';

-- ---------------------------------------------------------------------------
-- venue_rooms
-- ---------------------------------------------------------------------------

alter policy "venue_rooms_insert_via_venue" on public.venue_rooms
  with check (
    venue_rooms.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.venues p
      where p.id = venue_rooms.venue_id
        and p.organisation_id = venue_rooms.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_venues'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

alter policy "venue_rooms_update_via_venue" on public.venue_rooms
  using (
    exists (
      select 1 from public.venues p
      where p.id = venue_rooms.venue_id
        and p.organisation_id = venue_rooms.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_venues'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    venue_rooms.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('venue_room', venue_rooms.id, venue_rooms.organisation_id)
    and exists (
      select 1 from public.venues p
      where p.id = venue_rooms.venue_id
        and p.organisation_id = venue_rooms.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_venues'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

comment on policy "venue_rooms_update_via_venue" on public.venue_rooms is
  'Scoped by the VENUE, which must be LIVE: `p.deleted_at is null` in both USING and WITH CHECK, so a soft-deleted venue''s rooms cannot be renamed, closed or reopened until the venue is restored. Unlike artist_representations and contact_companies there is no second entity here -- a room is a pure child, its record scope is its venue''s, and there is no other end to leave application-only. Measured at T29 in supabase/tests/rls_phase2_crm.sql. The tenant-scoped composite FK venue_rooms_venue_fkey (20260828001132) remains the control that holds for every writer in every role; this policy is the one that refuses an `authenticated` caller first, with 42501.';

-- Phase 2 (Core CRM), Task 2 fix round 1: the policy half.
--
-- Depends on 20260828140000, which added private.crm_write_organisations() and
-- the five new private.entity_org_unchanged() branches this file calls.
--
--   IMP-1  entitlement on all 25 write policies
--   IMP-2  merges SELECT requires BOTH sides visible, not just the winner
--   IMP-3  organisation_id pinned on the five child tables that lacked it
--   IMP-6  the "existence oracle" note corrected, on the policies themselves
--
-- `alter policy`, not drop-and-create: it edits no previous migration, is
-- re-runnable, and never leaves the table governed by one fewer policy. There
-- is no `create or replace policy` in PostgreSQL (42601 on the pinned 17.6),
-- which 20260828122000's header already records.
--
-- ALTER POLICY REPLACES THE NAMED CLAUSE WHOLESALE, so every expression below
-- is restated in full even where only one conjunct is new. Omitting a clause
-- leaves the previous expression in place rather than clearing it, which is the
-- kind of thing that is correct by accident.
--
-- ===========================================================================
-- WHERE THE ENTITLEMENT CONJUNCT GOES, AND WHY IT IS NOT SYMMETRIC
-- ===========================================================================
-- INSERT   -> WITH CHECK.  The only clause an INSERT policy has.
-- UPDATE   -> WITH CHECK ONLY, deliberately not USING.
-- DELETE   -> USING.       The only clause a DELETE policy has.
--
-- Every UPDATE must satisfy WITH CHECK, so putting the entitlement term there
-- alone is sufficient -- no write escapes. Putting it in USING as well would be
-- symmetric and worse: the row would stop matching, and PostgREST would return
-- `204 No Content` for a refusal instead of `403`, which the review's MIN-5
-- flags as indistinguishable from success. Foundation's own design note (c)
-- says a write that silently matches zero rows is "worse than one that just
-- fails". A Free-tier user editing a contact should be told they cannot, not
-- handed a success-shaped response.
--
-- The two DELETE policies cannot have that: a DELETE policy has no WITH CHECK,
-- so an unentitled delete IS a silent zero-row result. Recorded in
-- FOLLOW-UPS.md against Tasks 3-7 beside the MIN-5 item, which they have to
-- handle anyway.
--
-- READS ARE NOT ENTITLEMENT-GATED. CLAUDE.md § Subscription tiers gives Free
-- "No -- view-only network browsing", i.e. Free is a READ tier. Gating reads
-- would also mean a downgrade hides a customer's existing data, which
-- CLAUDE.md § Permissions forbids in the strongest terms ("it must never
-- silently delete data"; invisible is worse than deleted, because it looks like
-- deleted). `view_crm` therefore stays on permitted_organisations() alone.

-- ===========================================================================
-- 1. Top-level entities -- entitlement on INSERT and UPDATE
-- ===========================================================================

alter policy "companies_insert_manage_contacts" on public.companies
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

alter policy "companies_update_manage_contacts" on public.companies
  using (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('company', id, organisation_id)
  );

alter policy "contacts_insert_manage_contacts" on public.contacts
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

alter policy "contacts_update_manage_contacts" on public.contacts
  using (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('contact', id, organisation_id)
  );

alter policy "agencies_insert_manage_contacts" on public.agencies
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

alter policy "agencies_update_manage_contacts" on public.agencies
  using (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('agency', id, organisation_id)
  );

alter policy "artists_insert_manage_artists" on public.artists
  with check (
    organisation_id in (select private.permitted_organisations('manage_artists'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

alter policy "artists_update_manage_artists" on public.artists
  using (
    organisation_id in (select private.permitted_organisations('manage_artists'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_artists'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('artist', id, organisation_id)
  );

alter policy "venues_insert_manage_venues" on public.venues
  with check (
    organisation_id in (select private.permitted_organisations('manage_venues'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

alter policy "venues_update_manage_venues" on public.venues
  using (
    organisation_id in (select private.permitted_organisations('manage_venues'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_venues'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('venue', id, organisation_id)
  );

-- ===========================================================================
-- 2. Child and join tables -- entitlement AND the organisation_id pin (IMP-3)
-- ===========================================================================
-- The pin is the substantive change here. 20260828121000 design note (e)
-- asserted these tables inherited organisation_id immutability from their
-- tenant-scoped composite FK. They do not: the FK constrains the NEW pair, so a
-- caller authorised in both tenants moves the child and its parent reference in
-- one statement and the constraint is satisfied. Reproduced by the reviewer on
-- custom_field_values, which does not even have a composite FK to its entity.
-- 20260828140000's header carries the full correction.

alter policy "contact_companies_insert_via_contact" on public.contact_companies
  with check (
    contact_companies.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

alter policy "contact_companies_update_via_contact" on public.contact_companies
  using (
    exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    contact_companies.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('contact_company', contact_companies.id, contact_companies.organisation_id)
    and exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- A DELETE policy has no WITH CHECK, so the entitlement term has to live in
-- USING and an unentitled delete is a silent zero-row result rather than a
-- 403. See the header.
alter policy "contact_companies_delete_via_contact" on public.contact_companies
  using (
    contact_companies.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

alter policy "artist_representations_insert_via_artist" on public.artist_representations
  with check (
    artist_representations.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.artists p
      where p.id = artist_representations.artist_id
        and p.organisation_id = artist_representations.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

alter policy "artist_representations_update_via_artist" on public.artist_representations
  using (
    exists (
      select 1 from public.artists p
      where p.id = artist_representations.artist_id
        and p.organisation_id = artist_representations.organisation_id
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
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

alter policy "artist_fee_history_insert_via_artist" on public.artist_fee_history
  with check (
    artist_fee_history.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.artists p
      where p.id = artist_fee_history.artist_id
        and p.organisation_id = artist_fee_history.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

alter policy "artist_fee_history_update_via_artist" on public.artist_fee_history
  using (
    exists (
      select 1 from public.artists p
      where p.id = artist_fee_history.artist_id
        and p.organisation_id = artist_fee_history.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    artist_fee_history.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('artist_fee', artist_fee_history.id, artist_fee_history.organisation_id)
    and exists (
      select 1 from public.artists p
      where p.id = artist_fee_history.artist_id
        and p.organisation_id = artist_fee_history.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

alter policy "venue_rooms_insert_via_venue" on public.venue_rooms
  with check (
    venue_rooms.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.venues p
      where p.id = venue_rooms.venue_id
        and p.organisation_id = venue_rooms.organisation_id
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
        and p.organisation_id in (select private.permitted_organisations('manage_venues'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- ===========================================================================
-- 3. Custom fields
-- ===========================================================================

alter policy "custom_field_definitions_insert_manage_custom_fields" on public.custom_field_definitions
  with check (
    organisation_id in (select private.permitted_organisations('manage_custom_fields'))
    and organisation_id in (select private.crm_write_organisations())
  );

alter policy "custom_field_definitions_update_manage_custom_fields" on public.custom_field_definitions
  using (
    organisation_id in (select private.permitted_organisations('manage_custom_fields'))
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_custom_fields'))
    and organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('custom_field_definition', id, organisation_id)
  );

-- custom_field_values is the table IMP-3 was reproduced on: as an admin of both
-- organisations, one UPDATE moved a row and its value from tenant A to tenant
-- B, carrying the original id and created_at. It has no composite FK to its
-- ENTITY at all -- its composite FK points at the definition -- so nothing
-- structural was ever holding it in place.
alter policy "custom_field_values_insert_via_entity" on public.custom_field_values
  with check (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and organisation_id in (select private.crm_write_organisations())
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
  );

alter policy "custom_field_values_update_via_entity" on public.custom_field_values
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
  )
  with check (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('custom_field_value', id, organisation_id)
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
  );

alter policy "custom_field_values_delete_via_entity" on public.custom_field_values
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and organisation_id in (select private.crm_write_organisations())
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
  );

-- ===========================================================================
-- 4. merges -- IMP-2, and entitlement on the insert
-- ===========================================================================
-- 20260828121000 § 4 scoped this SELECT by the WINNER, with the argument that
-- field_resolution is a verbatim copy of two records' contents and an org-wide
-- read policy would be "the record-scope boundary defeated by a history table".
-- The argument was right and the implementation only did half of it: the
-- reviewer had a Manager merge a contact a Standard User could not see into one
-- they owned, and the Standard User then read the DISCARDED email and phone of
-- the record that was never in their scope.
--
-- Requiring both sides. The coordinator's call, and I agree with it over the
-- alternative the review offered (restrict merges SELECT to
-- full_scope_organisations, on the grounds that a merge is an administrative
-- artefact). The alternative is simpler and also safe, but it takes something
-- real away: a Standard User who merges two of their OWN duplicate contacts
-- should be able to see that they did. Requiring both sides keeps that case
-- working and closes the leak, and it degrades in the right direction --
-- a merge involving a record you cannot see is a merge you cannot see.
--
-- It works because RLS does not filter soft-deleted rows (20260828121000 design
-- note (h)): the loser is soft-deleted by definition and is still resolvable,
-- with its owner_user_id unchanged. THE COROLLARY, for Task 6 and Phase 7: if a
-- loser is ever HARD-deleted, its merge record becomes invisible to everyone,
-- including the superuser's audit view. That is the correct failure direction
-- for a confidentiality control and the wrong one for a history table, and it
-- is the reason merges rows must be read through the audit trail rather than
-- through this policy when the record is gone.
--
-- The policy name still says "via_winner". Renaming a policy is a drop and
-- create, which this file deliberately avoids; the comment below carries the
-- truth and a later migration can rename it if it ever matters.
alter policy "merges_select_via_winner" on public.merges
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and private.entity_is_visible(entity_type, winner_id, organisation_id)
    and private.entity_is_visible(entity_type, loser_id,  organisation_id)
  );

comment on policy "merges_select_via_winner" on public.merges is
  'MISNAMED SINCE FIX ROUND 1: it now requires BOTH the winner and the loser to be visible. Scoping by the winner alone let a record-scoped user read field_resolution, which copies the DISCARDED values of both records verbatim -- reproduced: a Standard User read the email and phone of a contact that was never in their scope. Renaming would mean dropping and re-creating the policy; the name is left and this comment is the record.';

alter policy "merges_insert_merge_records" on public.merges
  with check (
    organisation_id in (select private.permitted_organisations('merge_records'))
    and organisation_id in (select private.crm_write_organisations())
    and merged_by = (select auth.uid())
    and private.entity_is_manageable(entity_type, winner_id, organisation_id)
    and private.entity_is_manageable(entity_type, loser_id,  organisation_id)
  );

-- ===========================================================================
-- 5. IMP-6 -- the risk note that was wrong, corrected on the policies it is about
-- ===========================================================================
-- 20260828121000's contact_companies comment and task-2-report § 3.5 both say
-- the residue of the Q5 decision "requires guessing a v4 uuid inside one's own
-- organisation and reveals nothing but existence". BOTH HALVES ARE WRONG, and
-- the correction belongs on the policy rather than only in a document.
--
-- Nothing has to be guessed: the SELECT policy hands the identifiers over. And
-- it is not only existence: the same disclosure runs through
-- artist_representations, which exposes agency_id AND contact_id of rows the
-- scoped user cannot read -- Q3a called that "a display wart, not a
-- disclosure", which is also wrong.
--
-- The Q5 PRODUCT DECISION IS UNCHANGED and is still defensible; what was wrong
-- is the risk assessment recorded beside it. Closing the read half means
-- reintroducing the AND that Q5 rejected. Closing the write half belongs in
-- Task 4's form (offer only companies the caller can read), not in a policy,
-- because a policy that refuses it would break the legitimate case Q5 exists to
-- protect. SECURITY.md § 10 and FOLLOW-UPS.md carry the same corrected text.
comment on policy "contact_companies_select_via_contact" on public.contact_companies is
  'Scoped by the CONTACT only (DECISIONS-QUEUE Q5). CORRECTED RISK NOTE, fix round 1: this hands a record-scoped user the PRIMARY KEY of every company linked to a contact they own, including companies outside their record scope -- no uuid has to be guessed, and the earlier note claiming otherwise was wrong. No attributes leak: a PostgREST embed of companies(*) renders null and companies!inner(*) renders []. The write consequence is real -- a Standard User can create and delete links to companies they cannot see, and those links surface on the company page for full-scope users. Accepted as the cost of Q5; the read half cannot be closed without the AND that Q5 rejected, and the write half is Task 4''s form, not a policy.';

comment on policy "artist_representations_select_via_artist" on public.artist_representations is
  'Scoped by the ARTIST (DECISIONS-QUEUE Q3a). CORRECTED RISK NOTE, fix round 1: Q3a calls the consequence "a display wart, not a disclosure". It is an identifier disclosure -- a record-scoped user reads the agency_id AND contact_id of every representation on an artist they own, including agencies and contacts entirely outside their scope, plus the free-text role and territory on the representation row itself. No attributes of the agency or contact leak (embeds render null). Same disposition as contact_companies: the product decision stands, the risk note did not.';

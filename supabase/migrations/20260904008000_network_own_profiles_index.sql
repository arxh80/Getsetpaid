-- Phase 6 (Network), Task 2: the covering index for "this organisation's own
-- profiles" -- app/(app)/[orgSlug]/network/profiles/page.tsx.
--
-- ===========================================================================
-- THIS IS THE ORDINARY, ORGANISATION-SCOPED LIST -- NOT THE DIRECTORY
-- ===========================================================================
-- 20260904000000 already shipped `network_profiles_directory_idx`
-- (status, display_name, id) for the ONE list in the product that is not
-- organisation-scoped (Task 3's discovery page, lib/network/discovery-list.ts).
-- That index cannot serve THIS list: a caller's own profiles are read
-- `where organisation_id = $1 and deleted_at is null`, which the directory
-- index's leading column (`status`) does nothing to narrow. This is the
-- ordinary shape every other entity list in the product uses
-- (companies_org_updated_at_id_live_idx is the direct precedent, added by
-- 20260828230000 for exactly the same reason: `backedBy` is a required field
-- naming a real index, and network_profiles had none for its OWN organisation
-- scoped read).
--
-- Constraint 9: the sort column must be NOT NULL (`updated_at` is, and is
-- trigger-maintained by `set_updated_at`, so it is not client-writable) and
-- named by a real index or the sort does not belong in the allowlist.
--
-- ADDITIVE. A new index is its own statement; nothing here alters a shipped
-- migration.
create index network_profiles_org_updated_at_id_live_idx
  on public.network_profiles (organisation_id, updated_at, id)
  where deleted_at is null;

comment on index public.network_profiles_org_updated_at_id_live_idx is
  'Keyset pagination for "this organisation''s own profiles" (Task 2, app/(app)/[orgSlug]/network/profiles/page.tsx), updated sort -- the ordinary organisation-scoped shape, distinct from network_profiles_directory_idx which serves the cross-tenant discovery list only. lib/network/profiles-list.ts names this index in `backedBy`.';

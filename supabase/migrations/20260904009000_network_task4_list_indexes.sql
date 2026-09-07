-- Phase 6 (Network), Task 4: covering indexes for the two new paginated
-- surfaces this task ships -- the requests inbox/outbox
-- (lib/network/requests-list.ts, app/(app)/[orgSlug]/network/requests) and
-- the "your linked records" list (lib/network/links-list.ts).
--
-- ADDITIVE. `20260904008000_network_own_profiles_index.sql` is the immediate
-- precedent: a list shipped in an earlier task, and this task's own list
-- needs its own index rather than an edit to a shipped migration (Constraint
-- 1).
--
-- ===========================================================================
-- network_connection_requests: TWO INDEXES, ONE PER DIRECTION
-- ===========================================================================
-- The requests page is two lists on one route (Received, Sent -- Constraint
-- 10), each scoped by a DIFFERENT organisation column on the same bi-tenant
-- table (Q83). `network_connection_requests_to_org_idx` and `..._from_org_idx`
-- (20260904000000) already exist but are single-column -- they do not cover
-- the default sort (requested_at desc) or the keyset tie-break (id), so a page
-- of either list would be an index scan on the organisation predicate followed
-- by a top-N sort of every request that organisation has ever sent or
-- received. Composite indexes here are the same fix
-- `contacts_org_name_id_live_idx` (Phase 2) and
-- `network_profiles_org_updated_at_id_live_idx` (Task 2) already made for
-- every other org-scoped list in this product.
--
-- NO `where deleted_at is null` PREDICATE. `network_connection_requests` has
-- no `deleted_at` column at all (20260904000000's own header: "a request is
-- never deleted, it moves to a terminal status"), so there is no soft-delete
-- line to partial the index on. lib/list/query.ts's TABLES_WITHOUT_SOFT_DELETE
-- gains this table's name in the same change that adds these indexes, for the
-- identical reason `network_directory` is already in that set: asking
-- PostgREST to filter a column that does not exist is a 400.
create index network_connection_requests_to_org_requested_at_id_idx
  on public.network_connection_requests (to_organisation_id, requested_at, id);

create index network_connection_requests_from_org_requested_at_id_idx
  on public.network_connection_requests (from_organisation_id, requested_at, id);

comment on index public.network_connection_requests_to_org_requested_at_id_idx is
  'Covers the Received requests list''s default sort (requested_at desc) and its keyset range, for one recipient organisation. lib/network/requests-list.ts''s NETWORK_REQUESTS_RECEIVED_LIST.backedBy names this index. No partial predicate: this table has no deleted_at (a request moves to a terminal status instead of being deleted).';

comment on index public.network_connection_requests_from_org_requested_at_id_idx is
  'Covers the Sent requests list''s default sort (requested_at desc) and its keyset range, for one sending organisation. lib/network/requests-list.ts''s NETWORK_REQUESTS_SENT_LIST.backedBy names this index.';

-- ===========================================================================
-- network_links: ONE INDEX, THE ORDINARY SHAPE
-- ===========================================================================
-- Unlike the two above, network_links IS organisation-scoped in the ordinary
-- way (this organisation's OWN links) and DOES soft-delete
-- (`network_links_organisation_id_idx` already exists but, like the two
-- indexes above, is not composite with the sort column or the tie-break).
-- Partial on `deleted_at is null`, the same shape as every other live-rows
-- list index in this schema (contacts, network_profiles, ...).
create index network_links_org_created_at_id_live_idx
  on public.network_links (organisation_id, created_at, id)
  where deleted_at is null;

comment on index public.network_links_org_created_at_id_live_idx is
  'Covers "your linked records" (lib/network/links-list.ts NETWORK_LINKS_LIST)''s default sort (created_at desc) and its keyset range, live rows only. lib/network/links-list.ts''s backedBy comment names this index.';

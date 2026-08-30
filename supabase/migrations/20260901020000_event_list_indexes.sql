-- Phase 3 (Events), Task 3: the four indexes the events list surface needs.
--
-- ADDITIVE ONLY. Four `create index` statements and four comments; no existing
-- migration is edited, no policy changes, no grants. 20260901000000 created
-- `public.events` with the four FK/tenancy indexes every table gets
-- (`events_organisation_id_idx` and friends); none of them can serve an
-- ORDERED page, which is what this file is for.
--
-- ===========================================================================
-- THE SHAPE, AND WHY EVERY PART OF IT IS LOAD-BEARING
-- ===========================================================================
-- FOLLOW-UPS.md § "Opened by Task 3" (Phase 2) fixes the shape for every list
-- in the product, and 20260829000000 applied it to artists, agencies and
-- venues:
--
--   create index <table>_org_<column>_id_live_idx
--     on public.<table> (organisation_id, <sort column>, id)
--     include (owner_user_id)
--     where deleted_at is null;
--
--   * organisation_id LEADING, because lib/list/query.ts always pins it by
--     equality (clause 1 of that file's header) and that is what makes the
--     index reachable at all;
--   * id as the last key column, because keyset pagination compares
--     `(sort column, id)` against the previous page's last row and the
--     tie-break has to be in the index;
--   * include (owner_user_id), because the SELECT policy's record-scope term
--     (20260901011000) reads that column for a Standard User or Read Only, and
--     without it every candidate row costs a heap fetch;
--   * the partial predicate, because lib/list/query.ts always writes
--     `deleted_at is null` (RLS deliberately does not -- Phase 2 Task 2 § 4.1)
--     and a partial index is both smaller and the only one the plan can use.
--
-- ASCENDING ONLY. `organisation_id` is pinned by equality and a btree scans
-- backwards, so one index serves "earliest first" and "latest first" alike.
--
-- ===========================================================================
-- MEASURED, ON 24,998 LIVE + 252 SOFT-DELETED EVENTS IN ONE TENANT
-- ===========================================================================
-- As the `authenticated` role with a real `request.jwt.claims` set, on the
-- default page (`order by starts_at desc, id desc limit 26`), after `analyze`.
-- Full plans are in .superpowers/sdd/phase-3-events/task-3-report.md § 2.
--
--   BEFORE, standard_user (record-scoped, 12,373 rows visible):
--     Limit -> Sort (top-N heapsort) -> Seq Scan on events, 12,891 rows
--     removed by filter.        9.952 ms, shared hit=478
--   AFTER:
--     Limit -> Index Scan Backward using events_org_starts_at_id_live_idx
--     Index Cond: (organisation_id = ...)   Heap Fetches: 0
--                               0.093 ms, shared hit=8
--
-- The SHAPE is the finding and it matches Phase 2's contacts result exactly:
-- an unindexed list page is a sequential scan plus a top-N sort of every live
-- row in the tenant, so its cost is O(tenant) per page click -- fine in every
-- fixture, linear in a customer's success. Phase 3 Task 2 § 2.5 recorded the
-- same plan shape on an 11-row fixture and predicted this; the prediction held.
--
-- `include (owner_user_id)` is what produces `Heap Fetches: 0` above. Dropped
-- from the definition and re-measured on the same rows, the standard_user page
-- becomes an Index Scan with a heap fetch per candidate row -- see the report.

create index events_org_starts_at_id_live_idx
  on public.events (organisation_id, starts_at, id)
  include (owner_user_id)
  where deleted_at is null;

create index events_org_name_id_live_idx
  on public.events (organisation_id, name, id)
  include (owner_user_id)
  where deleted_at is null;

create index events_org_updated_at_id_live_idx
  on public.events (organisation_id, updated_at, id)
  include (owner_user_id)
  where deleted_at is null;

-- The restore view. One sort -- "most recently deleted first" is the only
-- ordering a restore queue is ever read in, and every sort in a list's
-- allowlist costs an index.
--
-- `notNull: true` on that sort option is true OF THE ROWS THIS INDEX COVERS
-- rather than of the column, because the predicate below constrains it. Said
-- out loud here and in lib/crm/events-list.ts because keyset pagination over a
-- genuinely nullable column silently drops a contiguous band of rows.
create index events_org_deleted_at_id_idx
  on public.events (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

comment on index public.events_org_starts_at_id_live_idx is
  'Keyset pagination for the events list, DATE sort -- the default. lib/crm/events-list.ts names this index in `backedBy` and lib/list/spec.ts makes that field required, so the sort is not allowed to exist without it. events.starts_at is NOT NULL by declaration (20260901000000 states the reason: a nullable sort column makes keyset ordering non-total), which is what lets this one be a live-partial index rather than a partial-on-the-sort-column too. supabase/tests/rls_phase3_events.sql § EX asserts this name still exists and still points at public.events.';
comment on index public.events_org_name_id_live_idx is
  'Keyset pagination for the events list, name sort. Mirrors venues_org_name_id_live_idx; see 20260828180000 for the measurements behind the shape.';
comment on index public.events_org_updated_at_id_live_idx is
  'Keyset pagination for the events list, updated sort. updated_at is maintained by the `set_updated_at` trigger (20260901000000) and is not client-writable, which is what makes it safe to order by.';
comment on index public.events_org_deleted_at_id_idx is
  'Keyset pagination for the deleted-events (restore) view, which is a separate route from the list. The partial predicate is what makes deleted_at NOT NULL for every row this index covers -- the sort option''s `notNull: true` is true of the indexed set, not of the column. See artists_org_deleted_at_id_idx.';

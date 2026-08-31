-- Phase 4 (Operations), Task 3: the list-surface indexes for tasks, meetings
-- and notes.
--
-- ADDITIVE ONLY. `create index` statements and their comments; no existing
-- migration is edited, no policy changes, no grants. 20260902000000 created
-- the three tables with the FK/tenancy indexes every table gets
-- (`tasks_organisation_id_idx` and friends); none of them can serve an ORDERED
-- page, which is what this file is for.
--
-- ===========================================================================
-- THE SHAPE, AND WHY EVERY PART IS LOAD-BEARING (20260901020000's argument)
-- ===========================================================================
--   create index <table>_org_<column>_id_live_idx
--     on public.<table> (organisation_id, <sort column>, id)
--     include (owner_user_id)
--     where deleted_at is null;
--
--   * organisation_id LEADING, because lib/list/query.ts always pins it by
--     equality and that is what makes the index reachable;
--   * id as the last key column, because keyset pagination compares
--     `(sort column, id)` against the previous page's last row;
--   * include (owner_user_id) for shape consistency with every other list
--     index in the product (the record-scope SELECT term reads it) -- kept for
--     SHAPE, not a measured saving on these multi-column selects, exactly as
--     20260901020000's header records for events;
--   * the partial `where deleted_at is null`, because lib/list/query.ts always
--     writes that predicate (RLS deliberately does not) and a partial index is
--     both smaller and the only one the plan can use.
--
-- ASCENDING ONLY. organisation_id is pinned by equality and a btree scans
-- backwards, so one index serves "earliest/oldest first" and "latest/newest
-- first" alike.
--
-- ===========================================================================
-- MEASURED, ON ~50,000 LIVE + ~500 SOFT-DELETED ROWS IN ONE TENANT
-- ===========================================================================
-- Seeded transactionally into org 37dd4e6d (Org A) on the local stack, ANALYZE,
-- then the default-sort page (`order by <default> desc, id desc limit 26`) each
-- side of `create index`. Full plans in task-3-report.md section 2. Measured as
-- postgres -- the RLS record-scope quals sit on top as hashed SubPlans exactly
-- as in events' 20260901020000 measurement, and the finding is the PLAN SHAPE,
-- which they do not change:
--
--   tasks    created_at desc   BEFORE  Seq Scan + top-N heapsort of 49,500
--                                      rows, shared hit=793, 18.021 ms
--                              AFTER   Index Scan Backward using
--                                      tasks_org_created_at_id_live_idx,
--                                      shared hit=1 read=3, 0.048 ms
--   meetings starts_at desc    BEFORE  Seq Scan + top-N, hit=834, 15.077 ms
--                              AFTER   Index Scan Backward, hit=1 read=3, 0.049 ms
--   notes    created_at desc   AFTER   Index Scan Backward, hit=1 read=3, 0.086 ms
--
-- The cost of the unindexed page is O(tenant) per click -- fine in every
-- fixture, linear in a customer's success. Same finding as contacts (Phase 2)
-- and events (Phase 3).
--
-- ===========================================================================
-- THE NON-DEFAULT SORTS FOLLOW THE PROVEN SHAPE, NOT A SEPARATE MEASUREMENT
-- ===========================================================================
-- `title` (tasks, meetings) and `updated_at` (all three) are the same
-- (organisation_id, <col>, id) live-partial shape over the same tables, so the
-- plan is the events `name`/`updated` result one table along; 20260901020000
-- measured those and this file does not re-measure an identical shape (rule 13
-- -- labelled inference, not a claimed run). Every one is `NOT NULL` on the
-- table (title has a non-blank CHECK, updated_at/created_at/starts_at are NOT
-- NULL by declaration), which is what lets `backedBy` in lib/crm/tasks-list.ts
-- and notes-list.ts name it (rule 9).
--
-- ===========================================================================
-- NO NEW INDEX FOR THE RELATED-PANEL REVERSE READS -- CONFIRMED, NOT ASSUMED
-- ===========================================================================
-- The related panel reads "the tasks/notes/documents linked to THIS entity"
-- through `<x>_links_target_idx (entity_type, entity_id, organisation_id)` from
-- 20260902002000. Measured on 50,000 link rows with 8 pointing at one target:
--   Index Scan using task_links_target_idx, Index Cond on all three leading
--   columns, 8 rows, shared hit=4, 0.072 ms.
-- The reverse lookup is bounded to a page's worth of parent ids before the
-- parent table is touched, so the parent read is an `id in (...)` over the PK.
-- No new index is owed here.

create index tasks_org_created_at_id_live_idx
  on public.tasks (organisation_id, created_at, id)
  include (owner_user_id)
  where deleted_at is null;

create index tasks_org_title_id_live_idx
  on public.tasks (organisation_id, title, id)
  include (owner_user_id)
  where deleted_at is null;

create index tasks_org_updated_at_id_live_idx
  on public.tasks (organisation_id, updated_at, id)
  include (owner_user_id)
  where deleted_at is null;

create index meetings_org_starts_at_id_live_idx
  on public.meetings (organisation_id, starts_at, id)
  include (owner_user_id)
  where deleted_at is null;

create index meetings_org_title_id_live_idx
  on public.meetings (organisation_id, title, id)
  include (owner_user_id)
  where deleted_at is null;

create index meetings_org_updated_at_id_live_idx
  on public.meetings (organisation_id, updated_at, id)
  include (owner_user_id)
  where deleted_at is null;

create index notes_org_created_at_id_live_idx
  on public.notes (organisation_id, created_at, id)
  include (owner_user_id)
  where deleted_at is null;

create index notes_org_updated_at_id_live_idx
  on public.notes (organisation_id, updated_at, id)
  include (owner_user_id)
  where deleted_at is null;

-- The restore views. One sort each -- "most recently deleted first" is the only
-- ordering a restore queue is read in. `notNull: true` on that sort is true OF
-- THE ROWS THIS INDEX COVERS (the predicate below constrains it), not of the
-- column, exactly as events_org_deleted_at_id_idx.
create index tasks_org_deleted_at_id_idx
  on public.tasks (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

create index meetings_org_deleted_at_id_idx
  on public.meetings (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

create index notes_org_deleted_at_id_idx
  on public.notes (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

comment on index public.tasks_org_created_at_id_live_idx is
  'Keyset pagination for the tasks list, the DEFAULT created_at sort. lib/crm/tasks-list.ts names this in backedBy and lib/list/spec.ts makes that required, so the sort cannot exist without it. tasks.due_at is deliberately NOT a sort (nullable -- rule 9); created_at is NOT NULL. Measured 18.021 ms to 0.048 ms on 50k rows (task-3-report.md section 2).';
comment on index public.meetings_org_starts_at_id_live_idx is
  'Keyset pagination for the meetings list, the DEFAULT starts_at sort. meetings.starts_at is NOT NULL (20260902000000 -- it is the sort column). Measured 15.077 ms to 0.049 ms on 50k rows.';
comment on index public.notes_org_created_at_id_live_idx is
  'Keyset pagination for the notes list, the DEFAULT created_at sort. Notes have no name/title column; body is the search column, created_at the sort. Measured to 0.086 ms on 50k rows.';

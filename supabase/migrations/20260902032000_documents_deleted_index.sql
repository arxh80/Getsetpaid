-- Phase 4 Task 6: the documents RESTORE-view index.
--
-- Task 3's 20260902020000 created documents_org_created_at_id_live_idx (the
-- LIVE default-sort index, partial on `deleted_at is null`), because the
-- related panel's read-only documents surface needed it. It did NOT create a
-- deleted-scope index, because Task 3 shipped no /documents/deleted route.
--
-- Task 6 ships that route (app/(app)/[orgSlug]/documents/deleted/page.tsx), and
-- its DOCUMENT_DELETED_LIST sorts by `deleted_at` over rows where
-- `deleted_at is not null`. The live index is partial on the OPPOSITE
-- predicate and cannot serve those rows, so rule 9 (a sort's `backedBy` must
-- name a real index of the (organisation_id, <sort>, id) shape) requires this
-- one. It is the exact shape of tasks_org_deleted_at_id_idx /
-- meetings_org_deleted_at_id_idx / notes_org_deleted_at_id_idx from
-- 20260902020000 and events_org_deleted_at_id_idx before them — brought one
-- task later only because the route it backs is one task later.
--
-- Additive: a new migration, never an edit to the shipped 20260902020000
-- (rule 1). `notNull: true` on the deleted sort is true OF THE ROWS this
-- partial index covers, not of the nullable column. Shape inherited from the
-- three measured live indexes above; there are no soft-deleted document rows to
-- re-measure against.
create index documents_org_deleted_at_id_idx
  on public.documents (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

comment on index public.documents_org_deleted_at_id_idx is
  'Keyset pagination for the /documents/deleted restore queue, the deleted_at sort. Partial on deleted_at is not null, so lib/crm/documents-list.ts''s DOCUMENT_DELETED_LIST can name it in backedBy (rule 9). Same (organisation_id, deleted_at, id) include(owner_user_id) shape as tasks/meetings/notes/events restore indexes.';

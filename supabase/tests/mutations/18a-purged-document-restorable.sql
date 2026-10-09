-- PHASE 8 TASK 9a MUTANT 18a-purged-document-restorable (Q185, founder 2026-09-30)
-- guard:  public.documents CHECK documents_purged_implies_deleted
-- change: the CHECK is dropped, so a purged document's deleted_at can be
--         cleared -- the database no longer refuses its restore
-- Applied after a fresh reset by run-mutation.sh and removed by the next
-- reset. Never a migration.
alter table public.documents drop constraint documents_purged_implies_deleted;

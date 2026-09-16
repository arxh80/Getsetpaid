-- Phase 8 Task 1, fix 1: attach the house `set_updated_at` trigger to
-- public.legal_documents.
--
-- FOUND BY THE SAME TRIPWIRE AS 20260909030000. rls_phase2_crm.sql § L5
-- asserts that every table in `public` carrying an `updated_at` column also
-- carries a trigger named exactly `set_updated_at`. 20260922000000 gave
-- legal_documents an updated_at column and stamped it from its own guard
-- instead, so § L5 counted 1 violation instead of 0. As that migration's
-- header argues, the fix is to follow the convention, not to give the guard an
-- exception list.
--
-- ORDERING IS LOAD-BEARING, AND IT IS THE RIGHT WAY ROUND. Postgres fires
-- BEFORE ROW triggers in name order: `legal_documents_guard` ('l') runs before
-- `set_updated_at` ('s'). So the immutability guard compares the row the
-- STATEMENT asked for -- a client-supplied updated_at on a published row is
-- still refused -- and only afterwards does set_updated_at stamp now(). The
-- reverse order would make the guard see every supersede and every counsel
-- review as a change to a frozen column and refuse them all;
-- rls_phase8_legal.sql § LP (a real publish, which supersedes) and § LR (a
-- review of a published version) are what would go red.
--
-- BEHAVIOURAL CHANGE, stated: a published row's updated_at now moves when it
-- is superseded or reviewed (it previously stayed at its last draft edit). No
-- reader uses it for anything but "last changed".
--
-- ADDITIVE. No previously applied migration is edited.

create trigger set_updated_at
  before update on public.legal_documents
  for each row execute function private.set_updated_at();

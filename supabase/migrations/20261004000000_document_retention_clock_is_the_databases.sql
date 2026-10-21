-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 1 -- REVIEW FINDING C1.
--
-- THE DOCUMENT RETENTION CLOCK WAS WRITABLE BY THE TENANT, AND THE RECORD OF
-- THE PURGE WAS FORGEABLE.
--
-- 20261003002000 made public.documents.deleted_at the clock the document
-- sweep and the object manifest read, and added public.documents
-- .bytes_purged_at as the record that the sweep ran. `authenticated` held
-- TABLE-WIDE INSERT and UPDATE on public.documents -- every column -- and the
-- only BEFORE UPDATE trigger on the table guards scan_status alone. Measured
-- by the reviewer and reproduced here before this file was written, as an
-- aal2 Owner of their own workspace:
--
--   update public.documents set deleted_at = now() - interval '8 years' ...   UPDATE 1
--   update public.documents set bytes_purged_at = now() - interval '1 day' .. UPDATE 1
--   update public.documents set storage_key = '<org>/elsewhere' ...           UPDATE 1
--
--   * the first names a FINANCIAL-class (seven-year) document's object in the
--     next manifest, seconds after upload; the next hourly run deletes the
--     file for good and the only record is a counts-only audit row;
--   * the second removes the document from every future sweep: the bytes stay
--     in the bucket and keep counting toward the quota, while the column
--     asserts a lawful deletion that never happened;
--   * the third turns a live document's object into an ORPHAN (no row names
--     it any more), which the manifest's orphan half deletes a day later --
--     and re-points an expired row at whatever key the tenant chose inside
--     its own prefix.
--
-- This is progress.md standing lessons 6 and 7 verbatim: enforce at the
-- chokepoint every writer passes, and attribution must be non-forgeable BY
-- CONSTRUCTION. Task 6 did not create the deleted_at grant; it is what made
-- it destructive.
--
-- THREE LAYERS, each of which holds alone:
--
--   1. COLUMN-LEVEL GRANTS. `authenticated` keeps INSERT on exactly the nine
--      columns lib/crm/documents.ts sends and UPDATE on exactly the three it
--      writes (scan_status, scanned_at, deleted_at). bytes_purged_at and
--      storage_key are not in the UPDATE grant and deleted_at and
--      bytes_purged_at are not in the INSERT grant, so a statement that so
--      much as NAMES one is 42501 before any trigger runs. A column-level
--      grant does NOT revoke a prior table-level one (the Q125 lesson,
--      20260919000000), so the revoke is issued first and the net effect is
--      asserted on the live catalogue by rls_phase8_retention.sql § RK.
--
--   2. A BEFORE INSERT OR UPDATE TRIGGER, the house shape
--      (private.incident_alert_resolution_guard()). For a session writer --
--      any role RLS applies to, which is an OPEN list: a client role a later
--      phase adds arrives guarded by omission -- deleted_at going from null
--      to a value is OVERWRITTEN with pg_catalog.now(), so the ordinary
--      "Delete" press keeps working with whatever the app server's clock
--      said and a raw PATCH naming a date eight years ago is corrected
--      instead of obeyed: a person says THAT they deleted a document, never
--      WHEN. Re-dating an already-deleted document is refused. Any client
--      write to bytes_purged_at is refused; the sweep is SECURITY DEFINER,
--      owned by the table's owner, and is unaffected. storage_key is
--      immutable after insert FOR EVERY WRITER, `postgres` included: nothing
--      in the product rewrites one, and the manifest's promise that "a bug in
--      the runner cannot aim a delete at a prefix the database did not name"
--      should be true of a bug in a migration too.
--
--   3. A CHECK: a purged document is a deleted document. It closes the two
--      states nothing should be able to reach from either side -- RESTORING a
--      document whose file the policy already destroyed (a live row with no
--      bytes behind it), and STAMPING a live document purged (the review's
--      mutation MD, which removed it from the sweep for ever and reddened
--      nothing).
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE GRANTS. Revoke first: a column-level grant beside a table-level one
--    narrows nothing.
-- ---------------------------------------------------------------------------

revoke insert, update on public.documents from authenticated;
revoke insert, update on public.documents from anon;

grant insert (id, organisation_id, owner_user_id, filename, storage_key,
              mime_type, size_bytes, scan_status, scanned_at)
   on public.documents to authenticated;

grant update (scan_status, scanned_at, deleted_at)
   on public.documents to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE CHECK.
-- ---------------------------------------------------------------------------

alter table public.documents
  add constraint documents_purged_implies_deleted
  check (bytes_purged_at is null or deleted_at is not null);

comment on constraint documents_purged_implies_deleted on public.documents is
  'A document whose bytes were purged under the retention policy is a DELETED document, for every writer (Phase 8 Task 6 fix round 1, C1/I4). Closes two states from both sides: restoring a document whose file the policy already destroyed, which would leave a live row with nothing behind it, and stamping a LIVE document purged, which removed it from the sweep for ever and -- as the review''s mutation MD -- reddened nothing.';


-- ---------------------------------------------------------------------------
-- 3. THE TRIGGER.
--
--    SECURITY INVOKER ON PURPOSE. pg_catalog.row_security_active() inside a
--    SECURITY DEFINER function answers for the function's OWNER (Task 3 fix
--    round 1, finding (i): a guard written that way was dead code). As an
--    invoker it answers for the session that is actually writing: true for
--    `authenticated`, `anon` and any role a later phase adds without
--    BYPASSRLS; false for the table's owner, which is what
--    private.sweep_document_bytes() runs as.
-- ---------------------------------------------------------------------------

create or replace function private.guard_document_retention_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- FOR EVERY WRITER. Nothing in the product rewrites a storage key, and the
  -- key is what the retention runner is handed to delete.
  if tg_op = 'UPDATE' and new.storage_key is distinct from old.storage_key then
    raise exception 'documents.storage_key is immutable after insert'
      using errcode = '42501', hint = 'document_storage_key_is_immutable';
  end if;

  if not pg_catalog.row_security_active('public.documents'::pg_catalog.regclass) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.deleted_at is not null or new.bytes_purged_at is not null then
      raise exception 'documents: a document is created live and unpurged'
        using errcode = '42501', hint = 'document_is_born_live';
    end if;
    return new;
  end if;

  if new.bytes_purged_at is distinct from old.bytes_purged_at then
    raise exception 'documents.bytes_purged_at is written by the retention sweep alone'
      using errcode = '42501', hint = 'document_bytes_purged_at_is_the_sweeps';
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    if old.deleted_at is null then
      -- THE CLOCK IS THE DATABASE'S. Overwritten rather than refused, so the
      -- ordinary press keeps working with no round trip.
      new.deleted_at := pg_catalog.now();
    elsif new.deleted_at is not null then
      raise exception 'documents.deleted_at cannot be re-dated; restore the document and delete it again'
        using errcode = '42501', hint = 'document_deleted_at_is_the_databases_clock';
    end if;
    -- old not null -> new null is a RESTORE, and the CHECK above is what
    -- refuses it for a document whose bytes are already gone.
  end if;

  return new;
end;
$$;

comment on function private.guard_document_retention_columns() is
  'THE DOCUMENT RETENTION CLOCK IS THE DATABASE''S (Phase 8 Task 6 fix round 1, review finding C1). BEFORE INSERT OR UPDATE on public.documents. storage_key is immutable after insert FOR EVERY WRITER. For a session writer (any role RLS applies to -- an open list, so a client role added later arrives guarded): a document is born live and unpurged; deleted_at going from null to a value is OVERWRITTEN with now(), so the Delete press keeps working and a PATCH naming a date eight years ago is corrected rather than obeyed; re-dating an already-deleted document is refused; bytes_purged_at is not writable at all. SECURITY INVOKER on purpose: row_security_active() inside a definer answers for the owner. private.sweep_document_bytes() runs as the table''s owner and is unaffected. The column-level grants in the same migration make most of this unreachable from a client; the trigger is what holds if a later grant widens them, and rls_phase8_retention.sql § RK18/RK19 ask it directly with the grant switched back on.';

revoke all on function private.guard_document_retention_columns()
  from public, anon, authenticated, service_role;

create trigger guard_retention_columns
  before insert or update on public.documents
  for each row execute function private.guard_document_retention_columns();

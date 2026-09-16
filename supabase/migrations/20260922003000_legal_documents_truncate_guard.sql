-- ===========================================================================
-- Phase 8 Task 1, fix round 1 (review finding M7): TRUNCATE is refused too.
--
-- 20260922000000's immutability guard is a BEFORE ROW trigger on INSERT,
-- UPDATE and DELETE. A row-level DELETE trigger does not fire for TRUNCATE,
-- so `truncate public.legal_documents` as `postgres` emptied the store --
-- every published version, the text a future consent points at -- with the
-- guard never consulted. Measured in review, in a rolled-back transaction.
--
-- No client role holds TRUNCATE (anon, authenticated and service_role were
-- all checked with has_table_privilege), so this was a DBA-only bypass like
-- the two escape hatches 20260922000000's header names. It is closed here
-- rather than named, because it is the one of the three that a routine
-- "reset this table" habit reaches by accident:
--
--   * `alter table ... disable trigger` and `session_replication_role =
--     replica` stay the deliberate, by-name DBA escape hatches (and the test
--     suites' tidy-ups still use the second -- a statement-level trigger is
--     an ENABLE trigger, so replica mode skips it exactly as it skips the
--     row guard);
--   * TRUNCATE is now refused for every role, `postgres` included, with the
--     same SQLSTATE as the row guard (42501).
--
-- supabase/tests/rls_phase8_legal.sql § LI asserts the refusal as postgres
-- and that the row count is unchanged afterwards.
--
-- ADDITIVE. No previously applied migration is edited; the table comment is
-- reissued so the live object names all three paths.
-- ===========================================================================

create or replace function private.legal_documents_truncate_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'legal_documents: the legal store cannot be truncated -- published versions are immutable, and a draft is deleted row by row'
    using errcode = '42501';
end;
$$;

comment on function private.legal_documents_truncate_guard() is
  'BEFORE TRUNCATE (statement level) on public.legal_documents, for EVERY role: refuses. The row-level private.legal_documents_guard() cannot see a TRUNCATE (row triggers do not fire for it), so without this the whole store -- every published version -- could be emptied past the immutability guard. Phase 8 Task 1, fix round 1 (M7).';

revoke all on function private.legal_documents_truncate_guard() from public, anon, authenticated, service_role;

create trigger legal_documents_truncate_guard
  before truncate on public.legal_documents
  for each statement execute function private.legal_documents_truncate_guard();

comment on table public.legal_documents is
  'The fifteen PRD §12 legal pages, one row per (slug, version) -- DECISIONS-QUEUE Q128. A published or superseded version is immutable for every role (private.legal_documents_guard), and the table cannot be truncated by any role (private.legal_documents_truncate_guard, since 20260922003000); the only ways past either are the deliberate DBA switches (disabling the triggers, or session_replication_role = replica). anon/authenticated read the CURRENT PUBLISHED version only (legal_documents_select_current_published) and only the columns granted to them; the reviewer name and attribution uuids are outside that grant. No client role can write: every change goes through the five guarded, audited superuser RPCs in 20260922000000. counsel_reviewed_at null means the public page shows the draft-pending-legal-review notice.';

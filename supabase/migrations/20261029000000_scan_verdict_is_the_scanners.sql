-- Phase 8 final review A, finding I1: THE MALWARE VERDICT IS THE SCANNER'S.
--
-- ===========================================================================
-- THE HOLE (probed on a fresh reset at bae744f, 238 migrations)
-- ===========================================================================
-- 20261004000000:82-87 (Task 6 fix round 1) re-granted `scan_status` and
-- `scanned_at` on BOTH the INSERT and the UPDATE column grant to
-- `authenticated`, because lib/crm/documents.ts wrote the verdict through the
-- uploader's own RLS-bound client. private.guard_document_scan_status()
-- (20260902031000:187) allows pending -> terminal for every writer. So a
-- `manage_documents` member (a Manager, aal1) could, as the probe measured:
--
--   insert ... scan_status='pending'                      -> INSERT 0 1
--   update ... set scan_status='clean', scanned_at=now()  -> UPDATE 1   (forged, mid-scan)
--   update ... set scan_status='quarantined' (server)     -> ERROR 23514 "terminal and immutable (was clean, tried to set quarantined)"
--   select scan_status='clean'  (the download gate)       -> t          (the file is served)
--   insert ... scan_status='clean', scanned_at=now()      -> INSERT 0 1 (born clean, no scan at all)
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   1. GRANTS. Neither verdict column is client-writable any more: INSERT
--      keeps the seven columns the upload sends (scan_status defaults to
--      'pending'), UPDATE keeps deleted_at alone (soft-delete and restore --
--      the only client UPDATEs the product makes; neither moves a verdict).
--   2. TRIGGER, for every SESSION writer (row_security_active, so SECURITY
--      INVOKER -- Task 3 fix round 1 (i)): a document is born pending with no
--      scanned_at, and neither scan_status nor scanned_at may change. This is
--      what holds if a later grant widens the columns again (the exact way
--      the hole arrived).
--   3. THE ONLY WRITER: public.record_document_scan_verdict(), SECURITY
--      DEFINER, executable by service_role ALONE, refusing any session with
--      a person on it, and accepting only pending -> terminal on a live row.
--      The server action calls it through lib/crm/scan-verdict.ts after the
--      scanner returns.
--
-- The download gate is unchanged (it 409s anything not 'clean').
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- 1. THE GRANTS. Revoke first: a column grant beside a wider one narrows nothing.
revoke insert, update on public.documents from authenticated;
revoke insert, update on public.documents from anon;

grant insert (id, organisation_id, owner_user_id, filename, storage_key,
              mime_type, size_bytes)
   on public.documents to authenticated;

grant update (deleted_at) on public.documents to authenticated;


-- 2. THE TRIGGER.
create or replace function private.guard_document_scan_verdict()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not pg_catalog.row_security_active('public.documents'::pg_catalog.regclass) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.scan_status is distinct from 'pending' or new.scanned_at is not null then
      raise exception 'documents: a document is born pending; the verdict is the scanner''s'
        using errcode = '42501', hint = 'document_scan_verdict_is_the_scanners';
    end if;
    return new;
  end if;

  if new.scan_status is distinct from old.scan_status
     or new.scanned_at is distinct from old.scanned_at then
    raise exception 'documents.scan_status/scanned_at are written by the scanner alone'
      using errcode = '42501', hint = 'document_scan_verdict_is_the_scanners';
  end if;
  return new;
end;
$$;

comment on function private.guard_document_scan_verdict() is
  'THE MALWARE VERDICT IS THE SCANNER''S (Phase 8 final review A, I1). BEFORE INSERT OR UPDATE on public.documents. For a SESSION writer (any role RLS applies to): a document is born scan_status=pending with scanned_at null, and neither column may change afterwards. SECURITY INVOKER on purpose (row_security_active inside a definer answers for the owner). The verdict lands only through public.record_document_scan_verdict() (service_role alone), which runs as the table owner and is unaffected. The column grants make this unreachable from a client today; the trigger is what holds if a later grant widens them again, which is how the hole arrived (20261004000000 re-granted both columns).';

revoke all on function private.guard_document_scan_verdict()
  from public, anon, authenticated, service_role;

create trigger guard_scan_verdict
  before insert or update on public.documents
  for each row execute function private.guard_document_scan_verdict();


-- 3. THE ONLY WRITER.
create or replace function public.record_document_scan_verdict(
  p_organisation_id uuid,
  p_document_id     uuid,
  p_status          text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), '') not in ('service_role', 'postgres', 'none', '') then
    raise exception 'record_document_scan_verdict: the verdict is the scanner''s, never a person''s session'
      using errcode = '42501', hint = 'document_scan_verdict_is_the_scanners';
  end if;

  if p_status is null or p_status not in ('clean', 'quarantined', 'error') then
    raise exception 'record_document_scan_verdict: % is not a terminal verdict', p_status
      using errcode = '22023';
  end if;

  update public.documents
     set scan_status = p_status,
         scanned_at  = pg_catalog.now()
   where id = p_document_id
     and organisation_id = p_organisation_id
     and scan_status = 'pending'
     and deleted_at is null;
  get diagnostics v_rows = row_count;

  if v_rows <> 1 then
    raise exception 'record_document_scan_verdict: no live pending document % in organisation %',
      p_document_id, p_organisation_id
      using errcode = 'P0002', hint = 'document_not_pending';
  end if;
end;
$$;

comment on function public.record_document_scan_verdict(uuid, uuid, text) is
  'THE ONLY WRITER OF A DOCUMENT''S MALWARE VERDICT (Phase 8 final review A, I1). SECURITY DEFINER, owned by postgres, executable by service_role ALONE, and refuses any session with a person on it (auth.uid() not null, or a role other than service_role/postgres). Accepts only pending -> clean/quarantined/error on a LIVE document of the named organisation, stamping scanned_at from the database clock; anything else raises P0002 (document_not_pending), so a second verdict, a forged id or a deleted row is refused rather than silently a no-op. Called by lib/crm/scan-verdict.ts after the scanner returns. Writes no audit row itself: the upload action records document_uploaded / document_quarantined under the uploader''s actor, and private.audit_crm_change() skips sessionless writes by design.';

revoke all on function public.record_document_scan_verdict(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_document_scan_verdict(uuid, uuid, text) to service_role;

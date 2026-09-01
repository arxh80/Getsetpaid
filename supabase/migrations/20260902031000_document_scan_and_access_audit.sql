-- Phase 4 (Operations), Task 5: the document-action audit helper and the
-- scan-status transition guard. The download-authorisation half of the
-- file-security pipeline that Task 4 opened.
--
-- ===========================================================================
-- WHY AN AUDIT HELPER LIVES HERE AND NOT IN THE UPLOAD ACTION'S OWN MIGRATION
-- ===========================================================================
-- SECURITY.md § 6/§ 7 require every upload, download and soft-delete of a
-- document to be audited. The sole write path into public.audit_events is
-- private.log_audit_event (20260826154304), whose EXECUTE is granted to NO
-- client role -- it is called only by other SECURITY DEFINER functions. So
-- there is no client-callable audit RPC in the schema, and Task 4 (whose
-- binding rule allowed only 20260902030000) could not ship one. Task 4's
-- upload action therefore carried a MARKED audit seam; this migration ships the
-- helper that seam names, and the same commit wires the upload/quarantine audit
-- to it (lib/crm/documents.ts).
--
-- ===========================================================================
-- APP-SIDE AUDIT, NOT A TRIGGER -- AND WHY THAT DIFFERS FROM PHASE 2
-- ===========================================================================
-- The Phase 2 hard-delete/merge audit is a TRIGGER (20260828141000), because
-- `grant ... to authenticated` plus the anon key that ships in the browser
-- makes `DELETE /rest/v1/contact_companies?id=eq...` reachable WITHOUT touching
-- the Next.js app. For those tables the database is the only chokepoint, so the
-- audit has to live in the database.
--
-- A document's BYTES have no such second path. storage.objects for the
-- `documents` bucket is deny-all fenced to every client role (20260902030000);
-- the only principal that can read or write a `documents` object is
-- service_role, on the server, through lib/supabase/storage.ts. There is no
-- PostgREST-reachable "download this file" endpoint to bypass -- an upload is a
-- Server Action and a download is a Route Handler, and both run the audit
-- before they touch Storage. So for documents the APPLICATION is the only path
-- in and out, and an app-side audit is sufficient and correct. This split is
-- recorded in SECURITY.md § 7.
--
-- The metadata ROW is client-reachable (documents has grants to authenticated),
-- but a metadata write is not the audited event here: the sensitive action is
-- the movement of bytes, and that is server-only. The scan-status transition
-- guard below is the metadata-side defence in depth.
--
-- ADDITIVE. Two new functions, one new trigger. No table or policy changes.

-- ===========================================================================
-- private.audit_document_action(p_action, p_org, p_document_id)
--
-- The real audit writer: a SECURITY DEFINER wrapper over log_audit_event with
-- target_type='document'. Granted to NO client role, exactly like
-- log_audit_event itself and private.audit_crm_row -- the client never calls
-- this directly, it calls the public thin RPC below, which calls this. Keeping
-- the writer in `private` means the only client-reachable surface is the one
-- with the membership/existence guards on it.
--
-- p_action is validated against the closed set so a caller (even the thin RPC)
-- cannot invent an action string; an unknown action is a 22023, not an audit
-- row that pollutes the log with a typo'd action name.
-- ===========================================================================
create or replace function private.audit_document_action(
  p_action      text,
  p_org         uuid,
  p_document_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_action not in (
    'document_uploaded', 'document_downloaded',
    'document_deleted',  'document_quarantined'
  ) then
    raise exception 'audit_document_action: unknown action %', p_action
      using errcode = '22023';
  end if;

  -- log_audit_event forces actor_user_id = auth.uid() and raises 28000 on a
  -- null actor, so an unattributable document audit row cannot be written.
  v_id := private.log_audit_event(
    p_action          => p_action,
    p_target_type     => 'document',
    p_organisation_id => p_org,
    p_target_id       => p_document_id
  );
  return v_id;
end;
$$;

comment on function private.audit_document_action(text, uuid, uuid) is
  'Audit writer for the three document byte-actions (upload/download/soft-delete) and the quarantine verdict, over private.log_audit_event with target_type=''document''. Granted to NO client role -- callers reach it only through the public thin RPC of the same name, which carries the membership and document-in-org guards. Identifiers only (org, document id): no filename, no bytes -- audit_events is superuser-readable and CLAUDE.md § Superuser dashboard keeps tenant record content off that surface. p_action is validated against the closed set (22023 on anything else).';

revoke all on function private.audit_document_action(text, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- public.audit_document_action(p_action, p_org, p_document_id)
--
-- The THIN RPC the server actions call via supabase.rpc('audit_document_action').
-- PostgREST only exposes the `public` schema, so the client-facing entrypoint
-- has to live here; it is SECURITY DEFINER so it can call the private writer
-- (which is granted to nobody), and it is the boundary that decides whether the
-- caller may ask for an audit row at all.
--
-- WHY GUARDED, NOT BARE. This RPC is reachable by any authenticated caller with
-- the anon key (the same surface every RPC has). log_audit_event already pins
-- the actor to auth.uid(), so a caller can only ever forge rows attributed to
-- THEMSELVES -- but an unguarded helper would still let them mint
-- "document_downloaded" rows for arbitrary orgs and document ids they never
-- touched, polluting the one append-only log the superuser dashboard reads. Two
-- cheap guards confine that to nothing worth doing:
--   1. p_org must be an org the caller can view (view_crm) -- a forged row can
--      only ever name an org they are already a member of.
--   2. p_document_id must be a real document of p_org -- so the row cannot name
--      a document that is not there or belongs elsewhere.
-- On the legitimate path both hold by construction: the upload/download/delete
-- actions have already loaded or written the document through the caller's own
-- RLS-bound client, which requires exactly this membership. A failure here is a
-- forged call, and it fails closed (42501).
-- ===========================================================================
create or replace function public.audit_document_action(
  p_action      text,
  p_org         uuid,
  p_document_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_org is null or p_org not in (
    select private.permitted_organisations('view_crm')
  ) then
    raise exception 'audit_document_action: caller cannot view organisation %', p_org
      using errcode = '42501';
  end if;

  if p_document_id is null or not exists (
    select 1 from public.documents
     where id = p_document_id and organisation_id = p_org
  ) then
    raise exception 'audit_document_action: no document % in organisation %',
      p_document_id, p_org
      using errcode = '42501';
  end if;

  return private.audit_document_action(p_action, p_org, p_document_id);
end;
$$;

comment on function public.audit_document_action(text, uuid, uuid) is
  'Client-callable thin RPC (via supabase.rpc) that records a document byte-action audit row. SECURITY DEFINER so it can reach the private writer, but guarded: the caller must hold view_crm in p_org AND p_document_id must be a real document of p_org, so a forged call cannot mint audit rows for orgs or documents the caller has no relationship with (the actor is always forced to auth.uid() by log_audit_event). The upload action writes document_uploaded / document_quarantined here; the download Route Handler writes document_downloaded BEFORE it issues the signed URL; deleteDocumentAction writes document_deleted. See SECURITY.md § 7.';

revoke all on function public.audit_document_action(text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.audit_document_action(text, uuid, uuid) to authenticated;

-- ===========================================================================
-- The scan-status transition guard.
--
-- The real control on scan_status is that ONLY the server ever sets it: the
-- upload action moves a row pending -> {clean,quarantined,error} exactly once,
-- through the caller's RLS-bound client, and nothing else writes the column.
-- But documents carries an UPDATE grant and an UPDATE policy on manage_documents
-- (20260902011000) that does not restrict WHICH columns move, so a manager could
-- PATCH `scan_status` straight from 'quarantined' to 'clean' over PostgREST and
-- un-quarantine a file the download gate would then hand out. This trigger makes
-- a terminal scan_status IMMUTABLE: once a row has a verdict it cannot be moved
-- to another verdict or back to 'pending'. Defence in depth, not the primary
-- control -- there is no legitimate re-scan path at MVP (a stuck 'error' row's
-- re-scan is a FOLLOW-UP, Q42), so terminal-means-final is exactly right today.
--
-- pending -> terminal is allowed (the upload write). clean -> clean is allowed
-- (the soft-delete and restore UPDATEs move deleted_at, not scan_status).
-- ===========================================================================
create or replace function private.guard_document_scan_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.scan_status in ('clean', 'quarantined', 'error')
     and new.scan_status is distinct from old.scan_status then
    raise exception
      'documents.scan_status is terminal and immutable (was %, tried to set %)',
      old.scan_status, new.scan_status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function private.guard_document_scan_status() is
  'BEFORE UPDATE guard on public.documents: refuses any change of scan_status once it is terminal (clean/quarantined/error), so a stray PATCH cannot un-quarantine a file or roll a verdict back to pending. Raises 23514 (check_violation) to read like the constraint it is. Allows pending->terminal (the upload write) and same-value UPDATEs (the soft-delete/restore paths, which move deleted_at). Defence in depth: the primary control is that only the server sets scan_status at all. No legitimate re-scan path exists at MVP (Q42, FOLLOW-UPS.md); terminal-means-final until one is built.';

revoke all on function private.guard_document_scan_status()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_scan_status on public.documents;
create trigger guard_scan_status
  before update on public.documents
  for each row
  execute function private.guard_document_scan_status();

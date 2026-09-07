-- Phase 4 (Operations), Task 1b: public.documents and the DORMANT
-- public.document_versions.
--
-- Same scope discipline as 20260902000000: TABLES, CONSTRAINTS, INDEXES,
-- GRANTS and one updated_at trigger (documents only -- document_versions has
-- no updated_at). NO policies, NO helper functions, NO permission keys. RLS
-- enabled on both at the bottom, zero policies -- the D4/D5/D11b interval this
-- file's sibling header describes covers these two tables too.
--
-- METADATA ONLY. The file bytes live in Supabase Storage; this table is the
-- record ABOUT a file (PRD § 6.7: "store metadata separately from file
-- content", SECURITY.md § 6). The upload/scan/download pipeline is Task 4/5 --
-- this file ships the shape those tasks write into, and nothing that writes.
--
-- ===========================================================================
-- documents
-- One uploaded file's metadata, hung off a CRM record via document_links
-- (20260902002000). PRD § 6.7 + SECURITY.md § 6.
-- ===========================================================================
create table public.documents (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id   uuid default auth.uid() references auth.users (id) on delete set null,
  -- SANITISED display name (Task 4). NEVER the storage key -- CLAUDE.md
  -- § Non-negotiable rules: "sanitised filenames (never user-supplied paths as
  -- storage keys)". The btrim CHECK rejects an all-whitespace name.
  filename        text not null check (btrim(filename) <> ''),
  -- OPAQUE, server-built: '{organisation_id}/{document_id}'. The client never
  -- supplies it. documents_storage_key_shape below makes "inside my own
  -- tenant's prefix" a database invariant, not a convention.
  storage_key     text not null,
  -- The SNIFFED content type (Task 4), not the client-declared one --
  -- SECURITY.md § 6, "not just MIME/extension checks".
  mime_type       text not null,
  -- 25 MiB cap (Q50). >= 0 rejects a negative; the upper bound is the same
  -- ceiling the upload path enforces before it ever writes a row.
  size_bytes      bigint not null check (size_bytes >= 0 and size_bytes <= 26214400),
  scan_status     text not null default 'pending'
                    check (scan_status in ('pending','clean','quarantined','error')),
  scanned_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint documents_storage_key_shape
    check (storage_key ~ ('^' || organisation_id::text || '/')),
  constraint documents_scanned_at_iff_terminal
    check ((scan_status in ('clean','quarantined','error')) = (scanned_at is not null))
);

-- The composite-FK target for document_links and document_versions.
alter table public.documents
  add constraint documents_id_org_unique unique (id, organisation_id);

-- One storage key can back exactly one document.
create unique index documents_storage_key_unique on public.documents (storage_key);

comment on table public.documents is
  'One uploaded file''s METADATA (PRD § 6.7, SECURITY.md § 6). The bytes live in Supabase Storage; this row is the record about them. Tenant-private; never joined into a network discovery path. Soft-deleted, never hard-deleted, and there is no DELETE grant. scan_status starts ''pending''; the download path (Task 5) refuses a signed URL for anything but ''clean''.';

comment on constraint documents_storage_key_shape on public.documents is
  'Makes "a document''s storage key is inside its own tenant''s prefix" a DATABASE invariant, not a convention: the key must begin with the org id followed by a slash, so even a bug in buildStorageKey() (Task 4) that produced another org''s prefix is a 23514 rather than a cross-tenant file. schema_invariants.sql § A plants a cross-tenant key and asserts this refuses it; file_access_phase4.sql (Task 5) asserts it again from the pipeline side.';

comment on constraint documents_scanned_at_iff_terminal on public.documents is
  'scanned_at is set IF AND ONLY IF the scan reached a terminal verdict (clean/quarantined/error). A ''pending'' row must have a NULL scanned_at, and a terminal row must have a non-NULL one -- so a row cannot claim it was scanned while still pending, nor claim a verdict with no timestamp. Task 4''s scanner write path sets both together.';

-- FK-covering indexes (D3) plus none else -- list indexes are Task 3's.
create index documents_organisation_id_idx on public.documents (organisation_id);
create index documents_owner_user_id_idx    on public.documents (owner_user_id);

drop trigger if exists set_updated_at on public.documents;
create trigger set_updated_at before update on public.documents
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- ===========================================================================
-- document_versions -- DORMANT.
--
-- PRD § 11 lists it; CLAUDE.md § Scope discipline defers file VERSIONING past
-- MVP. The table exists so no later migration is needed when versioning
-- arrives (Release 1.1); it ships with NO write path, NO write grant and NO
-- UI. Task 2 gives it a SELECT-only policy on view_crm. It has no updated_at
-- and therefore NO set_updated_at trigger -- rls_phase2_crm.sql L5 must not
-- expect one, and L6 does not count it.
-- ===========================================================================
create table public.document_versions (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  document_id     uuid not null,
  version_number  integer not null check (version_number >= 1),
  storage_key     text not null,
  mime_type       text not null,
  size_bytes      bigint not null check (size_bytes >= 0),
  scan_status     text not null default 'pending'
                    check (scan_status in ('pending','clean','quarantined','error')),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

alter table public.document_versions
  add constraint document_versions_document_fkey
    foreign key (document_id, organisation_id)
    references public.documents (id, organisation_id) on delete cascade;

-- One live row per (document, version_number). Partial on deleted_at is null,
-- like event_lineup_event_artist_live_unique, so a soft-deleted version never
-- blocks a re-created one.
create unique index document_versions_doc_version_unique
  on public.document_versions (document_id, version_number) where deleted_at is null;

-- FK-covering (D3) for document_versions_document_fkey's leading column.
create index document_versions_document_id_org_idx
  on public.document_versions (document_id, organisation_id);
create index document_versions_organisation_id_idx
  on public.document_versions (organisation_id);

comment on table public.document_versions is
  'DORMANT. File versioning is Release 1.1 (CLAUDE.md § Scope discipline defers it past MVP); this table exists so that phase needs no migration. NO app writes it at MVP -- there is no version write path, no "upload new version" button, and NO write grant. RLS is enabled and Task 2 gives it a SELECT-only via-documents policy. The empty table is not an omission; it is a deferred feature with its shape already set.';

comment on constraint document_versions_document_fkey on public.document_versions is
  'Tenant-scoped composite FK to the parent document. `on delete cascade` -- a version is meaningless without its document, unlike a fee (which survives its event). Points at documents_id_org_unique.';

-- ===========================================================================
-- Grants and RLS. documents gets select/insert/update like every other
-- writable entity; document_versions gets SELECT ONLY (dormant, read-only
-- forever). NO DELETE on either. RLS ON, policies in Task 2.
-- ===========================================================================
revoke all on public.documents         from public, anon, authenticated, service_role;
revoke all on public.document_versions from public, anon, authenticated, service_role;

grant select, insert, update on public.documents to authenticated;
grant select                 on public.document_versions to authenticated;

alter table public.documents         enable row level security;
alter table public.document_versions enable row level security;

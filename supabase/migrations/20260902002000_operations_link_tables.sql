-- Phase 4 (Operations), Task 1c: the four per-entity link tables --
-- task_links, meeting_links, note_links, document_links.
--
-- THE Q22 PATTERN (founder-confirmed 2026-08-30), FOUR INSTANCES. Each hangs
-- an operational object (a task, a meeting, a note, a document) off any major
-- CRM record. Structurally identical, differing only in the parent. This is
-- NOT one generic polymorphic table: a per-entity join table lets the PARENT
-- end be a tenant-scoped composite FK (which a generic table's parent_id
-- cannot be), and only the TARGET end is polymorphic.
--
-- Same scope discipline as the rest of Task 1: TABLES, CONSTRAINTS, INDEXES,
-- GRANTS, one updated_at trigger each. NO policies -- Task 2. RLS enabled at
-- the bottom, zero policies. The D4/D5/D11b interval covers these four too.
--
-- ===========================================================================
-- TWO ENDS, TWO DIFFERENT CONTROLS
-- ===========================================================================
-- (1) THE PARENT END (parent_id -> tasks/meetings/notes/documents) is a
--     TENANT-SCOPED COMPOSITE FK (parent_id, organisation_id) ->
--     parent (id, organisation_id). A plain single-column FK is the defect
--     20260828001132 proved reachable end to end; the composite form makes a
--     link claiming one tenant while pointing at another tenant's parent a
--     23503. Task 2's child policy must ALSO carry
--     `p.organisation_id = <link>.organisation_id` -- the FK and that policy
--     term are each other's ONLY backstop (schema_invariants.sql D11).
--
-- (2) THE TARGET END (entity_type, entity_id) is POLYMORPHIC and CANNOT have a
--     foreign key -- you cannot FK to a union. Its tenant-and-liveness
--     integrity is the policy's job: Task 2's write policy calls
--     private.entity_is_manageable(entity_type, entity_id, organisation_id)
--     (entity_is_visible for a read), the per-entity_type EXISTS dispatch that
--     resolves entity_id against the physical table and compares its
--     organisation_id. 20260902003000 confirms by census that the dispatch
--     already covers exactly this allowlist -- no new TARGET arm is needed.
--
-- ===========================================================================
-- THE entity_type ALLOWLIST IS THE SIX MAJOR CRM ENTITIES AND NOTHING ELSE
-- ===========================================================================
-- ('company','contact','agency','artist','venue','event'). It deliberately
-- EXCLUDES task/meeting/note/document themselves -- no link-to-link, no
-- note-attached-to-note, no document-attached-to-a-note. This is Q49. It
-- matters most on document_links: a note "attachment" (PRD § 6.6) would be a
-- document_links row targeting the note, and that is NOT built at MVP -- a
-- document attaches to a CRM record, not to another operational object. The
-- reversal, if the founder ever wants it, is one CHECK migration per table
-- (all four, or link-allowlist-matches-db.test.ts goes red) plus one dispatch
-- arm. lib/crm/links.ts's LINK_ENTITY_TYPES is the TypeScript mirror, bound by
-- that same test.
--
-- The allowlist equals the six-value set ActivitySubjectType / SUBJECT_NOUN
-- already carry, which is why neither needs widening for this phase.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- task_links
-- ---------------------------------------------------------------------------
create table public.task_links (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  parent_id       uuid not null,
  entity_type     text not null
                    check (entity_type in ('company','contact','agency','artist','venue','event')),
  entity_id       uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
alter table public.task_links
  add constraint task_links_parent_fkey
    foreign key (parent_id, organisation_id)
    references public.tasks (id, organisation_id) on delete cascade;
create unique index task_links_live_unique
  on public.task_links (parent_id, entity_type, entity_id) where deleted_at is null;
create index task_links_organisation_id_idx on public.task_links (organisation_id);
create index task_links_parent_id_org_idx   on public.task_links (parent_id, organisation_id);
create index task_links_target_idx          on public.task_links (entity_type, entity_id, organisation_id);

-- ---------------------------------------------------------------------------
-- meeting_links
-- ---------------------------------------------------------------------------
create table public.meeting_links (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  parent_id       uuid not null,
  entity_type     text not null
                    check (entity_type in ('company','contact','agency','artist','venue','event')),
  entity_id       uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
alter table public.meeting_links
  add constraint meeting_links_parent_fkey
    foreign key (parent_id, organisation_id)
    references public.meetings (id, organisation_id) on delete cascade;
create unique index meeting_links_live_unique
  on public.meeting_links (parent_id, entity_type, entity_id) where deleted_at is null;
create index meeting_links_organisation_id_idx on public.meeting_links (organisation_id);
create index meeting_links_parent_id_org_idx   on public.meeting_links (parent_id, organisation_id);
create index meeting_links_target_idx          on public.meeting_links (entity_type, entity_id, organisation_id);

-- ---------------------------------------------------------------------------
-- note_links
-- ---------------------------------------------------------------------------
create table public.note_links (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  parent_id       uuid not null,
  entity_type     text not null
                    check (entity_type in ('company','contact','agency','artist','venue','event')),
  entity_id       uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
alter table public.note_links
  add constraint note_links_parent_fkey
    foreign key (parent_id, organisation_id)
    references public.notes (id, organisation_id) on delete cascade;
create unique index note_links_live_unique
  on public.note_links (parent_id, entity_type, entity_id) where deleted_at is null;
create index note_links_organisation_id_idx on public.note_links (organisation_id);
create index note_links_parent_id_org_idx   on public.note_links (parent_id, organisation_id);
create index note_links_target_idx          on public.note_links (entity_type, entity_id, organisation_id);

-- ---------------------------------------------------------------------------
-- document_links
-- ---------------------------------------------------------------------------
create table public.document_links (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  parent_id       uuid not null,
  entity_type     text not null
                    check (entity_type in ('company','contact','agency','artist','venue','event')),
  entity_id       uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
alter table public.document_links
  add constraint document_links_parent_fkey
    foreign key (parent_id, organisation_id)
    references public.documents (id, organisation_id) on delete cascade;
create unique index document_links_live_unique
  on public.document_links (parent_id, entity_type, entity_id) where deleted_at is null;
create index document_links_organisation_id_idx on public.document_links (organisation_id);
create index document_links_parent_id_org_idx   on public.document_links (parent_id, organisation_id);
create index document_links_target_idx          on public.document_links (entity_type, entity_id, organisation_id);

-- ---------------------------------------------------------------------------
-- Comments. One per table for the composite FK (the load-bearing control), one
-- per live-unique index, and a shared explanation of the reverse-lookup index.
-- ---------------------------------------------------------------------------
comment on table public.task_links is
  'Links a task to a CRM record (Q22 pattern). parent_id is the task; (entity_type, entity_id) is the polymorphic target, allowlisted to the six major CRM entities. Tenant-private, soft-deleted, no DELETE grant. The target end has no FK -- entity_is_visible/manageable validate it in Task 2''s policies.';
comment on table public.meeting_links is
  'Links a meeting to a CRM record (Q22 pattern). A meeting_links row with entity_type=''contact'' is what puts "met with" on a contact''s timeline. Same shape and controls as task_links.';
comment on table public.note_links is
  'Links a note to a CRM record (Q22 pattern). Same shape and controls as task_links. A note is NOT itself a link target (Q49): the allowlist excludes ''note'', so there is no note-attached-to-note.';
comment on table public.document_links is
  'Links a document to a CRM record (Q22 pattern). Same shape and controls as task_links. The allowlist EXCLUDES the operational entities, so a document attaches to a CRM record and NOT to a note/task/meeting -- the "attachment" reading of PRD § 6.6 is deferred (Q49).';

comment on constraint task_links_parent_fkey on public.task_links is
  'TENANT-SCOPED COMPOSITE FK (parent_id, organisation_id) -> public.tasks (id, organisation_id). A plain single-column FK is the cross-tenant-write defect 20260828001132 closed. Task 2''s child policy must also carry p.organisation_id = task_links.organisation_id -- the FK and that term are each other''s only backstop (D11).';
comment on constraint meeting_links_parent_fkey on public.meeting_links is
  'TENANT-SCOPED COMPOSITE FK to public.meetings (id, organisation_id). See task_links_parent_fkey.';
comment on constraint note_links_parent_fkey on public.note_links is
  'TENANT-SCOPED COMPOSITE FK to public.notes (id, organisation_id). See task_links_parent_fkey.';
comment on constraint document_links_parent_fkey on public.document_links is
  'TENANT-SCOPED COMPOSITE FK to public.documents (id, organisation_id). See task_links_parent_fkey.';

comment on index public.task_links_live_unique is
  'One LIVE link per (task, entity_type, entity_id). Partial on deleted_at is null so an unlinked-then-relinked target is not blocked by the soft-deleted row -- same trap event_lineup_event_artist_live_unique avoids.';
comment on index public.meeting_links_live_unique is
  'One LIVE link per (meeting, entity_type, entity_id). Partial on deleted_at is null.';
comment on index public.note_links_live_unique is
  'One LIVE link per (note, entity_type, entity_id). Partial on deleted_at is null.';
comment on index public.document_links_live_unique is
  'One LIVE link per (document, entity_type, entity_id). Partial on deleted_at is null.';

comment on index public.task_links_target_idx is
  'REVERSE LOOKUP: "which tasks are linked to this contact/venue/event". Leads with (entity_type, entity_id) so a CRM record''s page can find every operational object hung off it. organisation_id trails as the tenant filter.';
comment on index public.meeting_links_target_idx is 'Reverse lookup: meetings linked to a CRM record. See task_links_target_idx.';
comment on index public.note_links_target_idx     is 'Reverse lookup: notes linked to a CRM record. See task_links_target_idx.';
comment on index public.document_links_target_idx is 'Reverse lookup: documents linked to a CRM record. See task_links_target_idx.';

-- ---------------------------------------------------------------------------
-- updated_at triggers, by hand (rls_phase2_crm.sql L5/L6).
-- ---------------------------------------------------------------------------
drop trigger if exists set_updated_at on public.task_links;
create trigger set_updated_at before update on public.task_links
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.meeting_links;
create trigger set_updated_at before update on public.meeting_links
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.note_links;
create trigger set_updated_at before update on public.note_links
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.document_links;
create trigger set_updated_at before update on public.document_links
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Grants and RLS. select/insert/update on every link table (a link is
-- created, soft-deleted via an UPDATE of deleted_at, and re-pointed never --
-- there is nothing else to change). NO DELETE. RLS ON, policies in Task 2.
-- ---------------------------------------------------------------------------
revoke all on public.task_links     from public, anon, authenticated, service_role;
revoke all on public.meeting_links  from public, anon, authenticated, service_role;
revoke all on public.note_links     from public, anon, authenticated, service_role;
revoke all on public.document_links from public, anon, authenticated, service_role;

grant select, insert, update on public.task_links     to authenticated;
grant select, insert, update on public.meeting_links  to authenticated;
grant select, insert, update on public.note_links     to authenticated;
grant select, insert, update on public.document_links to authenticated;

alter table public.task_links     enable row level security;
alter table public.meeting_links  enable row level security;
alter table public.note_links     enable row level security;
alter table public.document_links enable row level security;

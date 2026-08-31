-- Phase 4 (Operations), Task 1a: public.tasks, public.meetings, public.notes.
--
-- Scope note, mirroring 20260901000000's Task 1 header exactly: this migration
-- creates TABLES, CONSTRAINTS, INDEXES, GRANTS and one updated_at trigger per
-- table. It creates NO policies, NO helper functions and NO permission keys.
-- Those are Phase 4 Task 2, which depends on the tables created here.
--
-- public.documents / public.document_versions are 20260902001000; the four
-- *_links tables are 20260902002000; the dispatch widening is 20260902003000.
-- This file is the three top-level operational entities that are NOT the file
-- pipeline.
--
-- RLS IS ENABLED ON ALL THREE TABLES AT THE BOTTOM OF THIS FILE, with zero
-- policies. RLS with no policies denies every row to every non-owner role,
-- which is the correct intermediate state: CLAUDE.md § Non-negotiable rules
-- requires RLS to be on "before the application can reach it", and a table
-- that exists for one migration with RLS off is a table that was reachable.
--
-- MEASURED CONSEQUENCE, stated here so a reviewer does not have to discover
-- it: between this migration and Task 2, schema_invariants.sql D4, D5 and D11b
-- FAIL. They assert "every table in the list has policies" and "every grant is
-- justified by a policy", and for one task both are false by design -- the
-- same named interval Phase 3 Task 1 opened for events/event_lineup. The Task
-- 1 report lists the exact labels and counts. The interval is the safe
-- direction -- a grant with no policy behind it reaches no rows.
--
-- ===========================================================================
-- CONVENTIONS -- inherited from 20260827232510 and 20260901000000, restated
-- only where this file makes a choice those files did not.
-- ===========================================================================
--
-- (1) TENANCY. Every table carries `organisation_id` NOT NULL with an
--     ON DELETE CASCADE FK to public.organisations, and every one gets a
--     redundant-on-its-own UNIQUE (id, organisation_id) so the four *_links
--     tables (20260902002000) can point a TENANT-SCOPED COMPOSITE foreign key
--     (parent_id, organisation_id) -> parent (id, organisation_id) at it --
--     the technique 20260828001132 introduced after a cross-tenant write was
--     proven end to end, and the same trade events_id_org_unique makes.
--
-- (2) owner_user_id ON EVERY TABLE, `default auth.uid()`. These are top-level
--     entities, so each carries an owner both as the assignee/author AND as
--     the record-scope key. The default is the 20260828001134 § 2 floor: a
--     record created by a Standard User with no owner is a record they
--     instantly cannot see. The default reads request.jwt.claims and returns
--     NULL rather than raising for a sessionless writer, so migrations, seeds
--     and the harness are unaffected. It is a FLOOR, not the enforcement:
--     Task 2's WITH CHECK still has to pin owner_user_id on insert.
--
-- (3) VALUE DOMAINS ARE CHECK CONSTRAINTS, NOT ENUM TYPES. 20260827232510
--     note (5): "Where the brief says 'enum', read 'closed value set'."
--
-- (4) SOFT DELETE. `deleted_at timestamptz` on all three. NO DELETE GRANT on
--     any of them: soft delete is the only delete (CLAUDE.md § Non-negotiable
--     rules).
--
-- (5) TIMESTAMPS. UTC (`timestamptz`); `updated_at` maintained by a trigger
--     added BY HAND at the bottom of this file, NAMED `set_updated_at` on
--     every table (rls_phase2_crm.sql L5 asserts exactly that name; L6 counts
--     them). 20260828121500 rejected a DDL event trigger explicitly.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- tasks
-- A unit of work with an owner, a due date, a priority and a status, hung off
-- any major CRM record via task_links (20260902002000). PRD § 6.6: "title,
-- owner, due date, priority, status, related entity and reminder".
--
-- Tenant-private, like every other table in this schema; nothing here may be
-- joined into a discovery path (CLAUDE.md § The private/network split).
-- ---------------------------------------------------------------------------
create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id   uuid default auth.uid() references auth.users (id) on delete set null,
  title           text not null check (btrim(title) <> ''),
  detail          text,
  status          text not null default 'open'
                    check (status in ('open','in_progress','blocked','done','cancelled')),
  priority        text not null default 'normal'
                    check (priority in ('low','normal','high','urgent')),
  -- NULLABLE: a task need not have a due date. It is deliberately NOT a list
  -- sort column (codebase rule 9: a sort column must be NOT NULL). The default
  -- list sort is created_at desc; due_at is available only as a FILTER (has
  -- due / overdue / none), which Task 3 wires.
  due_at          timestamptz,
  -- Stored only. No delivery mechanism at MVP (Q45): reminder_at is a
  -- timestamp with no notifier, and building one is out of scope
  -- (CLAUDE.md § Scope discipline).
  reminder_at     timestamptz,
  -- Set when status -> 'done'; drives the task_completed timeline branch a
  -- later task adds. Not maintained by a trigger here -- the write path sets
  -- it, because "done" is an application transition, not a DDL one.
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint tasks_reminder_not_after_due
    check (reminder_at is null or due_at is null or reminder_at <= due_at)
);

comment on table public.tasks is
  'A unit of work (PRD § 6.6), hung off a CRM record via task_links. Tenant-private; never joined into a network discovery path. Soft-deleted, never hard-deleted, and there is no DELETE grant. DEFAULT LIST SORT IS created_at desc: due_at is nullable and therefore NOT a keyset sort column (codebase rule 9), it is a FILTER only (has due / overdue / none).';

comment on column public.tasks.owner_user_id is
  'THE ASSIGNEE AND THE RECORD-SCOPE KEY ARE THE SAME PERSON HERE. PRD''s "owner" of a task and the schema''s record-scope owner coincide, deliberately: a task is assigned to exactly one user, who is also the one a record-scoped role sees it as theirs. DO NOT add a second assignee_id in a later phase without deciding which of the two governs record scope -- they were unified on purpose.';

comment on column public.tasks.due_at is
  'NULLABLE, and deliberately NOT in any list sort allowlist. A nullable sort column makes keyset ordering non-total and silently drops a band of rows out of the middle of a page (rule 9). Exposed as a filter (has due / overdue / none), not a sort.';

comment on column public.tasks.reminder_at is
  'STORED ONLY. There is no reminder delivery mechanism at MVP (Q45) -- no scheduler, no notifier, no worker. Building one is out of scope (CLAUDE.md § Scope discipline). The value is kept so a later phase can deliver on it without a migration.';

comment on constraint tasks_reminder_not_after_due on public.tasks is
  'A reminder after the thing it reminds about is nonsense. Skipped entirely when either timestamp is NULL (a task may have a reminder and no due date, or a due date and no reminder), so it only bites when both are set and out of order.';

-- ---------------------------------------------------------------------------
-- meetings
-- A dated appointment with a roster, a place and notes, hung off a CRM record
-- via meeting_links. PRD § 6.6: "date/time, attendees, location/link, notes".
-- ---------------------------------------------------------------------------
create table public.meetings (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id   uuid default auth.uid() references auth.users (id) on delete set null,
  title           text not null check (btrim(title) <> ''),
  -- NOT NULL: it is the meetings-list default sort column, and a nullable sort
  -- column makes keyset ordering non-total (rule 9). A meeting always has a
  -- time; an undated appointment is a task, not a meeting.
  starts_at       timestamptz not null,
  ends_at         timestamptz,
  -- Free text OR a URL for the case where the place is not a record ("Zoom",
  -- "The George, back room"). Validated by safeHref() on render, like every
  -- other user-supplied URL surface.
  location        text,
  meeting_url     text check (meeting_url is null or meeting_url ~* '^https?://'),
  -- Free-text roster at MVP (Q46). Structured people links go through
  -- meeting_links with entity_type='contact', which is what makes a contact's
  -- timeline show "met with".
  attendees       text,
  notes           text,
  status          text not null default 'scheduled'
                    check (status in ('scheduled','held','cancelled','no_show')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint meetings_ends_after_starts check (ends_at is null or ends_at > starts_at)
);

comment on table public.meetings is
  'A dated appointment (PRD § 6.6), hung off a CRM record via meeting_links. Tenant-private; never joined into a network discovery path. Soft-deleted, never hard-deleted, and there is no DELETE grant. starts_at is the default list sort column and is NOT NULL for that reason.';

comment on column public.meetings.attendees is
  'FREE TEXT at MVP (Q46). Structured attendee links to public.contacts go through meeting_links with entity_type=''contact'' -- that row is what puts "met with" on a contact''s timeline. A first-class attendee table is deferred.';

comment on constraint meetings_ends_after_starts on public.meetings is
  'ends_at is nullable (an appointment with no announced finish is ordinary); when present it must be strictly after starts_at.';

comment on constraint meetings_meeting_url_check on public.meetings is
  'DEFENCE IN DEPTH, NOT THE CONTROL. The URL protocol rule for this product lives in lib/crm/urls.ts: normaliseWebsite() is the write-side allowlist and safeHref() the render-side one, and safeHref() is what stops a stored javascript: or data: URL becoming a live link. This CHECK is a cheap second floor for a writer that reaches PostgREST directly. DO NOT DELETE EITHER OF THOSE GUARDS BELIEVING THIS COVERS THEM -- it does not run on render, and it does not normalise.';

-- ---------------------------------------------------------------------------
-- notes
-- A body of text with a private/company visibility flag, hung off a CRM record
-- via note_links. PRD § 6.6: "rich text, attachments, links and mentions;
-- private vs company visibility".
-- ---------------------------------------------------------------------------
create table public.notes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  owner_user_id   uuid default auth.uid() references auth.users (id) on delete set null,
  -- Sanitised markdown/plain text (Q48). NEVER rendered with
  -- dangerouslySetInnerHTML -- CLAUDE.md § Non-negotiable rules, "treat all
  -- user content as untrusted".
  body            text not null check (btrim(body) <> ''),
  visibility      text not null default 'company'
                    check (visibility in ('private','company')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

comment on table public.notes is
  'A note (PRD § 6.6), hung off a CRM record via note_links. Tenant-private; never joined into a network discovery path. Soft-deleted, never hard-deleted, and there is no DELETE grant. "attachments" (PRD) are NOT modelled as note_links: a document attaches to a CRM record, not to another note -- see 20260902002000''s allowlist decision (Q49). "links and mentions" (PRD) are out of MVP: there is no rich-text mention engine.';

comment on column public.notes.visibility is
  'THE PRD''s BINARY: ''private'' reaches only the author, ''company'' reaches every viewer in the org. This drives a NEW SELECT policy shape in Task 2 (the five Phase 2 entities have no per-row visibility flag). A finer per-user note ACL is a real PRD gap recorded as Q44; the binary is what MVP ships.';

comment on column public.notes.body is
  'SANITISED text (Q48), stored as markdown/plain. NEVER dangerouslySetInnerHTML on render -- CLAUDE.md § Non-negotiable rules. The btrim CHECK rejects an all-whitespace body, matching the title/name guards on every other entity.';

-- ---------------------------------------------------------------------------
-- The redundant-on-their-own UNIQUE (id, organisation_id) constraints the
-- four *_links composite foreign keys (20260902002000) point at. Each is
-- redundant because `id` is already the primary key, and exists only because
-- Postgres requires a unique constraint on exactly the referenced column list.
-- Identical trade to events_id_org_unique and the five 20260828001132 added.
-- ---------------------------------------------------------------------------
alter table public.tasks    add constraint tasks_id_org_unique    unique (id, organisation_id);
alter table public.meetings add constraint meetings_id_org_unique unique (id, organisation_id);
alter table public.notes    add constraint notes_id_org_unique    unique (id, organisation_id);

comment on constraint tasks_id_org_unique on public.tasks is
  'Redundant on its own (id is already the primary key). Target of task_links_parent_fkey (20260902002000), the tenant-scoped composite FK. Do not drop without dropping that FK.';
comment on constraint meetings_id_org_unique on public.meetings is
  'Redundant on its own. Target of meeting_links_parent_fkey (20260902002000). Do not drop without dropping that FK.';
comment on constraint notes_id_org_unique on public.notes is
  'Redundant on its own. Target of note_links_parent_fkey (20260902002000). Do not drop without dropping that FK.';

-- ---------------------------------------------------------------------------
-- Indexes. FK-COVERING ONLY. schema_invariants.sql D3 ("every FK in public has
-- its leading column indexed") runs against this migration, and these satisfy
-- it. The LIST indexes -- the
-- (organisation_id, <sort>, id) include (owner_user_id) where deleted_at is
-- null shape -- belong to Task 3, which declares the sorts and can measure the
-- plans. Adding them here would ship index definitions justified by a guess.
-- ---------------------------------------------------------------------------
create index tasks_organisation_id_idx    on public.tasks (organisation_id);
create index tasks_owner_user_id_idx       on public.tasks (owner_user_id);
create index meetings_organisation_id_idx  on public.meetings (organisation_id);
create index meetings_owner_user_id_idx     on public.meetings (owner_user_id);
create index notes_organisation_id_idx     on public.notes (organisation_id);
create index notes_owner_user_id_idx        on public.notes (owner_user_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers, by hand. 20260828121500 rejected a DDL event trigger
-- and made each new table's own migration responsible. rls_phase2_crm.sql L5
-- is the tripwire and L6 counts them. The `when` clause is verbatim: a no-op
-- UPDATE must not move the timestamp.
-- ---------------------------------------------------------------------------
drop trigger if exists set_updated_at on public.tasks;
create trigger set_updated_at before update on public.tasks
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.meetings;
create trigger set_updated_at before update on public.meetings
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.notes;
create trigger set_updated_at before update on public.notes
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Grants and RLS. The 20260827232507 default-privileges baseline means every
-- table arrives with an EMPTY ACL, so the revokes are belt-and-braces. NO
-- DELETE, matching every other CRM/events table. RLS ON, POLICIES IN TASK 2 --
-- the safe order "RLS on before access" requires.
-- ---------------------------------------------------------------------------
revoke all on public.tasks    from public, anon, authenticated, service_role;
revoke all on public.meetings from public, anon, authenticated, service_role;
revoke all on public.notes    from public, anon, authenticated, service_role;

grant select, insert, update on public.tasks    to authenticated;
grant select, insert, update on public.meetings to authenticated;
grant select, insert, update on public.notes    to authenticated;

alter table public.tasks    enable row level security;
alter table public.meetings enable row level security;
alter table public.notes    enable row level security;

-- ===========================================================================
-- Phase 8 Task 1: the versioned legal document store (DECISIONS-QUEUE Q128).
--
-- PRD §12 requires fifteen legal pages; PRD §18 says "version legal pages";
-- the master plan says they must be "CMS-editable so counsel can revise
-- without a deploy". No CMS exists, and adding a hosted one would add a
-- sub-processor and a second system of record for no MVP gain (Q128). So the
-- store is a table:
--
--   public.legal_documents   one row per (slug, version)
--
-- ENGINEERING WRITES DRAFTS; COUNSEL WRITES LAW. Every version carries a
-- counsel-review marker, and until it is set the public page says, in a
-- notice that cannot be dismissed, that it is a draft pending legal review.
-- Nothing in this migration (or its seed, 20260922001000) marks anything
-- reviewed: an INSERT with a review marker is refused by the guard below, so
-- a seed cannot claim a review that has not happened.
--
-- ---------------------------------------------------------------------------
-- THE LIFECYCLE
-- ---------------------------------------------------------------------------
--   draft  --publish-->  published  --(a newer version publishes)-->  superseded
--
--   * At most one DRAFT per slug and exactly one PUBLISHED per slug (two
--     partial unique indexes; the seed publishes one of each of the fifteen,
--     and nothing can unpublish).
--   * A PUBLISHED or SUPERSEDED version is IMMUTABLE -- enforced by
--     private.legal_documents_guard(), a BEFORE trigger that applies to EVERY
--     role, postgres and service_role included (there is no
--     row_security_active() exemption here, unlike the override guards: the
--     published text is what a consent will point at, so "nobody may edit it"
--     is the property, not "no client may"). The only changes it permits to a
--     non-draft row are: published -> superseded (with superseded_at), the
--     one-time recording of a counsel review, and an attribution uuid going to
--     NULL (so the ON DELETE SET NULL on the three auth.users references can
--     run when an account is erased -- Q130's blocked-delete lesson). DELETE
--     of a non-draft row is refused. What the guard cannot stop is a database
--     superuser disabling it (`alter table ... disable trigger`, or
--     `session_replication_role = replica`) -- that is the DBA escape hatch
--     every trigger has, it is not reachable from any API, and the test
--     suites that tidy up after themselves use it explicitly and by name.
--
-- ---------------------------------------------------------------------------
-- WHO CAN DO WHAT
-- ---------------------------------------------------------------------------
--   READ (anon + authenticated): the CURRENT PUBLISHED version of each slug,
--     and only these columns: id, slug, version, title, body, effective_date,
--     published_at, counsel_reviewed_at. This is the one table in the schema a
--     signed-out visitor can read, so it is fenced twice: a row policy
--     (status = 'published' -- drafts and superseded versions match nothing)
--     AND a column-level grant. RLS filters rows, not columns (Q103), so the
--     reviewer's name and the three attribution uuids are simply outside the
--     grant: `select=*` from anon is a 401/42501, not a leak.
--   WRITE: nobody, directly. No client role holds INSERT, UPDATE or DELETE.
--     Every change goes through five SECURITY DEFINER RPCs below, each guarded
--     by private.has_platform_permission() -- the allowlisted superuser, at
--     aal2 -- and each writing its own audit row with identifiers only (slug,
--     version, id), never title, body or the reviewer's name: audit rows carry
--     no free-text content. The application adds step-up re-authentication on
--     publish and on recording a review (lib/legal/admin-actions.ts), which
--     the database cannot see.
--   OPERATOR READ: public.operator_legal_document_versions(), a guarded
--     definer read returning every column of every version -- the only way to
--     see a draft or who reviewed what.
--
-- ---------------------------------------------------------------------------
-- THE BODY
-- ---------------------------------------------------------------------------
-- A tiny Markdown subset (lib/legal/markup.ts), stored as text and parsed into
-- React elements at render time -- never into HTML, never through
-- dangerouslySetInnerHTML. The CHECK constraints below are the database's half
-- of that grammar: a link target must start `https://`, `mailto:` or a single
-- `/`; no tag opener (`<` + letter, `/` or `!`) may appear at all; every
-- `{{placeholder}}` must be one of the three the renderer knows; and three
-- documents must CONTAIN the placeholder that renders their generated part
-- (the Cookie Policy's storage table, the Subprocessors page's vendor table,
-- and the contact address on the two pages whose whole point is to give one).
-- ===========================================================================

create table public.legal_documents (
  id                          uuid primary key default gen_random_uuid(),
  slug                        text not null,
  version                     integer not null,
  title                       text not null,
  body                        text not null,
  effective_date              date not null,
  status                      text not null default 'draft',
  created_at                  timestamptz not null default now(),
  created_by                  uuid references auth.users (id) on delete set null,
  updated_at                  timestamptz not null default now(),
  published_at                timestamptz,
  published_by                uuid references auth.users (id) on delete set null,
  superseded_at               timestamptz,
  counsel_reviewed_at         timestamptz,
  counsel_reviewer            text,
  counsel_review_recorded_by  uuid references auth.users (id) on delete set null,

  constraint legal_documents_slug_version_unique unique (slug, version),

  constraint legal_documents_slug_known check (slug in (
    'privacy', 'cookies', 'data-retention', 'data-subject-rights',
    'marketing-preferences', 'subprocessors', 'terms', 'acceptable-use',
    'data-processing-addendum', 'community-guidelines', 'ai-use', 'security',
    'vulnerability-disclosure', 'accessibility', 'contact')),
  constraint legal_documents_version_positive check (version > 0),
  constraint legal_documents_status_known
    check (status in ('draft', 'published', 'superseded')),
  constraint legal_documents_title_length
    check (btrim(title) <> '' and char_length(title) <= 200),
  constraint legal_documents_body_length
    check (btrim(body) <> '' and char_length(body) <= 100000),

  -- The lifecycle, as shapes a row can and cannot have.
  constraint legal_documents_published_at_iff_not_draft
    check ((status = 'draft') = (published_at is null)),
  constraint legal_documents_superseded_at_iff_superseded
    check ((status = 'superseded') = (superseded_at is not null)),
  constraint legal_documents_review_is_complete
    check ((counsel_reviewed_at is null) = (counsel_reviewer is null)),
  constraint legal_documents_review_recorder_needs_review
    check (counsel_review_recorded_by is null or counsel_reviewed_at is not null),
  constraint legal_documents_reviewer_length
    check (counsel_reviewer is null
           or (btrim(counsel_reviewer) <> '' and char_length(counsel_reviewer) <= 200)),

  -- The grammar's database half (lib/legal/markup.ts is the other).
  --   A link target, i.e. whatever follows `](`, must begin with an allowed
  --   prefix. The negative lookahead after `\s*` means a leading space is
  --   itself refused (the zero-width match sees the space).
  constraint legal_documents_body_links_allowlisted
    check (body !~ '\]\(\s*(?!https://|mailto:|/[^/\\])'),
  constraint legal_documents_body_no_markup
    check (body !~ '<[A-Za-z/!]'),
  constraint legal_documents_body_tokens_known
    check (body !~ '\{\{(?!(support_email|subprocessors|storage_inventory)\}\})'),
  constraint legal_documents_required_blocks check (
        (slug <> 'cookies'       or strpos(body, '{{storage_inventory}}') > 0)
    and (slug <> 'subprocessors' or strpos(body, '{{subprocessors}}') > 0)
    and (slug not in ('contact', 'vulnerability-disclosure')
         or strpos(body, '{{support_email}}') > 0))
);

comment on table public.legal_documents is
  'The fifteen PRD §12 legal pages, one row per (slug, version) -- DECISIONS-QUEUE Q128. A published or superseded version is immutable for every role (private.legal_documents_guard). anon/authenticated read the CURRENT PUBLISHED version only (legal_documents_select_current_published) and only the columns granted to them; the reviewer name and attribution uuids are outside that grant. No client role can write: every change goes through the five guarded, audited superuser RPCs in 20260922000000. counsel_reviewed_at null means the public page shows the draft-pending-legal-review notice.';

comment on column public.legal_documents.counsel_reviewed_at is
  'When qualified legal counsel''s review of THIS version was recorded. Null = not reviewed, and the public page says so. Set once, by public.record_legal_document_counsel_review(), never by a seed (the guard refuses an INSERT that carries it); editing a draft''s content clears it.';
comment on column public.legal_documents.counsel_reviewer is
  'Who reviewed it, as the operator recorded it (a firm or a person). NOT public: outside the anon/authenticated column grant, and never copied into an audit row (free text). Read only through public.operator_legal_document_versions().';

create unique index legal_documents_one_published_per_slug
  on public.legal_documents (slug) where status = 'published';
create unique index legal_documents_one_draft_per_slug
  on public.legal_documents (slug) where status = 'draft';
-- CLAUDE.md "Index every foreign key".
create index legal_documents_created_by_idx on public.legal_documents (created_by);
create index legal_documents_published_by_idx on public.legal_documents (published_by);
create index legal_documents_counsel_review_recorded_by_idx
  on public.legal_documents (counsel_review_recorded_by);

comment on index public.legal_documents_one_published_per_slug is
  'Exactly one current published version per slug. "At least one" is the seed (20260922001000) plus the fact that nothing can unpublish: publish_legal_document() supersedes the incumbent in the same statement sequence that promotes the draft.';

-- ---------------------------------------------------------------------------
-- THE IMMUTABILITY GUARD -- every role, every write.
-- ---------------------------------------------------------------------------
create or replace function private.legal_documents_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'legal_documents: a % version cannot be deleted (slug %, version %)',
        old.status, old.slug, old.version
        using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'legal_documents: a version is inserted as a draft and published by transition, never inserted published'
        using errcode = '42501';
    end if;
    if new.counsel_reviewed_at is not null or new.counsel_reviewer is not null
       or new.counsel_review_recorded_by is not null then
      raise exception 'legal_documents: a counsel review cannot be recorded at insert -- only by public.record_legal_document_counsel_review()'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE. Identity never changes.
  if new.id <> old.id or new.slug <> old.slug or new.version <> old.version
     or new.created_at <> old.created_at then
    raise exception 'legal_documents: id, slug, version and created_at are fixed'
      using errcode = '42501';
  end if;

  -- The three attribution uuids may only stay as they are or go to NULL (the
  -- ON DELETE SET NULL of an erased account). Never to a different person.
  if (new.created_by is distinct from old.created_by and new.created_by is not null)
     or (new.published_by is distinct from old.published_by and new.published_by is not null
         and old.status <> 'draft')
     or (new.counsel_review_recorded_by is distinct from old.counsel_review_recorded_by
         and new.counsel_review_recorded_by is not null
         and old.counsel_reviewed_at is not null) then
    raise exception 'legal_documents: attribution can be erased, never reassigned'
      using errcode = '42501';
  end if;

  if old.status = 'draft' then
    if new.status = 'superseded' then
      raise exception 'legal_documents: a draft cannot be superseded -- publish it or leave it'
        using errcode = '42501';
    end if;
    if new.status = 'published' then
      -- Publishing promotes the reviewed-or-not text AS IT STANDS.
      if (new.title, new.body, new.effective_date) is distinct from
         (old.title, old.body, old.effective_date)
         or (new.counsel_reviewed_at, new.counsel_reviewer)
            is distinct from (old.counsel_reviewed_at, old.counsel_reviewer) then
        raise exception 'legal_documents: publishing cannot also change the content or the review'
          using errcode = '42501';
      end if;
    elsif (new.title, new.body, new.effective_date) is distinct from
          (old.title, old.body, old.effective_date)
          and new.counsel_reviewed_at is not null then
      -- A review is of a TEXT. Changing the text un-reviews it.
      raise exception 'legal_documents: editing a reviewed draft must clear its counsel review'
        using errcode = '42501';
    end if;
    new.updated_at := pg_catalog.now();
    return new;
  end if;

  -- old.status is 'published' or 'superseded': the text is frozen.
  if (new.title, new.body, new.effective_date, new.published_at, new.updated_at)
     is distinct from
     (old.title, old.body, old.effective_date, old.published_at, old.updated_at) then
    raise exception 'legal_documents: a % version is immutable (slug %, version %) -- publish a new version instead',
      old.status, old.slug, old.version
      using errcode = '42501';
  end if;

  if old.status = 'superseded' then
    if new.status <> 'superseded' or new.superseded_at <> old.superseded_at
       or (new.counsel_reviewed_at, new.counsel_reviewer)
          is distinct from (old.counsel_reviewed_at, old.counsel_reviewer) then
      raise exception 'legal_documents: a superseded version is immutable (slug %, version %)',
        old.slug, old.version
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- old.status = 'published'
  if new.status = 'draft' then
    raise exception 'legal_documents: a published version cannot return to draft'
      using errcode = '42501';
  end if;
  if old.counsel_reviewed_at is not null
     and (new.counsel_reviewed_at, new.counsel_reviewer)
         is distinct from (old.counsel_reviewed_at, old.counsel_reviewer) then
    raise exception 'legal_documents: a recorded counsel review cannot be changed or withdrawn'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function private.legal_documents_guard() is
  'BEFORE INSERT/UPDATE/DELETE on public.legal_documents, for EVERY role (no row_security_active() exemption -- the published text is the thing a consent points at). Refuses: inserting anything but an unreviewed draft; changing id/slug/version/created_at; reassigning attribution (erasing it to NULL is allowed, for ON DELETE SET NULL); superseding a draft; publishing and editing in one step; editing a reviewed draft without clearing the review; ANY change to the title/body/effective date/published_at of a published or superseded version; un-publishing; changing a recorded review; and deleting a non-draft. Stamps updated_at on draft edits.';

revoke all on function private.legal_documents_guard() from public, anon, authenticated, service_role;

create trigger legal_documents_guard
  before insert or update or delete on public.legal_documents
  for each row execute function private.legal_documents_guard();

-- ---------------------------------------------------------------------------
-- RLS AND GRANTS
-- ---------------------------------------------------------------------------
alter table public.legal_documents enable row level security;

revoke all on public.legal_documents from public, anon, authenticated, service_role;
grant select (id, slug, version, title, body, effective_date, published_at, counsel_reviewed_at)
  on public.legal_documents to anon, authenticated;

create policy legal_documents_select_current_published
  on public.legal_documents
  for select
  to anon, authenticated
  using ( status = 'published' );

comment on policy legal_documents_select_current_published on public.legal_documents is
  'The ONE policy in the schema that a signed-out visitor satisfies: the current published version of each legal page. Drafts and superseded versions match nothing, for every client role including the superuser (who reads them through public.operator_legal_document_versions()). Rows only -- the column grant is what keeps the reviewer name and attribution off the public surface (Q103).';

-- ---------------------------------------------------------------------------
-- THE OPERATOR'S READ
-- ---------------------------------------------------------------------------
create or replace function public.operator_legal_document_versions(p_slug text default null)
returns table (
  id                         uuid,
  slug                       text,
  version                    integer,
  title                      text,
  body                       text,
  effective_date             date,
  status                     text,
  created_at                 timestamptz,
  updated_at                 timestamptz,
  published_at               timestamptz,
  superseded_at              timestamptz,
  counsel_reviewed_at        timestamptz,
  counsel_reviewer           text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('manage_legal_documents') then
    raise exception 'operator_legal_document_versions: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  return query
    select d.id, d.slug, d.version, d.title, d.body, d.effective_date, d.status,
           d.created_at, d.updated_at, d.published_at, d.superseded_at,
           d.counsel_reviewed_at, d.counsel_reviewer
      from public.legal_documents d
     where p_slug is null or d.slug = p_slug
     order by d.slug, d.version desc
     -- Bounded (CLAUDE.md "Paginate everything"): fifteen slugs, and a
     -- document revised more than 200 times in one list is not a real case.
     limit 3000;
end;
$$;

comment on function public.operator_legal_document_versions(text) is
  'The superuser''s read of every version of every legal document (or of one slug), drafts, superseded versions and the reviewer name included -- /super/legal. Guarded by has_platform_permission (allowlist + aal2); refuses (42501) everyone else, so a draft is invisible to every other principal on every path. Not audited: it reads no tenant data.';

revoke all on function public.operator_legal_document_versions(text) from public, anon, authenticated, service_role;
grant execute on function public.operator_legal_document_versions(text) to authenticated;

-- ---------------------------------------------------------------------------
-- THE FOUR WRITES
-- ---------------------------------------------------------------------------
create or replace function public.create_legal_document_draft(p_slug text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_src     public.legal_documents%rowtype;
  v_version integer;
  v_id      uuid;
begin
  if not private.has_platform_permission('manage_legal_documents') then
    raise exception 'create_legal_document_draft: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  select * into v_src
    from public.legal_documents d
   where d.slug = p_slug and d.status = 'published';
  if not found then
    raise exception 'create_legal_document_draft: no published document with that slug'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.legal_documents d
              where d.slug = p_slug and d.status = 'draft') then
    raise exception 'create_legal_document_draft: a draft already exists for that document'
      using errcode = '22023';
  end if;

  select max(d.version) + 1 into v_version
    from public.legal_documents d where d.slug = p_slug;

  insert into public.legal_documents
    (slug, version, title, body, effective_date, status, created_by)
  values
    (p_slug, v_version, v_src.title, v_src.body,
     (pg_catalog.now() at time zone 'Europe/London')::date,
     'draft', (select auth.uid()))
  returning id into v_id;

  perform private.log_audit_event(
    p_action      => 'legal_document.draft_created',
    p_target_type => 'legal_document',
    p_target_id   => v_id,
    p_after       => pg_catalog.jsonb_build_object(
      'slug', p_slug, 'version', v_version, 'based_on_version', v_src.version)
  );
  return v_id;
end;
$$;

comment on function public.create_legal_document_draft(text) is
  'Starts the next version of one legal document as a DRAFT copied from its current published version (effective date defaulted to today in London). Superuser at aal2 only; 22023 if the slug has no published version or already has a draft. Audited as legal_document.draft_created with identifiers only.';

revoke all on function public.create_legal_document_draft(text) from public, anon, authenticated, service_role;
grant execute on function public.create_legal_document_draft(text) to authenticated;


create or replace function public.update_legal_document_draft(
  p_document_id    uuid,
  p_title          text,
  p_body           text,
  p_effective_date date
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row           public.legal_documents%rowtype;
  v_review_cleared boolean;
begin
  if not private.has_platform_permission('manage_legal_documents') then
    raise exception 'update_legal_document_draft: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_title is null or p_body is null or p_effective_date is null then
    raise exception 'update_legal_document_draft: title, body and effective date are required'
      using errcode = '22023';
  end if;

  select * into v_row
    from public.legal_documents d
   where d.id = p_document_id and d.status = 'draft'
   for update;
  if not found then
    raise exception 'update_legal_document_draft: no draft with that id'
      using errcode = '22023';
  end if;

  v_review_cleared := v_row.counsel_reviewed_at is not null
    and (v_row.title, v_row.body, v_row.effective_date)
        is distinct from (pg_catalog.btrim(p_title), p_body, p_effective_date);

  update public.legal_documents d
     set title = pg_catalog.btrim(p_title),
         body = p_body,
         effective_date = p_effective_date,
         counsel_reviewed_at = case when v_review_cleared then null else d.counsel_reviewed_at end,
         counsel_reviewer = case when v_review_cleared then null else d.counsel_reviewer end,
         counsel_review_recorded_by =
           case when v_review_cleared then null else d.counsel_review_recorded_by end
   where d.id = p_document_id;

  perform private.log_audit_event(
    p_action      => 'legal_document.draft_updated',
    p_target_type => 'legal_document',
    p_target_id   => p_document_id,
    p_after       => pg_catalog.jsonb_build_object(
      'slug', v_row.slug, 'version', v_row.version, 'review_cleared', v_review_cleared)
  );
  return p_document_id;
end;
$$;

comment on function public.update_legal_document_draft(uuid, text, text, date) is
  'Replaces a DRAFT''s title, body and effective date. Superuser at aal2 only; 22023 for a missing value or an id that is not a draft (a published version is never editable -- and the guard refuses it anyway). A body the grammar CHECKs refuse is 23514. Changing the text of a reviewed draft clears its counsel review, because a review is of a text. Audited as legal_document.draft_updated -- identifiers and review_cleared only, never the text.';

revoke all on function public.update_legal_document_draft(uuid, text, text, date) from public, anon, authenticated, service_role;
grant execute on function public.update_legal_document_draft(uuid, text, text, date) to authenticated;


create or replace function public.publish_legal_document(p_document_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row        public.legal_documents%rowtype;
  v_superseded integer;
begin
  if not private.has_platform_permission('manage_legal_documents') then
    raise exception 'publish_legal_document: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  select * into v_row
    from public.legal_documents d
   where d.id = p_document_id and d.status = 'draft'
   for update;
  if not found then
    raise exception 'publish_legal_document: no draft with that id'
      using errcode = '22023';
  end if;

  -- Supersede FIRST: legal_documents_one_published_per_slug is checked per
  -- statement, so the incumbent has to leave before the draft arrives.
  update public.legal_documents d
     set status = 'superseded', superseded_at = pg_catalog.now()
   where d.slug = v_row.slug and d.status = 'published'
  returning d.version into v_superseded;

  update public.legal_documents d
     set status = 'published',
         published_at = pg_catalog.now(),
         published_by = (select auth.uid())
   where d.id = p_document_id;

  perform private.log_audit_event(
    p_action      => 'legal_document.published',
    p_target_type => 'legal_document',
    p_target_id   => p_document_id,
    p_after       => pg_catalog.jsonb_build_object(
      'slug', v_row.slug,
      'version', v_row.version,
      'superseded_version', v_superseded,
      'counsel_reviewed', v_row.counsel_reviewed_at is not null)
  );
  return p_document_id;
end;
$$;

comment on function public.publish_legal_document(uuid) is
  'Makes a DRAFT the current public version of its document, superseding the incumbent. Superuser at aal2 only (the application adds step-up); 22023 for an id that is not a draft. The published text is immutable from this moment (private.legal_documents_guard). Audited as legal_document.published with slug, version, the superseded version and whether counsel had reviewed it -- never the text.';

revoke all on function public.publish_legal_document(uuid) from public, anon, authenticated, service_role;
grant execute on function public.publish_legal_document(uuid) to authenticated;


create or replace function public.record_legal_document_counsel_review(
  p_document_id uuid,
  p_reviewer    text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.legal_documents%rowtype;
begin
  if not private.has_platform_permission('manage_legal_documents') then
    raise exception 'record_legal_document_counsel_review: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reviewer is null or pg_catalog.btrim(p_reviewer) = '' then
    raise exception 'record_legal_document_counsel_review: name the reviewing counsel'
      using errcode = '22023';
  end if;

  update public.legal_documents d
     set counsel_reviewed_at = pg_catalog.now(),
         counsel_reviewer = pg_catalog.btrim(p_reviewer),
         counsel_review_recorded_by = (select auth.uid())
   where d.id = p_document_id
     and d.status in ('draft', 'published')
     and d.counsel_reviewed_at is null
  returning d.* into v_row;
  if not found then
    raise exception 'record_legal_document_counsel_review: no unreviewed draft or current version with that id'
      using errcode = '22023';
  end if;

  perform private.log_audit_event(
    p_action      => 'legal_document.counsel_review_recorded',
    p_target_type => 'legal_document',
    p_target_id   => p_document_id,
    p_after       => pg_catalog.jsonb_build_object(
      'slug', v_row.slug, 'version', v_row.version, 'status', v_row.status)
  );
  return p_document_id;
end;
$$;

comment on function public.record_legal_document_counsel_review(uuid, text) is
  'Records that qualified legal counsel has reviewed ONE version (a draft before it is published, or the current published version) -- the act that removes the public draft notice. Superuser at aal2 only (the application adds step-up); once recorded it cannot be changed or withdrawn (the guard). 22023 for a blank reviewer or an id that is superseded, missing or already reviewed. Audited as legal_document.counsel_review_recorded with slug, version and status -- the reviewer''s name is free text and is NOT in the audit row.';

revoke all on function public.record_legal_document_counsel_review(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.record_legal_document_counsel_review(uuid, text) to authenticated;

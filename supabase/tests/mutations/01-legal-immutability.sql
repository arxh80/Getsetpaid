-- PHASE 8 TASK 8 MUTANT 01-legal-immutability
-- guard:  private.legal_documents_guard
-- change: the frozen-text rule: a published or superseded version's text may be edited
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.legal_documents_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  if false and (new.title, new.body, new.effective_date, new.published_at, new.updated_at)
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
$function$;

-- ===========================================================================
-- Phase 8 Task 2, fix round 2 (scoped re-review findings N2 and N7; Q154):
-- the workspace-address grammar holds on EVERY write of organisations.slug,
-- and the reserved-address comparison is made on a normalised key.
-- ===========================================================================
-- 20260923005000 put the reserved-address check at the chokepoint (a BEFORE
-- INSERT OR UPDATE OF slug trigger), but the GRAMMAR -- 2-63 characters of
-- lowercase ASCII letters, digits and single inner hyphens -- still lived only
-- inside public.create_organisation(). An Owner's direct UPDATE through the
-- existing column grant (organisations_update_manage_organisation) was
-- measured accepting `..`, `''`, `legal/x`, `_next`, `legal<TAB>`,
-- `legal<NBSP>` and fullwidth `ｌｅｇａｌ`: workspaces whose /<slug> links
-- resolve somewhere else (`..`, `legal/x`), nowhere (`''`), or into Next.js
-- itself (`_next`).
--
-- THE FIX: private.organisations_slug_not_reserved() is re-created from its
-- latest definition (20260923005000) and now, on INSERT and on any UPDATE that
-- CHANGES the slug, refuses
--   1. a slug whose NORMALISED KEY is reserved   (22023, hint reserved_slug)
--   2. a slug that is not in the grammar          (22023, hint invalid_slug)
-- in that order, so a look-alike of a reserved name is reported as reserved.
--
-- THE NORMALISATION -- private.workspace_slug_key(text):
--   lower( trim-[[:space:]]( normalize(slug, NFKC) ) )
-- NFKC (Unicode compatibility composition) folds the compatibility forms a
-- person can type or paste by accident or on purpose: fullwidth letters
-- (`ｌｅｇａｌ` -> `legal`), ligatures, superscripts, and the no-break and
-- other width-variant spaces (U+00A0, U+3000 -> U+0020), which the trim then
-- removes along with tabs and newlines. lower() then folds case. NFKC was
-- chosen over NFC because NFC leaves every one of those forms distinct.
-- It does NOT fold cross-script homoglyphs (Cyrillic `е` for Latin `e`):
-- no Unicode normalisation form does. That is safe here because the grammar
-- is ASCII-only, so such a slug is refused as invalid_slug anyway -- the key
-- only decides WHICH refusal is reported, never whether one is.
--
-- WHY A TRIGGER AND NOT A CHECK: a CHECK constraint is evaluated on every
-- UPDATE of the row, so a NOT VALID check would still refuse a rename (or a
-- lifecycle transition) of a pre-existing workspace whose slug is outside the
-- grammar -- the same "do not lock an existing workspace" rule 20260923005000
-- applied to reserved slugs. The trigger fires only when the slug changes.
-- EXISTING ROWS ARE NOT REJECTED for keeping their slug; the block at the end
-- reports how many exist, as NOTICEs (Q154 says what to do with them).
--
-- private.workspace_slug_key() is also the key the pre-launch query in Q154
-- uses, so that query, the NOTICE below and the trigger agree by construction.
-- ===========================================================================

create or replace function private.workspace_slug_key(p_slug text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.lower(
           pg_catalog.regexp_replace(
             pg_catalog.normalize(coalesce(p_slug, ''), 'NFKC'),
             '^[[:space:]]+|[[:space:]]+$', '', 'g'));
$$;

comment on function private.workspace_slug_key(text) is
  'The key a workspace slug is compared to the reserved list on: lower(trim-whitespace(normalize(slug, NFKC))). Folds fullwidth/compatibility forms, no-break and other Unicode spaces, tabs and case; does not fold cross-script homoglyphs (those fail the ASCII grammar instead). Used by private.organisations_slug_not_reserved() and by the Q154 pre-launch query. 20260923006000, review finding N2.';

revoke all on function private.workspace_slug_key(text) from public, anon, authenticated, service_role;

-- Re-created from 20260923005000 (its latest definition); the reserved check is
-- unchanged except that it compares the normalised key, and the grammar check
-- is new.
create or replace function private.organisations_slug_not_reserved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := coalesce(new.slug, '');
begin
  if tg_op = 'UPDATE' and new.slug is not distinct from old.slug then
    return new;
  end if;
  if exists (select 1 from private.reserved_workspace_slugs() r
              where r.slug = private.workspace_slug_key(v_slug)) then
    raise exception 'organisations: the workspace address % is reserved -- it is the address of a page of GetSetPaid', new.slug
      using errcode = '22023', hint = 'reserved_slug';
  end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or pg_catalog.length(v_slug) < 2
     or pg_catalog.length(v_slug) > 63 then
    raise exception 'organisations: a workspace address must be 2-63 characters of lowercase letters, digits and single hyphens (got %)', pg_catalog.quote_literal(new.slug)
      using errcode = '22023', hint = 'invalid_slug';
  end if;
  return new;
end;
$$;

comment on function private.organisations_slug_not_reserved() is
  'BEFORE INSERT OR UPDATE OF slug on public.organisations, for every writer (create_organisation() and an Owner''s direct slug update alike). Refuses (22023) a slug whose private.workspace_slug_key() is in private.reserved_workspace_slugs() (hint reserved_slug), then a slug outside ^[a-z0-9]+(-[a-z0-9]+)*$ or 2-63 characters (hint invalid_slug). An UPDATE that does not change the slug is never refused, so a pre-existing workspace holding a reserved or ungrammatical slug is not locked (Q154). 20260923005000 (M7), grammar and normalised key 20260923006000 (N2).';

revoke all on function private.organisations_slug_not_reserved() from public, anon, authenticated, service_role;

-- Report (never fail on) workspaces that already hold a reserved or
-- ungrammatical slug. The reserved count uses the same key as the trigger.
do $$
declare
  v_reserved integer;
  v_invalid  integer;
begin
  select count(*) into v_reserved
    from public.organisations o
   where private.workspace_slug_key(o.slug) in (select r.slug from private.reserved_workspace_slugs() r);
  select count(*) into v_invalid
    from public.organisations o
   where o.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      or pg_catalog.length(o.slug) not between 2 and 63;
  if v_reserved > 0 then
    raise notice 'workspace_slug_grammar: % existing workspace(s) hold a reserved slug (compared on private.workspace_slug_key) and are left as they are -- see DECISIONS-QUEUE Q154', v_reserved;
  end if;
  if v_invalid > 0 then
    raise notice 'workspace_slug_grammar: % existing workspace(s) hold a slug outside the grammar and are left as they are -- see DECISIONS-QUEUE Q154', v_invalid;
  end if;
end;
$$;

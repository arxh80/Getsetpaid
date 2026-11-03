-- ===========================================================================
-- Phase 8 Task 2, fix round 1 (review finding M7, DECISIONS-QUEUE Q151):
-- a workspace may not take the address of one of the product's own pages.
-- ===========================================================================
-- A workspace lives at /<slug>, beside the product's static top-level routes.
-- Next.js resolves a static segment before the dynamic [orgSlug] one, so a
-- workspace whose slug equals a static segment is shadowed. Measured by the
-- review with Next's own route sorter:
--   * `legal` (Phase 8 Task 1): /legal/<anything> resolves to /legal/[slug],
--     a 404 -- a workspace called `legal` could be created and never opened;
--     its owner was redirected to the legal index on creation;
--   * `account` (this task): /account/privacy is shadowed;
--   * `invites`, `onboarding`, `super`, `login`, `signup`, `magic-link`,
--     `api`, `auth`: at least the workspace home is shadowed.
-- create_organisation() accepted every one of them, and an Owner can also
-- change organisations.slug directly (organisations_update_manage_organisation
-- + the column grant), so both paths must refuse.
--
-- THE FIX: private.reserved_workspace_slugs() -- the static top-level segments
-- app/ defines, derived and asserted equal by
-- tests/unit/org/reserved-slugs.test.ts (which walks app/, so a new top-level
-- route that is not reserved here is a red test) and mirrored by
-- lib/org/reserved-slugs.ts for the form's message -- and a BEFORE INSERT OR
-- UPDATE OF slug trigger on public.organisations, the chokepoint both paths
-- pass: a reserved slug is refused (22023, hint reserved_slug).
--
-- EXISTING ROWS ARE NOT REJECTED RETROACTIVELY. The trigger fires on INSERT
-- and on an UPDATE that CHANGES the slug; an UPDATE that leaves a slug alone
-- (a rename, a lifecycle transition) passes whatever the slug is. So a
-- production workspace that already holds a reserved slug keeps working
-- exactly as badly as it did, and can still be renamed AWAY from it. The
-- block at the end reports how many such rows exist, as a NOTICE in the
-- migration log; what to do with any is DECISIONS-QUEUE Q154.
--
-- SECURITY DEFINER so the list lookup does not depend on the privileges of
-- the role whose UPDATE fired the trigger; it reads a constant and writes
-- nothing. search_path is empty and every reference is qualified.
-- ===========================================================================

create or replace function private.reserved_workspace_slugs()
returns table (slug text)
language sql
immutable
set search_path = ''
as $$
  values ('account'::text),
         ('api'::text),
         ('auth'::text),
         ('invites'::text),
         ('legal'::text),
         ('login'::text),
         ('magic-link'::text),
         ('onboarding'::text),
         ('signup'::text),
         ('super'::text);
$$;

comment on function private.reserved_workspace_slugs() is
  'The static top-level route segments of the app (20260923005000, Q151): a workspace slug equal to one would be shadowed by that route. Asserted equal to the segments app/ defines by tests/unit/org/reserved-slugs.test.ts; mirrored by lib/org/reserved-slugs.ts. Enforced by private.organisations_slug_not_reserved().';

revoke all on function private.reserved_workspace_slugs() from public, anon, authenticated, service_role;

create or replace function private.organisations_slug_not_reserved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.slug is not distinct from old.slug then
    return new;
  end if;
  if exists (select 1 from private.reserved_workspace_slugs() r
              where r.slug = pg_catalog.lower(pg_catalog.btrim(new.slug))) then
    raise exception 'organisations: the workspace address % is reserved -- it is the address of a page of GetSetPaid', new.slug
      using errcode = '22023', hint = 'reserved_slug';
  end if;
  return new;
end;
$$;

comment on function private.organisations_slug_not_reserved() is
  'BEFORE INSERT OR UPDATE OF slug on public.organisations, for every writer (create_organisation() and an Owner''s direct slug update alike): refuses a slug in private.reserved_workspace_slugs() (22023, hint reserved_slug). An UPDATE that does not change the slug is never refused, so a pre-existing workspace holding a reserved slug is not locked (Q154). 20260923005000, review finding M7.';

revoke all on function private.organisations_slug_not_reserved() from public, anon, authenticated, service_role;

create trigger organisations_slug_not_reserved
  before insert or update of slug on public.organisations
  for each row execute function private.organisations_slug_not_reserved();

-- Report (never fail on) workspaces that already hold a reserved slug.
do $$
declare
  v_clashes integer;
begin
  select count(*) into v_clashes
    from public.organisations o
   where pg_catalog.lower(o.slug) in (select r.slug from private.reserved_workspace_slugs() r);
  if v_clashes > 0 then
    raise notice 'reserved_workspace_slugs: % existing workspace(s) hold a reserved slug and are left as they are -- see DECISIONS-QUEUE Q154', v_clashes;
  end if;
end;
$$;

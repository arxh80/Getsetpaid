-- Phase 8 final review A, finding m1: ATTRIBUTION IS THE SESSION'S on
-- public.financial_entries, public.network_profiles and public.network_links.
--
-- THE HOLE. Each table's `created_by` is only `default auth.uid()` under a
-- table-level INSERT/UPDATE grant, with no policy term or BEFORE trigger
-- pinning it, and `created_at` is open the same way: a Finance user could
-- file an expense line "created by" any user id on the platform (the column
-- is a plain FK to auth.users), or back-date it, and the exports render the
-- column (Task 4) and the erasure re-point walks it (Task 5). Standing
-- lesson 7/15's exact shape.
--
-- THE FIX. One generic BEFORE INSERT OR UPDATE trigger, the born_pending
-- pattern (20261017000000): SECURITY INVOKER so current_user is the calling
-- role, and the owner roles postgres/supabase_admin exempt (migrations,
-- seeds, fixtures, and the definer paths -- erasure's re-point, ON DELETE SET
-- NULL cascades, merges -- which all run as the table owner).
--   INSERT: created_by naming anyone but auth.uid() is REFUSED (23514); a
--           null/omitted one is stamped auth.uid(). created_at other than the
--           statement's now() (which is exactly what the column default
--           yields) is REFUSED; so the ordinary insert, which names neither or
--           names its own user, is unaffected.
--   UPDATE: created_by and created_at are immutable (23514).
-- ADDITIVE. No previously applied migration is edited.

create or replace function private.stamp_row_attribution()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.created_by is not null and new.created_by is distinct from (select auth.uid()) then
      raise exception '%: created_by is the signed-in user, not a client-chosen one', tg_table_name
        using errcode = '23514', hint = 'attribution_is_the_sessions';
    end if;
    if new.created_at is distinct from pg_catalog.now() then
      raise exception '%: created_at is the database''s clock, not the client''s', tg_table_name
        using errcode = '23514', hint = 'attribution_is_the_sessions';
    end if;
    new.created_by := (select auth.uid());
    new.created_at := pg_catalog.now();
    return new;
  end if;

  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception '%: created_by and created_at are fixed at insert', tg_table_name
      using errcode = '23514', hint = 'attribution_is_the_sessions';
  end if;
  return new;
end;
$$;

comment on function private.stamp_row_attribution() is
  'ATTRIBUTION IS THE SESSION''S (Phase 8 final review A, m1). BEFORE INSERT OR UPDATE on public.financial_entries, public.network_profiles and public.network_links. For every writer except the owner roles postgres/supabase_admin (migrations, seeds, fixtures, and definer paths such as the erasure re-point and ON DELETE SET NULL cascades): an INSERT naming a created_by other than auth.uid(), or a created_at other than now(), is refused 23514 (hint attribution_is_the_sessions), and created_by/created_at are then stamped from the session and the database clock; an UPDATE may change neither. SECURITY INVOKER on purpose: current_user must be the calling role for the owner exemption to mean anything (the born_pending pattern, 20261017000000).';

revoke all on function private.stamp_row_attribution()
  from public, anon, authenticated, service_role;

create trigger stamp_attribution
  before insert or update on public.financial_entries
  for each row execute function private.stamp_row_attribution();

create trigger stamp_attribution
  before insert or update on public.network_profiles
  for each row execute function private.stamp_row_attribution();

create trigger stamp_attribution
  before insert or update on public.network_links
  for each row execute function private.stamp_row_attribution();

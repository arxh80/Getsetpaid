-- /pay is a top-level route (invoices part 2 Task 5: the card-payment page an
-- invoice's recipient opens from a signed link), so its segment is a reserved
-- workspace slug (Q151; tests/unit/org/reserved-slugs.test.ts): a workspace
-- called `pay` would be shadowed by /pay/[token]. Rebuilt from the live
-- definition, which matched 20261104000000 exactly; the one change is the
-- 'pay' row. Existing rows are not rejected retroactively (20260923005000).
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
         ('pay'::text),
         ('set-password'::text),
         ('signup'::text),
         ('super'::text);
$$;

comment on function private.reserved_workspace_slugs() is
  'The static top-level route segments of the app (20260923005000, Q151; set-password added by 20261104000000, pay by 20261110002500): a workspace slug equal to one would be shadowed by that route. Asserted equal to the segments app/ defines by tests/unit/org/reserved-slugs.test.ts; mirrored by lib/org/reserved-slugs.ts. Enforced by private.organisations_slug_not_reserved().';

revoke all on function private.reserved_workspace_slugs() from public, anon, authenticated, service_role;

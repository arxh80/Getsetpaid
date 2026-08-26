-- Foundation phase: reference / lookup data.
--
-- WHY THIS IS A MIGRATION AND NOT supabase/seed.sql
--   seed.sql runs on `supabase db reset` only -- never on `supabase db push`.
--   roles, role_permissions and subscription_plans are not sample data, they
--   are load-bearing reference data that the permission engine reads at
--   runtime:
--     - organisation_memberships.role is FK-constrained to roles.key, so with
--       an empty roles table create_organisation() fails outright and NO ONE
--       can create an organisation at all;
--     - has_permission() joins role_permissions, so with that table empty it
--       returns false for every caller and every permission -- every gated
--       write in the product is dead;
--     - subscription_plans backs the logged-out pricing page and the
--       entitlement columns.
--   Left in seed.sql, a freshly pushed hosted project comes up with zero roles
--   and zero permissions and is non-functional in a way that looks like an
--   application bug. It belongs in migration history.
--
-- IDEMPOTENT ON PURPOSE
--   Every statement is `on conflict do nothing`, so this migration is safe to
--   re-run and safe to sit alongside a future migration that adds more roles
--   or permission keys. It deliberately does NOT update or delete existing
--   rows -- changing the meaning of an existing role or price is a separate,
--   explicit migration, not a silent side effect of re-running this one.

-- ---------------------------------------------------------------------------
-- roles
-- The fixed platform role catalogue (CLAUDE.md § Permissions).
--
-- Note there is no 'platform_superuser' row. Platform superuser status is NOT
-- an organisation role -- it lives in public.platform_admins, which carries no
-- organisation_id. See design note (i) in
-- 20260826154304_permission_engine_and_rls.sql for why.
-- ---------------------------------------------------------------------------
insert into public.roles (key, label) values
  ('owner',         'Owner'),
  ('admin',         'Admin'),
  ('manager',       'Manager'),
  ('booker',        'Booker'),
  ('venue_manager', 'Venue Manager'),
  ('finance',       'Finance'),
  ('marketing',     'Marketing'),
  ('standard_user', 'Standard User'),
  ('read_only',     'Read Only')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- role_permissions
-- Only the keys the Foundation phase actually enforces. Do not add speculative
-- keys -- later phases seed their own as they build the features that read
-- them.
--
--   manage_members      -> who may invite/edit/remove memberships
--   manage_organisation -> who may UPDATE the organisations row. This is a
--                          separate key from manage_members because
--                          organisations carries deleted_at: "any active
--                          member may update" would let a Read Only user
--                          soft-delete the tenant.
--
-- There is deliberately no manage_billing row. organisation_subscriptions IS
-- the entitlement record (plan_id drives crm_writes / finance_module /
-- storage_limit_gb) and no payment processor exists yet, so its write policies
-- gate on has_platform_permission() -- superuser only -- not on any org role.
-- Granting an org role 'manage_billing' here would be inert today, but it is
-- omitted rather than left lying around because re-pointing a future policy at
-- has_permission(org, 'manage_billing') would silently restore unpaid
-- self-upgrade to Pro.
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role_key, permission_key) values
  ('owner', 'manage_members'),
  ('admin', 'manage_members'),
  ('owner', 'manage_organisation'),
  ('admin', 'manage_organisation')
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- subscription_plans
-- Prices in minor units (pence), GBP only at MVP (CLAUDE.md § Subscription
-- tiers). custom_field_limit NULL means unlimited.
--   starter annual = £19 x 12 x 0.85 = £193.80/yr = 19380 minor (exact)
--   pro annual     = £39 x 12 x 0.85 = £397.80/yr = 39780 minor (exact)
-- These are exact integers already -- do not "simplify" them back to a rounded
-- £/12*0.85 approximation.
-- ---------------------------------------------------------------------------
insert into public.subscription_plans
  (key, price_monthly_minor, price_annual_minor, currency,
   crm_writes, network_publish, custom_field_limit, finance_module, storage_limit_gb)
values
  ('free',    0,    0,     'GBP', false, false, 0,    false, 0),
  ('starter', 1900, 19380, 'GBP', true,  true,  5,    false, 5),
  ('pro',     3900, 39780, 'GBP', true,  true,  null, true,  20)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- platform_admins is intentionally NOT seeded here.
-- There is no founder user id wired up yet, and an empty allowlist is the
-- correct, safe MVP state: nobody holds platform superuser access until a
-- later migration deliberately grants it to a real auth.users id.
-- ---------------------------------------------------------------------------

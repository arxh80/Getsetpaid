-- Local dev seed data for the Foundation phase schema
-- (supabase/migrations/20260826151656_foundation_schema.sql).
--
-- Values here are the resolved, exact figures from the Task 3 dispatch --
-- not the brief's rounded prose description. Do not "simplify" the annual
-- price figures back to a rounded £/12*0.85 approximation; they are exact
-- minor-unit integers already.

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------
insert into public.roles (key, label) values
  ('owner', 'Owner'),
  ('admin', 'Admin'),
  ('manager', 'Manager'),
  ('booker', 'Booker'),
  ('venue_manager', 'Venue Manager'),
  ('finance', 'Finance'),
  ('marketing', 'Marketing'),
  ('standard_user', 'Standard User'),
  ('read_only', 'Read Only'),
  ('platform_superuser', 'Platform Superuser');

-- ---------------------------------------------------------------------------
-- role_permissions
-- Seeded with only the permission keys later tasks (4/5) need to exercise
-- the permission engine. Do not add speculative keys here -- later phases
-- seed their own as they are built.
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role_key, permission_key) values
  ('owner', 'manage_members'),
  ('admin', 'manage_members'),
  ('owner', 'manage_billing'),
  ('platform_superuser', 'view_audit_log'),
  -- Added by Task 4. `organisations` carries deleted_at, so the UPDATE policy
  -- on it cannot be "any active member" -- that would let a Read Only user
  -- soft-delete the tenant. See design note (f) in
  -- migrations/20260826154304_permission_engine_and_rls.sql.
  ('owner', 'manage_organisation'),
  ('admin', 'manage_organisation'),
  -- Added by Task 4. organisation_subscriptions IS the entitlement record and
  -- no payment webhook exists yet, so writes are superuser-only until billing
  -- is integrated. Deliberately NOT granted to `owner`. See design note (g).
  ('platform_superuser', 'manage_billing');

-- ---------------------------------------------------------------------------
-- subscription_plans
-- Prices in minor units (pence), currency GBP.
--   starter annual = £19 x 12 x 0.85 = £193.80/yr = 19380 minor (exact)
--   pro annual     = £39 x 12 x 0.85 = £397.80/yr = 39780 minor (exact)
-- ---------------------------------------------------------------------------
insert into public.subscription_plans
  (key, price_monthly_minor, price_annual_minor, currency, crm_writes, network_publish, custom_field_limit, finance_module, storage_limit_gb)
values
  ('free',    0,    0,     'GBP', false, false, 0,    false, 0),
  ('starter', 1900, 19380, 'GBP', true,  true,  5,    false, 5),
  ('pro',     3900, 39780, 'GBP', true,  true,  null, true,  20);

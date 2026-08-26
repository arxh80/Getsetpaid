-- Foundation phase: core tables for auth profiles, tenancy, roles/permissions,
-- subscription plans and billing, and the platform audit trail.
--
-- Scope note: this migration creates tables only. It deliberately does NOT
-- enable Row Level Security and does NOT create the has_permission() /
-- create_organisation() helper functions -- those land in the next
-- (Task 4) migration, which depends on the tables created here.
--
-- gen_random_uuid() lives in pgcrypto. Supabase's local/hosted Postgres
-- image already provisions this extension in the `extensions` schema (see
-- `extra_search_path` in supabase/config.toml), but this is the first
-- migration in the project, so enable it explicitly and idempotently here
-- rather than relying on platform defaults.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- profiles
-- Public-schema mirror of auth.users, one row per authenticated user.
-- id is *not* a generated UUID: it is the user's auth.uid(), so this table
-- keys directly off auth.users instead of having its own surrogate key.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Public-facing user profile, one row per auth.users row (id = auth.uid()).';

-- ---------------------------------------------------------------------------
-- organisations
-- The tenant. Deletion is soft-delete only (deleted_at), per product policy.
-- ---------------------------------------------------------------------------
create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.organisations is
  'Tenant record. deleted_at is a soft-delete marker -- rows are never hard-deleted by the application.';

-- ---------------------------------------------------------------------------
-- roles
-- Static, seeded lookup of the platform's fixed role set.
-- ---------------------------------------------------------------------------
create table public.roles (
  key text primary key,
  label text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.roles is
  'Fixed platform role catalogue (owner, admin, manager, ... platform_superuser). Seeded, not user-editable.';

-- ---------------------------------------------------------------------------
-- organisation_memberships
-- The join between a user and an organisation, carrying their role and
-- invite lifecycle status within that org.
-- ---------------------------------------------------------------------------
create table public.organisation_memberships (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null references public.roles (key),
  status text not null check (status in ('invited', 'active', 'revoked')),
  invited_by uuid references auth.users (id) on delete set null,
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organisation_memberships_org_user_unique unique (organisation_id, user_id)
);

comment on table public.organisation_memberships is
  'Membership of a user in an organisation: role, invite status, and invite lifecycle timestamps.';

-- The unique constraint above creates a composite index on
-- (organisation_id, user_id), which already covers lookups by
-- organisation_id alone (its leading column) -- no separate index needed
-- for that FK. user_id, role and invited_by each need their own index
-- since none of them is a leading column of any other index.
create index organisation_memberships_user_id_idx
  on public.organisation_memberships (user_id);
create index organisation_memberships_role_idx
  on public.organisation_memberships (role);
create index organisation_memberships_invited_by_idx
  on public.organisation_memberships (invited_by);

-- ---------------------------------------------------------------------------
-- role_permissions
-- Which permission keys a given role grants. Permission keys are free-text
-- at this stage (no separate permissions catalogue table exists yet) and
-- are seeded incrementally as later phases need them.
-- ---------------------------------------------------------------------------
create table public.role_permissions (
  role_key text not null references public.roles (key) on delete cascade,
  permission_key text not null,
  created_at timestamptz not null default now(),
  primary key (role_key, permission_key)
);

comment on table public.role_permissions is
  'Grants a permission_key to a role_key. permission_key has no catalogue table yet; keys are added incrementally as features need them.';

-- role_key is already indexed as the leading column of the composite
-- primary key above; no separate index required for that FK.

-- ---------------------------------------------------------------------------
-- subscription_plans
-- Static, seeded catalogue of the platform's pricing tiers.
-- ---------------------------------------------------------------------------
create table public.subscription_plans (
  key text primary key,
  price_monthly_minor integer not null check (price_monthly_minor >= 0),
  price_annual_minor integer not null check (price_annual_minor >= 0),
  currency text not null default 'GBP',
  crm_writes boolean not null,
  network_publish boolean not null,
  custom_field_limit integer,
  finance_module boolean not null,
  storage_limit_gb integer not null check (storage_limit_gb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subscription_plans is
  'Pricing/entitlement catalogue (free/starter/pro). Prices are in minor units (pence), currency GBP only at MVP. custom_field_limit NULL means unlimited.';

-- ---------------------------------------------------------------------------
-- organisation_subscriptions
-- One active subscription record per organisation.
-- ---------------------------------------------------------------------------
create table public.organisation_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null unique references public.organisations (id) on delete cascade,
  plan_id text not null references public.subscription_plans (key),
  billing_cycle text not null check (billing_cycle in ('monthly', 'annual')),
  seat_count integer not null check (seat_count >= 1),
  status text not null check (status in ('active', 'past_due', 'cancelled')),
  comp_expires_at timestamptz,
  current_period_end timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.organisation_subscriptions is
  'One subscription row per organisation (organisation_id is unique). comp_expires_at is set for time-boxed superuser billing overrides/comps, which must auto-revert -- never a silent permanent edit.';

-- organisation_id is already indexed via its unique constraint above.
create index organisation_subscriptions_plan_id_idx
  on public.organisation_subscriptions (plan_id);

-- ---------------------------------------------------------------------------
-- audit_events
-- Append-only platform audit trail. No updated_at: rows are never mutated
-- by the application once written.
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid references public.organisations (id) on delete set null,
  actor_user_id uuid not null references auth.users (id),
  action text not null,
  target_type text not null,
  target_id uuid,
  correlation_id uuid not null,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_events is
  'Append-only audit trail. actor_user_id intentionally has no ON DELETE cascade/set-null: audit records must survive an actor account being removed, so a hard delete of auth.users is blocked while audit history references it -- account erasure/anonymisation flows must account for this.';

create index audit_events_organisation_id_idx
  on public.audit_events (organisation_id);
create index audit_events_actor_user_id_idx
  on public.audit_events (actor_user_id);
-- Not FK-backed, but the audit log viewer (SECURITY.md / CLAUDE.md
-- "Superuser dashboard") is required to filter by actor, action type,
-- and date range, and to look events up by correlation_id -- index those
-- access patterns explicitly.
create index audit_events_action_idx
  on public.audit_events (action);
create index audit_events_correlation_id_idx
  on public.audit_events (correlation_id);
create index audit_events_created_at_idx
  on public.audit_events (created_at);

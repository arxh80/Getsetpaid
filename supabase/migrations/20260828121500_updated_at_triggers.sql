-- Phase 2 (Core CRM), Task 2d: `updated_at` is maintained by the database,
-- on all seventeen tables in `public` that carry the column.
--
-- ===========================================================================
-- THE DECISION THIS FILE IS
-- ===========================================================================
-- FOLLOW-UPS.md § "Phase 2 — Core CRM" routes one decision to this task and
-- states the evidence, which was re-measured before writing this migration
-- rather than taken on trust:
--
--   * 17 of the 21 tables in `public` carry `updated_at`. The four that do not
--     are audit_events and merges (deliberately -- both are append-only, and
--     `created_at` / `merged_at` IS the creation time), plus platform_admins
--     and role_permissions.
--   * `pg_trigger` had no non-internal trigger anywhere in `public`.
--   * The only write to the column in the entire codebase was
--     accept_invite()'s `update public.organisation_memberships ... set
--     updated_at = pg_catalog.now()` (20260827015924:272) -- one table, one of
--     that table's write paths.
--
-- So the column was not uniformly unmaintained, which would at least be
-- honest. It was maintained on one table along one path and equal to
-- `created_at` forever everywhere else, INCLUDING Foundation's -- a consumer
-- reading the schema would reasonably conclude the column works.
--
-- ===========================================================================
-- WHY A TRIGGER, AND WHY ALL SEVENTEEN AT ONCE
-- ===========================================================================
-- The argument that decides it is SECURITY.md § 4's own, about a different
-- control: the anon key ships in the browser bundle by design, so anyone
-- holding a session token can `PATCH /rest/v1/contacts?id=eq...` straight at
-- PostgREST and never touch a line of application code. An app-maintained
-- `updated_at` is therefore not maintained -- it is maintained on the paths
-- someone remembered, which is precisely the state this migration is fixing.
-- The database is the only chokepoint on that path. That is the same reasoning
-- that put the MFA gate into has_permission() instead of leaving it in
-- lib/auth/mfa-gate.ts, and it applies unchanged here.
--
-- A SECOND, SMALLER REASON, and it is a security one rather than a tidiness
-- one: `updated_at` is client-writable today. Every table below grants UPDATE
-- to `authenticated`, no policy constrains which columns an UPDATE may touch,
-- and PostgREST will happily send `updated_at` in the body. A client can
-- therefore back-date or future-date a record's modification time -- which
-- matters the moment anything reads the column to decide "what changed since
-- my last sync", to sort an activity feed, or to answer a retention question.
-- A BEFORE UPDATE trigger overwrites whatever arrived, so the value is the
-- database's rather than the caller's. Asserted by rls_phase2_crm.sql L3/L4,
-- which forges a timestamp ten years out and watches it get discarded.
--
-- ALL SEVENTEEN, not the twelve new ones. Task 1 deliberately did not add
-- triggers to only its own tables, on the grounds that twelve auto-maintained
-- tables beside five that are not is worse for a reader than either extreme,
-- and routed the whole decision here. Splitting it now would reproduce exactly
-- the half-maintained state the follow-up exists to end. The four tables
-- without the column are not given one: adding `updated_at` to audit_events or
-- merges would contradict their append-only design, and the follow-up warns
-- specifically against applying a blanket "all 21" reading literally.
--
-- ===========================================================================
-- WHAT WAS CONSIDERED AND REJECTED
-- ===========================================================================
-- (1) Keep it application-maintained, as Foundation chose. Rejected on the
--     PostgREST argument above. Foundation's choice was made when there was
--     one write path in the product; there are now twelve tables of them, and
--     Tasks 3-7 will add the code that writes to all of them.
--
-- (2) An event trigger that attaches this automatically to future tables.
--     Rejected, and it stays rejected: Task 1's I6 records the reason -- a DDL
--     event trigger fires inside migrations AND inside Supabase's own platform
--     upgrades, so a bug in it fails every future deploy. Phase 3 and beyond
--     must add the trigger by hand alongside each new table. Assertion L5 in
--     rls_phase2_crm.sql fails the moment a table with `updated_at` has no
--     trigger, which is the reminder.
--
-- (3) `moddatetime` from the `extensions` schema. It does exactly this and is
--     available. Rejected because it is one more extension in the trust
--     boundary for four lines of plpgsql, and because a locally-defined
--     function can carry this comment.
--
-- ===========================================================================
-- THE `WHEN` CLAUSE IS LOAD-BEARING
-- ===========================================================================
-- `when (old.* is distinct from new.*)` means a no-op UPDATE -- the same row
-- written back unchanged, which is what an idempotent retry or a form save with
-- no edits produces -- does not move the timestamp. Without it, "last modified"
-- would drift on every save button press whether or not anything changed,
-- which makes the column useless for the sync/feed cases that justify it.
--
-- It does NOT create a hole for the forgery case: an UPDATE that sends only a
-- doctored `updated_at` HAS changed the row as far as `old.* is distinct from
-- new.*` is concerned, so the trigger fires and overwrites it.

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

comment on function private.set_updated_at() is
  'BEFORE UPDATE trigger: forces updated_at to the transaction timestamp, discarding any client-supplied value. Attached to every table in public that carries the column (17 as of Phase 2). Lives in `private` with the other policy-adjacent helpers; it returns `trigger` so it is not callable as an RPC in any case. SECURITY INVOKER -- it touches no table and needs no privilege.';

revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;
grant execute on function private.set_updated_at() to authenticated;

-- ---------------------------------------------------------------------------
-- Attachment. Listed one per line rather than generated by a DO block, so the
-- set is greppable and a table added without one is visible in a diff.
--
-- `create trigger` has no `if not exists` before Postgres 18, and this project
-- pins 17 (supabase/config.toml, major_version = 17), so each is preceded by a
-- drop to keep the migration re-runnable in the same shape as the rest of the
-- repo's idempotent statements.
-- ---------------------------------------------------------------------------

-- Foundation's five (organisations was measured as unmaintained too; this is
-- not a Phase 2 regression being papered over, it is the pre-existing defect
-- being fixed in the same change).
drop trigger if exists set_updated_at on public.profiles;
create trigger set_updated_at before update on public.profiles
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.organisations;
create trigger set_updated_at before update on public.organisations
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- accept_invite() already sets this column explicitly on one path. The trigger
-- writes the same pg_catalog.now(), so the explicit assignment is now
-- redundant rather than wrong; it is left in place because removing it would
-- mean editing an applied migration.
drop trigger if exists set_updated_at on public.organisation_memberships;
create trigger set_updated_at before update on public.organisation_memberships
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.organisation_subscriptions;
create trigger set_updated_at before update on public.organisation_subscriptions
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- Reference data. These change by migration only, and that is exactly when the
-- timestamp SHOULD move -- "when did this plan's price last change" is a real
-- question with a real answer.
drop trigger if exists set_updated_at on public.roles;
create trigger set_updated_at before update on public.roles
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.subscription_plans;
create trigger set_updated_at before update on public.subscription_plans
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- Phase 2's twelve, minus merges (append-only, no column).
drop trigger if exists set_updated_at on public.companies;
create trigger set_updated_at before update on public.companies
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.contacts;
create trigger set_updated_at before update on public.contacts
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.contact_companies;
create trigger set_updated_at before update on public.contact_companies
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.agencies;
create trigger set_updated_at before update on public.agencies
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.artists;
create trigger set_updated_at before update on public.artists
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.artist_representations;
create trigger set_updated_at before update on public.artist_representations
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.artist_fee_history;
create trigger set_updated_at before update on public.artist_fee_history
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.venues;
create trigger set_updated_at before update on public.venues
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.venue_rooms;
create trigger set_updated_at before update on public.venue_rooms
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.custom_field_definitions;
create trigger set_updated_at before update on public.custom_field_definitions
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.custom_field_values;
create trigger set_updated_at before update on public.custom_field_values
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

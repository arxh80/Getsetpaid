-- Phase 3 (Events), Task 1 fix round 1: a venue with rooms could not be
-- hard-deleted if an event named both.
--
-- ===========================================================================
-- THE DEFECT (measured, not theorised)
-- ===========================================================================
-- 20260901000000 shipped two things that are each correct and that fight each
-- other on one path:
--
--   events_room_needs_a_venue   check (venue_room_id is null or venue_id is not null)
--   events_venue_fkey           ... on delete set null (venue_id)
--
-- Delete a venue that an event names TOGETHER WITH one of that venue's rooms
-- and the referential action nulls `venue_id` while `venue_room_id` is still
-- set. A row-level CHECK is evaluated immediately, not at end of statement, so
-- it fires on the intermediate row:
--
--   ERROR:  new row for relation "events" violates check constraint
--           "events_room_needs_a_venue"
--   CONTEXT: SQL statement "UPDATE ONLY "public"."events"
--            SET "venue_id" = NULL WHERE $1 = "venue_id" AND $2 = "organisation_id""
--
-- Reproduced on this stack in a rolled-back transaction. Both actions WANT to
-- happen -- the venue's SET NULL on venue_id, and (via the venue_rooms cascade)
-- events_venue_room_fkey's SET NULL on venue_room_id -- and the end state they
-- would jointly produce is legal. It is purely an ORDERING failure, and the
-- order of referential actions within one statement is not something a schema
-- gets to specify.
--
-- BOUNDING, also measured, so nobody reads this as a live incident:
--   * deleting the ROOM alone is fine -- venue_id stays, venue_room_id nulls;
--   * `delete from public.organisations` cascades cleanly, because events go
--     through their own organisation_id FK rather than through the venue;
--   * `authenticated` holds no DELETE grant on public.venues, so today the
--     failing path is reachable only by the table owner, service_role or a DBA.
-- Soft delete is the only delete the product performs. But Phase 7's
-- organisation deletion and DSR erasure are hard deletes by definition, and a
-- constraint that makes a row undeletable is exactly the kind of thing that is
-- discovered at 2am rather than in a migration.
--
-- ===========================================================================
-- WHAT WAS TRIED AND WHAT POSTGRES REFUSED
-- ===========================================================================
-- The obvious fix is to widen the SET NULL column list so the venue's own
-- referential action clears both columns at once:
--
--   on delete set null (venue_id, venue_room_id)
--
-- MEASURED: Postgres rejects it outright.
--
--   ERROR:  column "venue_room_id" referenced in ON DELETE SET action
--           must be part of foreign key
--
-- The column list must be a SUBSET of the constraint's own referencing
-- columns, and events_venue_fkey references (venue_id, organisation_id).
-- So the two-column form is not available, and this is recorded here because
-- it is the first thing the next reader will reach for.
--
-- Also rejected:
--   * `on delete no action` on events_venue_fkey -- deleting a referenced
--     venue would then fail with 23503 instead of 23514. Strictly worse: it
--     breaks the room-less case too, which works today (E4/E5).
--   * Relaxing events_room_needs_a_venue to permit a room without a venue.
--     That is the invariant, not the obstacle -- a room id with no venue id is
--     a dangling reference the FK cannot see, because MATCH SIMPLE skips the
--     check as soon as any referencing column is NULL.
--   * A DEFERRABLE CHECK. Postgres has no such thing; only unique/exclusion
--     and foreign-key constraints can be deferred.
--   * A `before delete` trigger on public.venue_rooms instead of on venues.
--     The room is itself deleted by a cascade from the venue, so this would
--     put the repair back inside the same statement whose action order is the
--     problem. It has to happen BEFORE the delete on venues, not during it.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
-- A BEFORE DELETE row trigger on public.venues that clears venue_room_id on
-- every event naming that venue. BEFORE-DELETE row triggers on the referenced
-- table run before any referential action the delete causes, so the ordering
-- is guaranteed by the executor rather than hoped for: by the time
-- events_venue_fkey's SET NULL touches the row, venue_room_id is already NULL
-- and events_room_needs_a_venue is satisfied.
--
-- It leaves venue_id alone. The foreign key is still what nulls that, so the
-- referential action remains the single source of truth for the tenant-scoped
-- half and this trigger only removes the obstacle in front of it.
--
-- SECURITY DEFINER, deliberately. The alternative would evaluate the UPDATE
-- under the deleting caller's own RLS, and a partially-applied repair -- some
-- events cleared, others filtered out by a record-scope policy -- would leave
-- exactly the dangling state this exists to prevent, and the delete would then
-- fail with the CHECK for a reason the caller cannot act on. There is no
-- widening of authority in it: events_venue_fkey is tenant-scoped, so every
-- event that can name this venue is in this venue's organisation by
-- construction, and the caller was authorised to delete the venue those events
-- point at.
-- ===========================================================================

create or replace function private.clear_event_room_before_venue_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.events e
     set venue_room_id = null
   where e.organisation_id = old.organisation_id
     and e.venue_id = old.id
     and e.venue_room_id is not null;
  return old;
end;
$$;

comment on function private.clear_event_room_before_venue_delete() is
  'BEFORE DELETE on public.venues: clears events.venue_room_id for every event naming the venue about to be deleted. Exists because events_venue_fkey''s `on delete set null (venue_id)` and the row-level CHECK events_room_needs_a_venue fight on that path -- the action nulls venue_id while venue_room_id is still set, and the CHECK fires on the intermediate row (23514, measured). The two-column SET NULL list that would fix it in the constraint is refused by Postgres: the column list must be a subset of the foreign key''s own referencing columns. A BEFORE DELETE row trigger on the REFERENCED table is guaranteed to run before any referential action the delete causes, which is the ordering the constraint layer cannot express. SECURITY DEFINER so the repair cannot be partially applied by the caller''s RLS -- it grants nothing, because the composite FK already guarantees every affected event is in this venue''s organisation. It does NOT touch venue_id; the foreign key remains the only thing that nulls that.';

revoke all on function private.clear_event_room_before_venue_delete()
  from public, anon, authenticated, service_role;
grant execute on function private.clear_event_room_before_venue_delete() to authenticated;

-- `create trigger` has no `if not exists` before Postgres 18 and this project
-- pins 17, so the drop keeps the migration re-runnable in the same shape as
-- 20260828121500's attachments.
--
-- NOT named `set_updated_at`: rls_phase2_crm.sql L5/L6 count triggers by that
-- exact name, and this is a different mechanism that happens to live on the
-- same table. L6's expected count stays at 20.
drop trigger if exists clear_event_room_before_delete on public.venues;
create trigger clear_event_room_before_delete
  before delete on public.venues
  for each row
  execute function private.clear_event_room_before_venue_delete();

comment on constraint events_room_needs_a_venue on public.events is
  'A room without a venue is not a location, it is a dangling id -- and it is one no foreign key can catch, because MATCH SIMPLE skips events_venue_room_fkey entirely once any referencing column is NULL. THIS CHECK IS EVALUATED PER ROW, IMMEDIATELY, WHICH IS WHY DELETING A VENUE NEEDS A TRIGGER: events_venue_fkey''s `on delete set null (venue_id)` would otherwise produce an intermediate row with a room and no venue and raise 23514. private.clear_event_room_before_venue_delete() (20260901002000) clears the room first. Pairs with events_venue_room_fkey, which additionally requires the room to belong to THIS event''s venue and to this tenant.';

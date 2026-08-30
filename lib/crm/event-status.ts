// THE TWO EVENT VOCABULARIES, AND NOTHING ELSE.
//
// `events_status_check` and `events_event_type_check`
// (supabase/migrations/20260901000000_events_and_lineup.sql) are the
// enforcement -- a value outside either set is a 23514 at write time, for
// every writer including one that reaches PostgREST directly. These constants
// exist because a request cannot consult a CHECK constraint: the create/edit
// form has to render a <select>, and `?status=` filtering has to validate its
// input, before any statement runs.
//
// BOUND TO THE DATABASE, NOT TRUSTED:
// tests/integration/crm/event-vocabularies-match-db.test.ts reads both CHECK
// definitions out of pg_constraint and asserts each set equals the tuple
// below. Adding a value in a migration without adding it here turns that test
// red naming this file, and adding it here without the migration turns it red
// the other way. Same treatment as CUSTOM_FIELD_ENTITY_TYPES, the tier table,
// MFA_REQUIRED_ROLES and PAST_DUE_GRACE_DAYS.
//
// DELIBERATELY DATA ONLY -- no labels, no tones, no React. Phase 3 Task 3 owns
// the presentation layer (chip tones, the human labels, the filter copy) and
// adds it to this file. Splitting the constants out here means they ship in
// the same change as the CHECK constraint that defines them, which is the
// point: the migration and its mirror are one commit, and the UI that renders
// them is another.
//
// THE ORDER IS THE MIGRATION'S ORDER, and it is meaningful in both cases --
// `status` runs roughly draft -> live -> finished, and a <select> rendered in
// that order reads as a lifecycle. The test sorts before comparing, because
// what has to match is the SET; the order is this file's to choose.

/**
 * The eight event statuses. PRD § 6.5 verbatim.
 *
 * `hold` and `confirmed` are LABELS ON A ROW, not the offers/holds/contracts
 * workflow, which is explicitly out of MVP scope (CLAUDE.md § Scope
 * discipline). Nothing may key a state machine off them at MVP.
 */
export const EVENT_STATUSES = [
  "draft",
  "planned",
  "hold",
  "confirmed",
  "on_sale",
  "sold_out",
  "completed",
  "cancelled",
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * The six event types.
 *
 * PRD § 6.5's baseline is "club night, rave, tour date; extensible";
 * `festival` and `private_hire` are added and `other` is the default, so a
 * user is never forced to mis-file an event. "Extensible" at MVP means a value
 * added in a migration -- not a per-tenant, user-editable vocabulary, which is
 * a feature nobody asked for and a second RLS surface.
 */
export const EVENT_TYPES = [
  "club_night",
  "rave",
  "tour_date",
  "festival",
  "private_hire",
  "other",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

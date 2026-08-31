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
// tests/integration/crm/event-vocabularies-match-db.test.ts reads all four
// CHECK definitions -- `events_status_check`, `events_event_type_check`,
// `event_status_changes_to_status_check` and
// `event_status_changes_from_status_check` (the latter two added by Phase 3
// Task 6, supabase/migrations/20260901031000_event_status_changes.sql) -- out
// of pg_constraint and asserts each set equals the tuple below. Adding a
// value in a migration without adding it here turns that test red naming
// this file, and adding it here without the migration turns it red the other
// way. Same treatment as CUSTOM_FIELD_ENTITY_TYPES, the tier table,
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

// ===========================================================================
// THE PRESENTATION LAYER, ADDED BY PHASE 3 TASK 3
// ===========================================================================
// The header above says this file is "DELIBERATELY DATA ONLY -- no labels, no
// tones, no React. Phase 3 Task 3 owns the presentation layer ... and adds it
// to this file." This is that addition, and the promise it kept is that the
// constants and their labels ship in one module: the status FILTER's choices
// (lib/crm/events-list.ts), the status CHIP (components/crm/status-chip.tsx)
// and, from Task 4, the create/edit form's <select> all read the same three
// records rather than each writing out eight strings.
//
// STILL NO REACT HERE. `STATUS_TONE` names a tone, not a class; the chip maps
// tone -> Tailwind token. That keeps this module importable from a Server
// Component, a Client Component and a vitest file alike, and it keeps
// DESIGN.md's token contract in one component rather than in a data table.
//
// EVERY ONE IS A `Record` KEYED ON THE UNION, WHICH IS THE POINT. Add a ninth
// status to the CHECK constraint and to `EVENT_STATUSES` and TypeScript makes
// the missing label and the missing tone compile errors here, at the
// definition, rather than `undefined` rendering as an empty chip in a browser
// nobody opened. tests/unit/crm/event-status.test.ts adds the runtime half
// (non-empty values, and the key COUNTS -- 8, 6, 8 -- as the denominator,
// because a `Record` type assertion passes vacuously against `{}` once
// something casts).

/**
 * The eight statuses as a human reads them.
 *
 * Sentence case, not Title Case: these appear inside a filter's option list
 * and inside a chip, and DESIGN.md's voice is plain. `on_sale` is "On sale"
 * rather than "On Sale" for the same reason.
 */
export const STATUS_LABELS: Record<EventStatus, string> = {
  draft: "Draft",
  planned: "Planned",
  hold: "Hold",
  confirmed: "Confirmed",
  on_sale: "On sale",
  sold_out: "Sold out",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** The six types as a human reads them. */
export const TYPE_LABELS: Record<EventType, string> = {
  club_night: "Club night",
  rave: "Rave",
  tour_date: "Tour date",
  festival: "Festival",
  private_hire: "Private hire",
  other: "Other",
};

/**
 * The tone a status carries, as a NAME rather than a colour.
 *
 * Four tones over eight statuses, and the collisions are deliberate:
 *
 *   muted     draft, completed    -- nothing to do. One has not started being
 *                                   real yet and the other has stopped being
 *                                   urgent; neither wants the eye.
 *   ink       planned             -- real, in the diary, not yet committed.
 *   warning   hold                -- SOMEBODY IS WAITING. A hold is the one
 *                                   status with a clock on it.
 *   success   confirmed, on_sale,
 *             sold_out            -- the booking happened. `sold_out` is a
 *                                   success and not a warning: a promoter
 *                                   selling out is the good outcome, and the
 *                                   thing a warning tone would imply (act now)
 *                                   is false.
 *   danger    cancelled           -- the only one.
 *
 * NEVER COLOUR ALONE. DESIGN.md § Working palette: "Status must never be
 * colour-only -- always pair with a text label or shape." The chip renders
 * `STATUS_LABELS[status]` unconditionally, so the tone is redundant
 * reinforcement and the label is the information. That is also why this is a
 * five-value union rather than a hex: a tone with no token behind it does not
 * compile in the chip.
 */
export const STATUS_TONE: Record<EventStatus, EventStatusTone> = {
  draft: "muted",
  planned: "ink",
  hold: "warning",
  confirmed: "success",
  on_sale: "success",
  sold_out: "success",
  completed: "muted",
  cancelled: "danger",
};

export type EventStatusTone = "muted" | "ink" | "success" | "warning" | "danger";

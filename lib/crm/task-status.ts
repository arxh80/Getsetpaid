// THE FIVE OPERATIONS VOCABULARIES, AND NOTHING ELSE.
//
// `tasks_status_check`, `tasks_priority_check`, `meetings_status_check`,
// `notes_visibility_check` and `documents_scan_status_check`
// (supabase/migrations/20260902000000_operations_entities.sql and
// 20260902001000_documents_table.sql) are the enforcement -- a value outside
// any set is a 23514 at write time, for every writer including one that
// reaches PostgREST directly. These constants exist because a request cannot
// consult a CHECK constraint: the create/edit form's <select> and the filter
// inputs have to render and validate before any statement runs.
//
// BOUND TO THE DATABASE, NOT TRUSTED:
// tests/integration/crm/operations-vocabularies-match-db.test.ts reads all
// five CHECK definitions out of pg_constraint and asserts each set equals the
// tuple below. Adding a value in a migration without adding it here turns that
// test red naming this file, and adding it here without the migration turns it
// red the other way. Same treatment as EVENT_STATUSES, CUSTOM_FIELD_ENTITY_TYPES,
// the tier table, MFA_REQUIRED_ROLES and PAST_DUE_GRACE_DAYS.
//
// DELIBERATELY DATA ONLY -- no labels, no tones, no React. Phase 4 Task 3 owns
// the presentation layer (chip tones, human labels, filter copy) and adds it
// to this file, exactly as event-status.ts did. Splitting the constants out
// here means they ship in the same change as the CHECK constraints that define
// them; the UI that renders them is a later change.
//
// THE ORDER IS THE MIGRATION'S ORDER. `status` runs open -> finished and a
// <select> rendered in that order reads as a lifecycle; priority runs
// low -> urgent; scan_status runs pending -> a terminal verdict. The test
// sorts before comparing, because what has to match is the SET; the order is
// this file's to choose.

/**
 * The five task statuses. PRD § 6.6.
 *
 * `done` is the terminal success (the write path stamps tasks.completed_at
 * when a task reaches it, which drives the task_completed timeline branch);
 * `cancelled` is the terminal non-success. `blocked` is a live state, not a
 * finished one.
 */
export const TASK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The four task priorities, low to urgent. `normal` is the default. */
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * The four meeting statuses.
 *
 * `no_show` is distinct from `cancelled`: a meeting nobody attended still
 * happened in the diary and is worth a different label from one called off in
 * advance. `scheduled` is the default.
 */
export const MEETING_STATUSES = [
  "scheduled",
  "held",
  "cancelled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/**
 * The two note visibilities. PRD § 6.6's binary.
 *
 * `private` reaches only the author; `company` reaches every viewer in the
 * org. `company` is the default. A finer per-user ACL is Q44, deferred.
 */
export const NOTE_VISIBILITIES = ["private", "company"] as const;

export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

/**
 * The four document scan statuses. SECURITY.md § 6.
 *
 * A document starts `pending`; the malware scanner (Task 4) moves it to a
 * terminal verdict -- `clean`, `quarantined` or `error`. The download path
 * (Task 5) issues a signed URL only for `clean`. documents_scanned_at_iff_terminal
 * ties scanned_at to exactly the three terminal values.
 */
export const SCAN_STATUSES = [
  "pending",
  "clean",
  "quarantined",
  "error",
] as const;

export type ScanStatus = (typeof SCAN_STATUSES)[number];

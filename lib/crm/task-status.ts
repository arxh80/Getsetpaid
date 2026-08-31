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

// ===========================================================================
// PHASE 4 TASK 3: THE PRESENTATION LAYER
// ===========================================================================
// Labels and chip TONES for the four operations vocabularies, added to the
// same file as the constants they describe -- exactly as event-status.ts holds
// STATUS_LABELS/STATUS_TONE beside EVENT_STATUSES. Still NO REACT: a tone is a
// NAME, and the chip components (components/crm/task-status-chip.tsx,
// priority-chip.tsx) map the name to a DESIGN.md token. That keeps this module
// importable from a Server Component, a Client Component and a vitest file
// alike.
//
// EVERY MAP IS A `Record` KEYED ON ITS UNION, so a value added to the CHECK
// constraint and to the constant above makes the missing label and the missing
// tone a COMPILE error here rather than an empty chip in a browser nobody
// opened. tests/unit/crm/task-status.test.ts adds the runtime half (non-empty
// values, and the key COUNTS as the denominator -- a `Record` type passes
// vacuously against `{}` once something casts).
//
// NO NEW COLOUR TOKEN. Every tone below is one DESIGN.md already measured
// (`--accent` for borders, `--warning`, `--success`, `--danger`, `--rule` /
// `--ink-muted` for the neutral ones), so `python scripts/contrast.py` gains
// no row. The chips render the label unconditionally, so colour is never the
// only signal -- DESIGN.md § Working palette.

/**
 * The chip tones an operations status/priority can carry, as NAMES.
 *
 * `active` is the accent rail (open/in_progress work still to do) — an accent
 * BORDER with ink text, never accent text, which DESIGN.md forbids. `muted` is
 * the hairline-and-grey neutral. The other three are the measured status
 * tokens.
 */
export type OperationsTone =
  | "active"
  | "muted"
  | "success"
  | "warning"
  | "danger";

/** The five task statuses as a human reads them. Sentence case (DESIGN.md voice). */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

/**
 * The tone a task status carries.
 *
 *   active    open, in_progress  -- live work. The accent rail draws the eye
 *                                   to what is still to be done.
 *   warning   blocked            -- SOMEBODY IS WAITING on something else.
 *   success   done               -- finished, well.
 *   muted     cancelled          -- finished, not done. Nothing to act on.
 */
export const TASK_STATUS_TONE: Record<TaskStatus, OperationsTone> = {
  open: "active",
  in_progress: "active",
  blocked: "warning",
  done: "success",
  cancelled: "muted",
};

/** The four task priorities as a human reads them. */
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/**
 * The tone a priority carries.
 *
 * `low` and `normal` are both `muted` and the collision is deliberate: the
 * ordinary case wants no colour, and drawing the eye to "Normal" would spend
 * the reader's attention on the thing that needs none. `high` earns a warning,
 * `urgent` a danger — the two that should catch the eye down a list.
 */
export const TASK_PRIORITY_TONE: Record<TaskPriority, OperationsTone> = {
  low: "muted",
  normal: "muted",
  high: "warning",
  urgent: "danger",
};

/** The four meeting statuses as a human reads them. */
export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  scheduled: "Scheduled",
  held: "Held",
  cancelled: "Cancelled",
  no_show: "No show",
};

/**
 * The tone a meeting status carries.
 *
 *   active    scheduled  -- in the diary, still to happen.
 *   success   held       -- it happened.
 *   muted     cancelled  -- called off in advance.
 *   warning   no_show    -- it was in the diary and nobody came; worth the eye.
 */
export const MEETING_STATUS_TONE: Record<MeetingStatus, OperationsTone> = {
  scheduled: "active",
  held: "success",
  cancelled: "muted",
  no_show: "warning",
};

/** The two note visibilities as a human reads them. */
export const NOTE_VISIBILITY_LABELS: Record<NoteVisibility, string> = {
  private: "Private",
  company: "Company",
};

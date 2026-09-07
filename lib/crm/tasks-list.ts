import { defineListSpec } from "@/lib/list/spec";
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  MEETING_STATUSES,
  MEETING_STATUS_LABELS,
  type MeetingStatus,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/crm/task-status";

// The Tasks and Meetings list specifications.
//
// Both are ordinary Phase 3 list surfaces (events-list.ts is the file to read
// beside this one) with two operations twists:
//
//   * THE TASK DEFAULT SORT IS `created_at`, NOT `due_at`. `due_at` is
//     NULLABLE -- a task need not have a due date -- and a nullable sort column
//     silently drops a contiguous band of rows out of the middle of a keyset
//     page (rule 9; lib/list/spec.ts's `notNull`). `due_at` is a FILTER here
//     (has due / overdue / none), never a sort. 20260902000000's column comment
//     states the same.
//   * THE MEETING DEFAULT SORT IS `starts_at`, which is NOT NULL by
//     declaration (it is the sort column) -- so it can be the default the way
//     events' `starts_at` is.

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * PostgREST select list for the tasks list. A literal, never assembled.
 *
 * `owner_user_id` for the "Mine" filter and the RLS record-scope term; it is in
 * the covering index INCLUDE and is not rendered. `detail` and `reminder_at`
 * are absent -- the list shows title/status/priority/due, and the rest is the
 * detail page's.
 */
export const TASK_SELECT =
  "id, title, status, priority, due_at, owner_user_id, created_at, updated_at";

export interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Nullable, and the reason it is not a sort. */
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function mapTaskRow(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    dueAt: (row.due_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const TASK_LIST = defineListSpec({
  entity: "tasks",
  noun: { one: "task", many: "tasks" },
  searchColumn: "title",
  searchLabel: "Search tasks by title",
  sort: {
    created: {
      column: "created_at",
      label: "Added",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      // NOT NULL by declaration. THE DEFAULT, chosen over `due_at` because that
      // column is nullable (rule 9): a task with no due date would drop out of
      // the middle of a keyset page. `due_at` is a filter below.
      notNull: true,
      backedBy: "tasks_org_created_at_id_live_idx",
    },
    title: {
      column: "title",
      label: "Title",
      defaultDirection: "asc",
      directionLabels: { asc: "A–Z", desc: "Z–A" },
      // NOT NULL, with a non-blank CHECK on top of it.
      notNull: true,
      backedBy: "tasks_org_title_id_live_idx",
    },
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "tasks_org_updated_at_id_live_idx",
    },
    // NOT `due_at`, AND IT IS THE TEMPTING ONE. It is nullable on purpose
    // (a task need not have a due date), so a keyset sort over it drops every
    // undated task out of the middle of the list with a 200 and the right
    // count. The `due` filter below interrogates it instead.
    // NOT `status`/`priority`: NOT NULL but no index of the required shape and
    // a text sort over a handful of values is a few big alphabetical blocks --
    // the status/priority FILTERS are how those columns are read.
  },
  defaultSort: "created",
  filters: {
    status: {
      label: "Status",
      choices: [
        { value: "any", label: "Any status" },
        ...TASK_STATUSES.map((status) => ({
          value: status,
          label: TASK_STATUS_LABELS[status],
        })),
      ],
    },
    priority: {
      label: "Priority",
      choices: [
        { value: "any", label: "Any priority" },
        ...TASK_PRIORITIES.map((priority) => ({
          value: priority,
          label: TASK_PRIORITY_LABELS[priority],
        })),
      ],
    },
    // THE DUE FILTER -- `due_at` as a filter, never a sort. The first choice
    // filters nothing (lib/list/spec.ts's rule). `overdue` needs the server's
    // clock, computed per request on the page exactly as events' `when` is.
    due: {
      label: "Due",
      choices: [
        { value: "all", label: "Any due date" },
        { value: "overdue", label: "Overdue" },
        { value: "has_due", label: "Has a due date" },
        { value: "none", label: "No due date" },
      ],
    },
    owner: {
      label: "Owner",
      choices: [
        { value: "anyone", label: "Anyone" },
        { value: "mine", label: "Mine" },
      ],
    },
  },
});

export type TaskSortKey = keyof (typeof TASK_LIST)["sort"];
export type TaskFilterKey = keyof (typeof TASK_LIST)["filters"];

export const TASK_DELETED_LIST = defineListSpec({
  entity: "tasks-deleted",
  noun: { one: "deleted task", many: "deleted tasks" },
  searchColumn: "title",
  searchLabel: "Search deleted tasks by title",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      // TRUE OF THE ROWS THIS LIST READS, not of the column. `scope: "deleted"`
      // writes `deleted_at is not null`, and tasks_org_deleted_at_id_idx is
      // partial on the same predicate, so no row this sort reaches has a NULL.
      notNull: true,
      backedBy: "tasks_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const TASK_DELETED_SELECT =
  "id, title, status, priority, owner_user_id, deleted_at";

export interface DeletedTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  deletedAt: string;
}

export function mapDeletedTaskRow(row: Record<string, unknown>): DeletedTaskRow {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    deletedAt: String(row.deleted_at),
  };
}

export type TaskDeletedSortKey = keyof (typeof TASK_DELETED_LIST)["sort"];
export type TaskDeletedFilterKey = keyof (typeof TASK_DELETED_LIST)["filters"];

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/**
 * PostgREST select list for the meetings list. A literal.
 *
 * `location`, `meeting_url`, `attendees`, `notes` are the detail page's, not a
 * table cell's. `ends_at` rides along for the detail page the way events'
 * `EVENT_SELECT` carries columns no list column renders.
 */
export const MEETING_SELECT =
  "id, title, starts_at, ends_at, status, owner_user_id, created_at, updated_at";

export interface MeetingRow {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  status: MeetingStatus;
  createdAt: string;
  updatedAt: string;
}

export function mapMeetingRow(row: Record<string, unknown>): MeetingRow {
  return {
    id: String(row.id),
    title: String(row.title),
    startsAt: String(row.starts_at),
    endsAt: (row.ends_at as string | null) ?? null,
    status: row.status as MeetingStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const MEETING_LIST = defineListSpec({
  entity: "meetings",
  noun: { one: "meeting", many: "meetings" },
  searchColumn: "title",
  searchLabel: "Search meetings by title",
  sort: {
    starts: {
      column: "starts_at",
      label: "When",
      // LATEST FIRST. A meetings list opened cold should show the most recent
      // thing that happened or is about to.
      defaultDirection: "desc",
      directionLabels: { asc: "earliest first", desc: "latest first" },
      // NOT NULL by declaration (20260902000000: it is the sort column).
      notNull: true,
      backedBy: "meetings_org_starts_at_id_live_idx",
    },
    title: {
      column: "title",
      label: "Title",
      defaultDirection: "asc",
      directionLabels: { asc: "A–Z", desc: "Z–A" },
      notNull: true,
      backedBy: "meetings_org_title_id_live_idx",
    },
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "meetings_org_updated_at_id_live_idx",
    },
    // NOT `ends_at`: nullable (a meeting need not have an announced finish), so
    // it cannot be a keyset sort for the same reason events' `ends_at` is not.
  },
  defaultSort: "starts",
  filters: {
    when: {
      // THE DEFAULT IS `all`. "Upcoming" is the tempting default and the wrong
      // one -- it would render the un-narrowed empty state over a diary full of
      // past meetings (the events list's `when` header carries the argument).
      label: "When",
      choices: [
        { value: "all", label: "All dates" },
        { value: "upcoming", label: "Upcoming" },
        { value: "past", label: "Past" },
      ],
    },
    status: {
      label: "Status",
      choices: [
        { value: "any", label: "Any status" },
        ...MEETING_STATUSES.map((status) => ({
          value: status,
          label: MEETING_STATUS_LABELS[status],
        })),
      ],
    },
    owner: {
      label: "Owner",
      choices: [
        { value: "anyone", label: "Anyone" },
        { value: "mine", label: "Mine" },
      ],
    },
  },
});

export type MeetingSortKey = keyof (typeof MEETING_LIST)["sort"];
export type MeetingFilterKey = keyof (typeof MEETING_LIST)["filters"];

export const MEETING_DELETED_LIST = defineListSpec({
  entity: "meetings-deleted",
  noun: { one: "deleted meeting", many: "deleted meetings" },
  searchColumn: "title",
  searchLabel: "Search deleted meetings by title",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      notNull: true,
      backedBy: "meetings_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const MEETING_DELETED_SELECT =
  "id, title, starts_at, status, owner_user_id, deleted_at";

export interface DeletedMeetingRow {
  id: string;
  title: string;
  startsAt: string;
  status: MeetingStatus;
  deletedAt: string;
}

export function mapDeletedMeetingRow(
  row: Record<string, unknown>,
): DeletedMeetingRow {
  return {
    id: String(row.id),
    title: String(row.title),
    startsAt: String(row.starts_at),
    status: row.status as MeetingStatus,
    deletedAt: String(row.deleted_at),
  };
}

export type MeetingDeletedSortKey = keyof (typeof MEETING_DELETED_LIST)["sort"];
export type MeetingDeletedFilterKey = keyof (typeof MEETING_DELETED_LIST)["filters"];

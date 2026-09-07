"use server";

// Tasks and meetings: create, edit, soft-delete, restore.
//
// BOTH ENTITIES SHARE THIS FILE because both are owned action items on the same
// key-shaped write path -- a task is `manage_tasks`, a meeting is
// `manage_meetings`, and everything else about the five-step shape is identical.
// The shape is lib/crm/events.ts's, with the plumbing imported from
// lib/crm/actions.ts:
//
//   parse + validate (pure)  ->  authoriseOrg  ->  (no FK ends here -- the
//   entity links are a separate write path, lib/crm/links.ts)  ->  writeRow via
//   commitWrite with { count: "exact" }  ->  revalidatePath.
//
// Every failure path returns `echoedValues(formData)` (React 19 resets a
// <form action>; a refusal with no `values` empties the user's work) --
// including the authorisation refusals, which `authoriseOrg` already echoes.
//
// ===========================================================================
// THE ONE TRANSITION WITH A SIDE EFFECT: status -> 'done'
// ===========================================================================
// `tasks.completed_at` is set to now() when a task reaches `done` and cleared
// when it leaves it. It drives the `task_completed` timeline branch in Task 7,
// so it is written by the ACTION rather than a trigger: the app decides "done"
// and the column records when. `completedAtFor` is the one-liner both create
// and update call, so the two cannot disagree.
//
// NO ENTITY-LINK WRITES HERE. A task's links to CRM records go through
// lib/crm/links.ts's addLinkAction/removeLinkAction, authorised on this same
// `manage_tasks` key. This file writes the task ROW only.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { authoriseOrg, stateFor } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { normaliseWebsite } from "@/lib/crm/urls";
import { londonWallClockToInstant } from "@/lib/format/date";
import type { FieldProblem } from "@/lib/crm/validate";
import {
  MEETING_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type MeetingStatus,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/crm/task-status";

const TASK_PERMISSION = "manage_tasks";
const MEETING_PERMISSION = "manage_meetings";

const MAX_TITLE = 200;
/** The running detail/notes -- a paragraph, capped like an event's notes. */
const MAX_LONG_TEXT = 5000;
/** "Zoom link" / "the back room, upstairs" -- a short place, not a paragraph. */
const MAX_LOCATION = 500;
/** A free-text attendee roster at MVP (Q46). People links go through meeting_links. */
const MAX_ATTENDEES = 2000;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

interface TaskValues {
  title: string;
  detail: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /** An ISO instant already resolved from the Europe/London wall clock, or null. */
  dueAt: string | null;
  reminderAt: string | null;
}

function isTaskStatus(v: string | null): v is TaskStatus {
  return v !== null && (TASK_STATUSES as readonly string[]).includes(v);
}
function isTaskPriority(v: string | null): v is TaskPriority {
  return v !== null && (TASK_PRIORITIES as readonly string[]).includes(v);
}

/** The instant status -> done stamps, or null. Shared by create and update. */
function completedAtFor(status: TaskStatus): string | null {
  return status === "done" ? new Date().toISOString() : null;
}

/** A datetime-local field as an ISO instant, or the field problem it earns. */
function readInstant(
  formData: FormData,
  name: string,
): { ok: true; value: string | null } | { ok: false; problem: FieldProblem } {
  const raw = field(formData, name);
  if (raw === null) return { ok: true, value: null };
  const instant = londonWallClockToInstant(raw);
  if (instant === null) {
    return {
      ok: false,
      problem: { field: name, message: "That doesn’t look like a date and time." },
    };
  }
  return { ok: true, value: instant };
}

function readTask(
  formData: FormData,
):
  | { readonly ok: true; readonly values: TaskValues }
  | { readonly ok: false; readonly state: FormState } {
  const title = field(formData, "title");
  const detail = field(formData, "detail");
  const status = field(formData, "status");
  const priority = field(formData, "priority");
  const problems: (FieldProblem | null)[] = [];

  if (title === null) {
    problems.push({ field: "title", message: "Give the task a title." });
  } else if (title.length > MAX_TITLE) {
    problems.push({
      field: "title",
      message: `That title is too long — ${MAX_TITLE} characters at most.`,
    });
  }
  if (detail !== null && detail.length > MAX_LONG_TEXT) {
    problems.push({
      field: "detail",
      message: `Those details are too long — ${MAX_LONG_TEXT.toLocaleString("en-GB")} characters at most.`,
    });
  }
  if (!isTaskStatus(status)) {
    problems.push({ field: "status", message: "Choose a status from the list." });
  }
  if (!isTaskPriority(priority)) {
    problems.push({ field: "priority", message: "Choose a priority from the list." });
  }

  const due = readInstant(formData, "dueAt");
  if (!due.ok) problems.push(due.problem);
  const reminder = readInstant(formData, "reminderAt");
  if (!reminder.ok) problems.push(reminder.problem);

  // `tasks_reminder_not_after_due`: the reminder cannot be after the due date.
  // The sentence lives here; the CHECK is the control.
  if (
    due.ok &&
    reminder.ok &&
    due.value !== null &&
    reminder.value !== null &&
    reminder.value > due.value
  ) {
    problems.push({
      field: "reminderAt",
      message: "The reminder has to be on or before the due date.",
    });
  }

  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    if (problem && !fieldErrors[problem.field]) fieldErrors[problem.field] = problem.message;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }
  return {
    ok: true,
    values: {
      title: title as string,
      detail,
      status: status as TaskStatus,
      priority: priority as TaskPriority,
      dueAt: due.ok ? due.value : null,
      reminderAt: reminder.ok ? reminder.value : null,
    },
  };
}

export async function createTaskAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, TASK_PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readTask(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      organisation_id: org.id,
      // Explicit, though the column defaults to auth.uid(): the record-scope
      // INSERT policy requires owner_user_id = auth.uid(), and relying on a
      // column default to satisfy a policy couples them silently.
      owner_user_id: user.id,
      title: parsed.values.title,
      detail: parsed.values.detail,
      status: parsed.values.status,
      priority: parsed.values.priority,
      due_at: parsed.values.dueAt,
      reminder_at: parsed.values.reminderAt,
      completed_at: completedAtFor(parsed.values.status),
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    console.error("[crm] create task failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!data) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  revalidatePath(`/${org.slug}/tasks`);
  redirect(`/${org.slug}/tasks/${data.id as string}`);
}

export async function updateTaskAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, TASK_PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const taskId = field(formData, "taskId");
  if (!taskId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const parsed = readTask(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  const result = await commitWrite(`update task ${taskId}`, () =>
    supabase
      .from("tasks")
      .update(
        {
          title: parsed.values.title,
          detail: parsed.values.detail,
          status: parsed.values.status,
          priority: parsed.values.priority,
          due_at: parsed.values.dueAt,
          reminder_at: parsed.values.reminderAt,
          // Recomputed every save: leaving `done` clears it, entering it stamps
          // now(). The task_completed timeline branch reads this column.
          completed_at: completedAtFor(parsed.values.status),
        },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", taskId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/tasks`);
    revalidatePath(`/${org.slug}/tasks/${taskId}`);
    redirect(`/${org.slug}/tasks/${taskId}`);
  }
  return stateFor(result, "Saved.", formData);
}

export async function deleteTaskAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, TASK_PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const taskId = field(formData, "taskId");
  if (!taskId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`delete task ${taskId}`, () =>
    supabase
      .from("tasks")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", taskId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/tasks`);
    revalidatePath(`/${org.slug}/tasks/deleted`);
    revalidatePath(`/${org.slug}/tasks/${taskId}`);
  }
  return stateFor(
    result,
    "Deleted. It is out of the tasks list; its links come back with it.",
    formData,
  );
}

export async function restoreTaskAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, TASK_PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const taskId = field(formData, "taskId");
  if (!taskId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`restore task ${taskId}`, () =>
    supabase
      .from("tasks")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", taskId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/tasks`);
    revalidatePath(`/${org.slug}/tasks/deleted`);
    revalidatePath(`/${org.slug}/tasks/${taskId}`);
  }
  return stateFor(result, "Restored. It is back in the tasks list.", formData);
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

interface MeetingValues {
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  meetingUrl: string | null;
  attendees: string | null;
  notes: string | null;
  status: MeetingStatus;
}

function isMeetingStatus(v: string | null): v is MeetingStatus {
  return v !== null && (MEETING_STATUSES as readonly string[]).includes(v);
}

function readMeeting(
  formData: FormData,
):
  | { readonly ok: true; readonly values: MeetingValues }
  | { readonly ok: false; readonly state: FormState } {
  const title = field(formData, "title");
  const location = field(formData, "location");
  const attendees = field(formData, "attendees");
  const notes = field(formData, "notes");
  const status = field(formData, "status");
  const problems: (FieldProblem | null)[] = [];

  if (title === null) {
    problems.push({ field: "title", message: "Give the meeting a title." });
  } else if (title.length > MAX_TITLE) {
    problems.push({
      field: "title",
      message: `That title is too long — ${MAX_TITLE} characters at most.`,
    });
  }

  // starts_at is REQUIRED because the column is NOT NULL (it is the sort).
  const startsRaw = field(formData, "startsAt");
  let startsAt: string | null = null;
  if (startsRaw === null) {
    problems.push({ field: "startsAt", message: "A meeting needs a date and a start time." });
  } else {
    startsAt = londonWallClockToInstant(startsRaw);
    if (startsAt === null) {
      problems.push({ field: "startsAt", message: "That doesn’t look like a date and time." });
    }
  }

  const endsRaw = field(formData, "endsAt");
  let endsAt: string | null = null;
  if (endsRaw !== null) {
    endsAt = londonWallClockToInstant(endsRaw);
    if (endsAt === null) {
      problems.push({ field: "endsAt", message: "That doesn’t look like a date and time." });
    } else if (startsAt !== null && endsAt <= startsAt) {
      // Strictly after, mirroring `meetings_ends_after_starts`.
      problems.push({ field: "endsAt", message: "The end time is before the start time." });
    }
  }

  if (!isMeetingStatus(status)) {
    problems.push({ field: "status", message: "Choose a status from the list." });
  }
  if (location !== null && location.length > MAX_LOCATION) {
    problems.push({
      field: "location",
      message: `That location is too long — ${MAX_LOCATION} characters at most.`,
    });
  }
  if (attendees !== null && attendees.length > MAX_ATTENDEES) {
    problems.push({
      field: "attendees",
      message: `That attendee list is too long — ${MAX_ATTENDEES.toLocaleString("en-GB")} characters at most.`,
    });
  }
  if (notes !== null && notes.length > MAX_LONG_TEXT) {
    problems.push({
      field: "notes",
      message: `Those notes are too long — ${MAX_LONG_TEXT.toLocaleString("en-GB")} characters at most.`,
    });
  }

  // The meeting link goes through the same normaliser as every `website`
  // column: a non-http(s) scheme is refused here and the inline
  // `meetings_meeting_url_check` CHECK is the defence in depth; `safeHref()` on
  // render is the real control.
  const link = normaliseWebsite(field(formData, "meetingUrl"));
  const meetingUrl = link.ok ? link.value : null;
  if (!link.ok) problems.push({ field: "meetingUrl", message: link.message });

  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    if (problem && !fieldErrors[problem.field]) fieldErrors[problem.field] = problem.message;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }
  return {
    ok: true,
    values: {
      title: title as string,
      startsAt: startsAt as string,
      endsAt,
      location,
      meetingUrl,
      attendees,
      notes,
      status: status as MeetingStatus,
    },
  };
}

export async function createMeetingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, MEETING_PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readMeeting(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("meetings")
    .insert({
      organisation_id: org.id,
      owner_user_id: user.id,
      title: parsed.values.title,
      starts_at: parsed.values.startsAt,
      ends_at: parsed.values.endsAt,
      location: parsed.values.location,
      meeting_url: parsed.values.meetingUrl,
      attendees: parsed.values.attendees,
      notes: parsed.values.notes,
      status: parsed.values.status,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    console.error("[crm] create meeting failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!data) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  revalidatePath(`/${org.slug}/meetings`);
  redirect(`/${org.slug}/meetings/${data.id as string}`);
}

export async function updateMeetingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, MEETING_PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const meetingId = field(formData, "meetingId");
  if (!meetingId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const parsed = readMeeting(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  const result = await commitWrite(`update meeting ${meetingId}`, () =>
    supabase
      .from("meetings")
      .update(
        {
          title: parsed.values.title,
          starts_at: parsed.values.startsAt,
          ends_at: parsed.values.endsAt,
          location: parsed.values.location,
          meeting_url: parsed.values.meetingUrl,
          attendees: parsed.values.attendees,
          notes: parsed.values.notes,
          status: parsed.values.status,
        },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", meetingId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/meetings`);
    revalidatePath(`/${org.slug}/meetings/${meetingId}`);
    redirect(`/${org.slug}/meetings/${meetingId}`);
  }
  return stateFor(result, "Saved.", formData);
}

export async function deleteMeetingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, MEETING_PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const meetingId = field(formData, "meetingId");
  if (!meetingId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`delete meeting ${meetingId}`, () =>
    supabase
      .from("meetings")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", meetingId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/meetings`);
    revalidatePath(`/${org.slug}/meetings/deleted`);
    revalidatePath(`/${org.slug}/meetings/${meetingId}`);
  }
  return stateFor(
    result,
    "Deleted. It is out of the meetings list; its links come back with it.",
    formData,
  );
}

export async function restoreMeetingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, MEETING_PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const meetingId = field(formData, "meetingId");
  if (!meetingId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`restore meeting ${meetingId}`, () =>
    supabase
      .from("meetings")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", meetingId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/meetings`);
    revalidatePath(`/${org.slug}/meetings/deleted`);
    revalidatePath(`/${org.slug}/meetings/${meetingId}`);
  }
  return stateFor(result, "Restored. It is back in the meetings list.", formData);
}

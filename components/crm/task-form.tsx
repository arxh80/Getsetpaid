"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createTaskAction, updateTaskAction } from "@/lib/crm/tasks";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
} from "@/lib/crm/task-status";
import { Field, SelectField, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Create / edit a task. One form, two actions, same shape as EventForm.
//
// UNCONTROLLED, so it works with JavaScript disabled: every input carries a
// `defaultValue` and nothing carries `value`, each reading `state.values?.<n>
// ?? values.<n>` so React 19's post-action reset restores the SUBMITTED values
// rather than blanks (lib/forms.ts's header has the measurement).
//
// THE SIX ECHOES ARE WRITTEN OUT ONE BY ONE, and the two `<select>`s carry a
// `key` as well as a `defaultValue` -- the exact reason EventForm's do: React
// syncs a text input's `defaultValue` on reset but NOT a `<select>`'s selected
// option, so without the key a refused submit snaps Status and Priority back to
// what they were at mount. The key forces a remount when the shown value
// changes (rule 11).
//
// DUE AND REMINDER ARE UK-LOCAL WALL CLOCKS, typed as UK local -- `datetime-local`
// submits a zone-less wall clock and `londonWallClockToInstant` interprets it as
// Europe/London on the server, exactly as the event form's start/end.

export interface TaskFormValues {
  id?: string;
  title: string;
  detail: string;
  status: string;
  priority: string;
  /** A Europe/London wall clock, `YYYY-MM-DDTHH:mm`, or "" for none. */
  dueAt: string;
  reminderAt: string;
}

export function TaskForm({
  orgSlug,
  values,
  cancelHref,
}: {
  orgSlug: string;
  values: TaskFormValues;
  cancelHref: string;
}) {
  const editing = values.id !== undefined;
  const [state, formAction, pending] = useActionState(
    editing ? updateTaskAction : createTaskAction,
    EMPTY_FORM_STATE,
  );

  const title = state.values?.title ?? values.title;
  const detail = state.values?.detail ?? values.detail;
  const status = state.values?.status ?? values.status;
  const priority = state.values?.priority ?? values.priority;
  const dueAt = state.values?.dueAt ?? values.dueAt;
  const reminderAt = state.values?.reminderAt ?? values.reminderAt;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      {editing ? <input type="hidden" name="taskId" value={values.id} /> : null}

      <div className="flex flex-col gap-5">
        <Field
          label="Title"
          name="title"
          defaultValue={title}
          autoComplete="off"
          required
          maxLength={200}
          hint="What needs doing. This is what every list and search matches on."
          error={state.fieldErrors?.title}
        />

        <SelectField
          key={`status:${status}`}
          label="Status"
          name="status"
          defaultValue={status}
          required
          hint="Where it has got to. “Done” stamps when it was finished."
          error={state.fieldErrors?.status}
        >
          {TASK_STATUSES.map((value) => (
            <option key={value} value={value}>
              {TASK_STATUS_LABELS[value]}
            </option>
          ))}
        </SelectField>

        <SelectField
          key={`priority:${priority}`}
          label="Priority"
          name="priority"
          defaultValue={priority}
          required
          hint="“Normal” is a complete answer — nothing here forces a task up the list."
          error={state.fieldErrors?.priority}
        >
          {TASK_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {TASK_PRIORITY_LABELS[value]}
            </option>
          ))}
        </SelectField>

        <Field
          label="Due"
          name="dueAt"
          type="datetime-local"
          defaultValue={dueAt}
          hint="UK time. Optional — a task need not have a due date."
          error={state.fieldErrors?.dueAt}
          className="tabular-nums"
        />

        <Field
          label="Reminder"
          name="reminderAt"
          type="datetime-local"
          defaultValue={reminderAt}
          hint="Stored for later. It has to be on or before the due date. (No reminder is sent yet.)"
          error={state.fieldErrors?.reminderAt}
          className="tabular-nums"
        />

        <TextAreaField
          label="Details"
          name="detail"
          defaultValue={detail}
          maxLength={5000}
          hint="Anything worth keeping with the task. Plain text."
          error={state.fieldErrors?.detail}
        />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          {editing ? "Save changes" : "Create task"}
        </Button>
        <Link
          href={cancelHref}
          className="text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

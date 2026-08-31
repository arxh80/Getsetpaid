"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createMeetingAction, updateMeetingAction } from "@/lib/crm/tasks";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { MEETING_STATUSES, MEETING_STATUS_LABELS } from "@/lib/crm/task-status";
import { Field, SelectField, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Create / edit a meeting. The task/meeting Server Actions share lib/crm/tasks.ts.
//
// UNCONTROLLED and JS-optional, the eight echoes written out, and the one
// `<select>` (Status) keyed for the reset reason EventForm's header states in
// full. Start/end are UK-local wall clocks typed as UK local. The meeting link
// goes through the same normaliser as every website column.

export interface MeetingFormValues {
  id?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  meetingUrl: string;
  attendees: string;
  notes: string;
  status: string;
}

export function MeetingForm({
  orgSlug,
  values,
  cancelHref,
}: {
  orgSlug: string;
  values: MeetingFormValues;
  cancelHref: string;
}) {
  const editing = values.id !== undefined;
  const [state, formAction, pending] = useActionState(
    editing ? updateMeetingAction : createMeetingAction,
    EMPTY_FORM_STATE,
  );

  const title = state.values?.title ?? values.title;
  const startsAt = state.values?.startsAt ?? values.startsAt;
  const endsAt = state.values?.endsAt ?? values.endsAt;
  const location = state.values?.location ?? values.location;
  const meetingUrl = state.values?.meetingUrl ?? values.meetingUrl;
  const attendees = state.values?.attendees ?? values.attendees;
  const notes = state.values?.notes ?? values.notes;
  const status = state.values?.status ?? values.status;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      {editing ? <input type="hidden" name="meetingId" value={values.id} /> : null}

      <div className="flex flex-col gap-5">
        <Field
          label="Title"
          name="title"
          defaultValue={title}
          autoComplete="off"
          required
          maxLength={200}
          hint="What the meeting is about. This is what every list and search matches on."
          error={state.fieldErrors?.title}
        />

        <Field
          label="Starts"
          name="startsAt"
          type="datetime-local"
          defaultValue={startsAt}
          required
          hint="UK time. A meeting needs a start."
          error={state.fieldErrors?.startsAt}
          className="tabular-nums"
        />

        <Field
          label="Ends"
          name="endsAt"
          type="datetime-local"
          defaultValue={endsAt}
          hint="Optional. It has to be after the start."
          error={state.fieldErrors?.endsAt}
          className="tabular-nums"
        />

        <SelectField
          key={`status:${status}`}
          label="Status"
          name="status"
          defaultValue={status}
          required
          hint="Scheduled, held, called off, or nobody came."
          error={state.fieldErrors?.status}
        >
          {MEETING_STATUSES.map((value) => (
            <option key={value} value={value}>
              {MEETING_STATUS_LABELS[value]}
            </option>
          ))}
        </SelectField>

        <Field
          label="Location"
          name="location"
          defaultValue={location}
          autoComplete="off"
          maxLength={500}
          hint="Free text — “the back room, upstairs”, or a room name."
          error={state.fieldErrors?.location}
        />

        <Field
          label="Meeting link"
          name="meetingUrl"
          type="url"
          defaultValue={meetingUrl}
          autoComplete="off"
          inputMode="url"
          hint="A video-call link, if there is one. Only http:// and https:// links are kept."
          error={state.fieldErrors?.meetingUrl}
        />

        <TextAreaField
          label="Attendees"
          name="attendees"
          defaultValue={attendees}
          maxLength={2000}
          hint="Who is coming. Free text at this stage — one per line reads well."
          error={state.fieldErrors?.attendees}
        />

        <TextAreaField
          label="Notes"
          name="notes"
          defaultValue={notes}
          maxLength={5000}
          hint="Agenda, outcomes, what was agreed. Plain text."
          error={state.fieldErrors?.notes}
        />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          {editing ? "Save changes" : "Create meeting"}
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

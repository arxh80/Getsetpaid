"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createNoteAction, updateNoteAction } from "@/lib/crm/notes";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { NOTE_VISIBILITIES, NOTE_VISIBILITY_LABELS } from "@/lib/crm/task-status";
import { SelectField, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Create / edit a note. Body plus a private/company visibility.
//
// UNCONTROLLED and JS-optional; the two echoes written out; the visibility
// `<select>` keyed for the reset reason EventForm's header states in full.
//
// VISIBILITY IS THE PRD's binary and it is enforced in the DATABASE
// (`notes_select_by_visibility`, 20260902011000): a `private` note reaches only
// its author. The hint says so plainly, because a user choosing "Private"
// should know it means "only me", not "only my team".
//
// THE BODY IS RENDERED AS TEXT, NEVER HTML. It is stored as sanitised
// markdown/plain (Q48) and every reader escapes it -- there is no
// `dangerouslySetInnerHTML` anywhere near a note (CLAUDE.md § Non-negotiable
// rules). This form only collects it.

export interface NoteFormValues {
  id?: string;
  body: string;
  visibility: string;
}

export function NoteForm({
  orgSlug,
  values,
  cancelHref,
}: {
  orgSlug: string;
  values: NoteFormValues;
  cancelHref: string;
}) {
  const editing = values.id !== undefined;
  const [state, formAction, pending] = useActionState(
    editing ? updateNoteAction : createNoteAction,
    EMPTY_FORM_STATE,
  );

  const body = state.values?.body ?? values.body;
  const visibility = state.values?.visibility ?? values.visibility;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      {editing ? <input type="hidden" name="noteId" value={values.id} /> : null}

      <div className="flex flex-col gap-5">
        <TextAreaField
          label="Note"
          name="body"
          defaultValue={body}
          required
          rows={8}
          maxLength={20000}
          hint="Plain text. What you want kept with the records this links to."
          error={state.fieldErrors?.body}
        />

        <SelectField
          key={`visibility:${visibility}`}
          label="Visibility"
          name="visibility"
          defaultValue={visibility}
          required
          hint="“Company” is seen by everyone in this workspace. “Private” is only ever seen by you."
          error={state.fieldErrors?.visibility}
        >
          {NOTE_VISIBILITIES.map((value) => (
            <option key={value} value={value}>
              {NOTE_VISIBILITY_LABELS[value]}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          {editing ? "Save changes" : "Create note"}
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

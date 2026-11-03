"use client";

import { useActionState } from "react";
import { addDataSubjectRequestNoteAction } from "@/lib/dsr/admin-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { DSR_NOTE_MAX } from "@/lib/dsr/contract";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { useReportedAction } from "@/components/ui/action-outcome";

// One working note on one request. Append-only: there is no edit and no
// delete, in the UI or in the database (private.data_subject_request_notes_guard).
//
// The hint says what the table guarantees rather than what this screen
// chooses: the notes live in a table the requester holds no read of at all,
// so "they cannot see it" is a property of the schema and not of this form.
//
// The outcome goes to the page's <ActionOutcome> region rather than being
// rendered here (review finding I6): adding a note does not close a request,
// but a note added to a row that a concurrent transition has just closed
// would vanish the same way, and one page has one place where it says what
// happened.
export function DsrNoteForm({ requestId }: { requestId: string }) {
  const action = useReportedAction(addDataSubjectRequestNoteAction);
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="requestId" value={requestId} />
      <TextAreaField
        label="Add an internal note"
        name="note"
        rows={2}
        maxLength={DSR_NOTE_MAX}
        defaultValue=""
        error={state.fieldErrors?.note}
        hint="Kept in a table the requester has no access to, and never emailed. Only its length is written to the audit log."
      />
      <div>
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Saving…">
          Add note
        </Button>
      </div>
    </form>
  );
}

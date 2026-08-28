"use client";

import { useActionState, useState } from "react";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Soft delete and restore, as two one-button forms.
//
// ===========================================================================
// DELETE ASKS FIRST, AND THE CONFIRMATION IS INLINE RATHER THAN A DIALOG
// ===========================================================================
// A modal here would need focus trapping, a return-focus target, an Escape
// handler and an aria-modal container, all to ask one question. Revealing the
// question in place needs none of that and is better behaved: focus is already
// where the answer is, Escape is the browser's back button, and nothing
// underneath is inert. The revealed state announces itself through
// `role="status"` on the question, so a screen-reader user is told the button
// they pressed asked something rather than doing something.
//
// The destructive button is `variant="danger"` -- a bordered outline that
// fills on hover, not a solid red block, per DESIGN.md. And it says "Delete
// contact", not "Delete": a lone verb on a page with several records is the
// classic mis-click, and the label is also the accessible name.
//
// ===========================================================================
// WHY THE COPY SAYS "YOU CAN RESTORE IT" AND MEANS IT
// ===========================================================================
// CLAUDE.md § Non-negotiable rules requires soft delete, so this really is
// reversible and the confirmation should say so -- an overstated warning
// ("this cannot be undone") is a lie that trains people to ignore the next
// one. What it does NOT say is "nothing else changes", because something does:
// a deleted record leaves the list its colleagues use.

export function DeleteRecordForm({
  action,
  hiddenFields,
  label,
  question,
  disabledReason,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  hiddenFields: Record<string, string>;
  label: string;
  question: string;
  /** Non-null when the caller may not write. Renders inert with the reason. */
  disabledReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const [asking, setAsking] = useState(false);

  if (disabledReason !== null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button type="button" variant="danger" disabled aria-describedby="delete-why">
          {label}
        </Button>
        <p id="delete-why" className="max-w-prose text-sm text-ink-muted">
          {disabledReason}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      {asking ? (
        <form action={formAction} className="flex flex-col gap-3">
          {Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <p role="status" className="max-w-prose text-base text-ink">
            {question}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="danger" pending={pending} pendingLabel="Deleting…">
              Yes, delete
            </Button>
            <Button type="button" variant="secondary" onClick={() => setAsking(false)}>
              Keep it
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button type="button" variant="danger" onClick={() => setAsking(true)}>
            {label}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Restore. No confirmation: it is the undo, it is not destructive, and asking
 * "are you sure you want to undo" is the kind of prompt that makes people stop
 * reading prompts.
 */
export function RestoreRecordForm({
  action,
  hiddenFields,
  label,
  disabledReason,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  hiddenFields: Record<string, string>;
  label: string;
  disabledReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);

  if (disabledReason !== null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button type="button" disabled aria-describedby="restore-why">
          {label}
        </Button>
        <p id="restore-why" className="max-w-prose text-sm text-ink-muted">
          {disabledReason}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <form action={formAction}>
        {Object.entries(hiddenFields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Button type="submit" pending={pending} pendingLabel="Restoring…">
          {label}
        </Button>
      </form>
    </div>
  );
}

"use client";

import { useActionState, useState } from "react";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { useRevealFocus } from "@/components/ui/use-reveal-focus";

// Soft delete and restore, as two one-button forms.
//
// ===========================================================================
// DELETE ASKS FIRST, AND THE CONFIRMATION IS INLINE RATHER THAN A DIALOG
// ===========================================================================
// A modal here would need focus trapping and an aria-modal container, all to
// ask one question. Revealing the question in place needs neither and is
// better behaved: nothing underneath is inert. The revealed state announces
// itself through `role="status"` on the question, so a screen-reader user is
// told the button they pressed asked something rather than doing something.
//
// TWO PIECES OF DIALOG DISCIPLINE THE INLINE PATTERN STILL OWES (keyboard-a11y
// pass — the original header claimed neither was needed, and the audit
// measured otherwise): the trigger sits INSIDE the branch it toggles, so
// revealing the question unmounted the focused element and dropped keyboard
// focus to <body>, both opening and cancelling. `useRevealFocus` is the shared
// fix — focus moves to the question on open, back to the trigger on "Keep it",
// and Escape cancels the same way "Keep it" does. See that hook's header.
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
  srSubject,
  question,
  blocked,
  describedBy,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  hiddenFields: Record<string, string>;
  label: string;
  /**
   * Names the record for a screen reader when the visible label cannot — a
   * list rendering one delete control PER ROW (documents, which have no
   * detail page) would otherwise announce N identical "Delete" buttons,
   * breaking the "the label is also the accessible name" contract above.
   * Rendered sr-only after the label; omit on a detail page whose label
   * already names its subject ("Delete contact").
   */
  srSubject?: string;
  question: string;
  /** True when the caller may not write. Renders inert. */
  blocked: boolean;
  /**
   * The id of the ONE explanation the page renders for this group of
   * controls. Not a per-control note: the same sentence repeated beside every
   * disabled button is noise on screen and a wall between a screen-reader user
   * and the record.
   */
  describedBy: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const [asking, setAsking] = useState(false);
  const { triggerRef, revealRef, onRevealKeyDown } = useRevealFocus<
    HTMLParagraphElement,
    HTMLButtonElement
  >(asking, () => setAsking(false));

  if (blocked) {
    return (
      <div>
        <Button type="button" variant="danger" disabled aria-describedby={describedBy}>
          {label}
          {srSubject ? <span className="sr-only"> {srSubject}</span> : null}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      {asking ? (
        <form
          action={formAction}
          onKeyDown={onRevealKeyDown}
          className="flex flex-col gap-3"
        >
          {Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          {/* tabIndex={-1}: the reveal's focus target — the QUESTION, not
              either answer, so a repeated Enter can never confirm and the
              focus point reads what is being asked. See use-reveal-focus. */}
          <p
            ref={revealRef}
            tabIndex={-1}
            role="status"
            className="max-w-prose text-base text-ink"
          >
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
          <Button
            ref={triggerRef}
            type="button"
            variant="danger"
            onClick={() => setAsking(true)}
          >
            {label}
            {srSubject ? <span className="sr-only"> {srSubject}</span> : null}
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
  srSubject,
  blocked,
  describedBy,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  hiddenFields: Record<string, string>;
  label: string;
  /** @see DeleteRecordForm.srSubject — the per-row list case. */
  srSubject?: string;
  blocked: boolean;
  describedBy: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);

  if (blocked) {
    return (
      <div>
        <Button type="button" disabled aria-describedby={describedBy}>
          {label}
          {srSubject ? <span className="sr-only"> {srSubject}</span> : null}
        </Button>
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
          {srSubject ? <span className="sr-only"> {srSubject}</span> : null}
        </Button>
      </form>
    </div>
  );
}

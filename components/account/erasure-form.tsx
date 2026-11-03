"use client";

import { useActionState, useId, useState } from "react";
import { startAccountErasureAction } from "@/lib/erasure/actions";
import {
  ERASURE_CONFIRMATION_PHRASE,
  confirmationMatches,
} from "@/lib/erasure/contract";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { useReportedAction } from "@/components/ui/action-outcome";

// THE CONFIRMATION THE PERSON CANNOT MISS (the brief, requirement 6).
//
// Not a dialog. A dialog is dismissed by reflex, and the one thing this
// control must not be is reflexive: it is the only irreversible action in the
// product. So the confirmation is a PHRASE the person types, which cannot be
// produced by a mis-click, a stray Enter on a focused button, or a script that
// POSTs the form without reading it.
//
// The button is disabled until the phrase matches, which is a courtesy; the
// SERVER re-checks the phrase (lib/erasure/actions.ts) before it touches
// anything, so stripping the `disabled` attribute achieves nothing -- the
// Phase 6 network e2e asserts exactly this shape for a different control, and
// it is the shape here for the same reason.
//
// THE OUTCOME LIVES ABOVE THIS COMPONENT. Starting an erasure revalidates the
// page, which then renders a job list that did not exist a moment ago and a
// form that is now disabled -- so a message held by this component's own
// useActionState would be thrown away by exactly the re-render it caused, the
// bug this phase shipped three times. It is handed to the page's
// <ActionOutcome> through useReportedAction() and this component renders no
// message of its own.

export function ErasureForm({
  disabled,
  disabledReason,
}: {
  disabled?: boolean;
  disabledReason?: string;
}) {
  const reported = useReportedAction(startAccountErasureAction);
  const [, formAction, pending] = useActionState(reported, EMPTY_FORM_STATE);
  const [typed, setTyped] = useState("");
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;

  const matches = confirmationMatches(typed);

  return (
    <form action={formAction} className="flex max-w-prose flex-col items-start gap-3">
      <label htmlFor={fieldId} className="text-base font-bold text-ink">
        Type {ERASURE_CONFIRMATION_PHRASE} to confirm
      </label>
      <p id={hintId} className="text-sm text-ink-muted">
        This cannot be undone. Nothing is deleted until you press the button below.
      </p>
      <input
        id={fieldId}
        name="confirmation"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        disabled={disabled}
        aria-describedby={hintId}
        className="w-full border border-rule bg-surface px-3 py-2 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      />
      <Button
        type="submit"
        variant="danger"
        pending={pending}
        pendingLabel="Deleting…"
        disabled={disabled || !matches}
      >
        Delete my account
      </Button>
      {disabled && disabledReason ? (
        <p className="text-sm text-ink-muted">{disabledReason}</p>
      ) : null}
    </form>
  );
}

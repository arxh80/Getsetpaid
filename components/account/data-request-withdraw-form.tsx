"use client";

import { useActionState } from "react";
import { withdrawDataSubjectRequestAction } from "@/lib/dsr/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// ONE BUTTON, NO CONFIRMATION — the consent page's rule on a second surface:
// undoing must never be harder than doing. Making a request is one press of
// one button; withdrawing it is one press of one button. Nothing is lost by a
// mistaken withdrawal (a new request can be made immediately, and the
// withdrawn one stays on the list as the record that it happened), so a
// confirmation dialog here would buy friction and no safety.
//
// THE OUTCOME OUTLIVES THE BUTTON, and that is Task 1's I1 lesson applied
// here. This component is rendered for EVERY request, open or closed, and
// hides only its own form once the request is closed — because a successful
// withdrawal closes the request, and a component that the revalidated page
// stops rendering takes its "Your request has been withdrawn." with it. The
// first cut rendered the whole component only while the request was open, and
// the confirmation was therefore never seen by anybody: the press worked and
// the screen said nothing.

export function DataRequestWithdrawForm({
  requestId,
  open,
}: {
  requestId: string;
  /** False once the request is closed: the form goes, the outcome stays. */
  open: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    withdrawDataSubjectRequestAction,
    EMPTY_FORM_STATE,
  );

  return (
    <div className="flex flex-col items-start gap-2">
      <div aria-live="polite" className="flex flex-col gap-2">
        {state.error ? (
          <Alert tone="error" live={false}>
            {state.error}
          </Alert>
        ) : null}
        {state.message ? (
          <Alert tone="success" live={false}>
            {state.message}
          </Alert>
        ) : null}
      </div>
      {open ? (
        <form action={formAction}>
          <input type="hidden" name="requestId" value={requestId} />
          <Button type="submit" variant="secondary" pending={pending} pendingLabel="Withdrawing…">
            Withdraw this request
          </Button>
        </form>
      ) : null}
    </div>
  );
}

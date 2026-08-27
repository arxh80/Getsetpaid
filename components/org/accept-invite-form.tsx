"use client";

import { useActionState } from "react";
import { acceptInviteAction } from "@/lib/org/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// One form per pending invitation.
//
// Per-invitation rather than one form with a hidden "which" field, so each row
// gets its own pending state and its own error -- with several invitations on
// screen, a single shared spinner cannot say which one is in flight.
export function AcceptInviteForm({
  membershipId,
  organisationName,
}: {
  membershipId: string;
  organisationName: string;
}) {
  const [state, formAction, pending] = useActionState(
    acceptInviteAction,
    EMPTY_FORM_STATE,
  );

  return (
    <div className="flex flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <form action={formAction}>
        <input type="hidden" name="membershipId" value={membershipId} />
        <Button type="submit" pending={pending} pendingLabel="Joining…">
          {/* The accessible name says WHICH workspace: with three "Accept"
              buttons on the page, a screen-reader user tabbing through hears
              "Accept, Accept, Accept" otherwise. The visible label stays short
              because the row already names the workspace next to it. */}
          <span aria-hidden="true">Accept</span>
          <span className="sr-only">Accept invitation to {organisationName}</span>
        </Button>
      </form>
    </div>
  );
}

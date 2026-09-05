"use client";

import { useActionState, useState } from "react";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import {
  acceptConnectionRequestAction,
  declineConnectionRequestAction,
  withdrawConnectionRequestAction,
} from "@/lib/network/connections";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Task 4: accept / decline / withdraw, each its own one-button form with an
// inline confirmation -- the same DeleteRecordForm/RestoreRecordForm shape
// components/crm/delete-restore.tsx established, so a reader who knows that
// pattern already knows this one.
//
// ===========================================================================
// EVERY ONE OF THE THREE ASKS FIRST, EVEN ACCEPT
// ===========================================================================
// The brief asks for "a confirmation" on all three, not only the destructive
// two. Accept is not destructive, but it is not undoable EITHER -- once
// accepted, the transition guard (private.network_request_status_transition_
// guard) makes the row immutable, and un-accepting is not a thing the product
// offers. A control that changes a permanent record deserves the same "are
// you sure" beat as one that deletes something, even when nothing is at risk
// beyond a moment's inattention.
//
// ===========================================================================
// DECLINE'S QUESTION SAYS "TERMINAL" BEFORE THE CLICK, BY NAME
// ===========================================================================
// Q79 + the brief: "The UI says so before the click, because a user who
// declines expecting to be able to undo it has been misled by the product."
// So DeclineRequestForm's confirmation sentence states the consequence in the
// question itself, not as a footnote after the fact -- the same discipline
// DeleteRecordForm uses for "you can restore it", inverted: this one is
// honest that there is NO restoring it.
//
// ===========================================================================
// EACH FORM CARRIES ONLY `orgSlug` AND `requestId` AS HIDDEN FIELDS
// ===========================================================================
// There is nothing else to submit -- the caller and the row are the whole
// input, exactly like DeleteRecordForm's `hiddenFields`. A refusal from any of
// the three server actions still echoes `values` back (lib/network/
// connections.ts's `echoedValues(formData)` on every failure path), so the
// brief's "each returning echoedValues on refusal" is met by the action, not
// by anything added here -- there is no text field whose value could be lost.
//
// ===========================================================================
// A SUCCESSFUL accept/decline's `state.message` IS NOT RELIABLY OBSERVABLE,
// AND THAT IS FINE -- FOUND IN THE BROWSER WALK (Constraint 17)
// ===========================================================================
// components/network/requests-results.tsx only renders this whole form when
// `row.status === "pending"`. The instant a request leaves `pending`, the
// SAME server revalidation that repaints the row's status chip also unmounts
// this component (the Actions cell renders nothing for a non-pending row),
// which can happen before a page ever gets to show the success alert this
// component would otherwise render. `tests/e2e/network-connections.spec.ts`
// asserts the CHIP change instead -- the same "the row appearing in the list
// is the confirmation" principle components/crm/entity-link-picker.tsx's
// `AddLinkForm` states for the identical reason. Nothing here needs fixing:
// the row updating IS the confirmation, and a message no one can see is not a
// bug so much as a redundant one.

function Confirming({
  action,
  orgSlug,
  requestId,
  question,
  confirmLabel,
  confirmingLabel,
  keepLabel,
  variant,
  onCancel,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  orgSlug: string;
  requestId: string;
  question: string;
  confirmLabel: string;
  confirmingLabel: string;
  keepLabel: string;
  variant: "primary" | "danger" | "secondary";
  onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="requestId" value={requestId} />
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      {/* THE TERMINAL WARNING (Decline) OR THE PLAIN QUESTION (Accept,
          Withdraw), STATED BEFORE THE BUTTON THAT ACTS ON IT. */}
      <p role="status" className="max-w-prose text-base text-ink">
        {question}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant={variant} pending={pending} pendingLabel={confirmingLabel}>
          {confirmLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {keepLabel}
        </Button>
      </div>
    </form>
  );
}

export function AcceptRequestForm({
  orgSlug,
  requestId,
}: {
  orgSlug: string;
  requestId: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button type="button" variant="primary" onClick={() => setAsking(true)}>
        Accept
      </Button>
    );
  }
  return (
    <Confirming
      action={acceptConnectionRequestAction}
      orgSlug={orgSlug}
      requestId={requestId}
      question="Accept this connection? Fields they marked “Connections only” become visible to you, and yours become visible to them — both ways round."
      confirmLabel="Yes, accept"
      confirmingLabel="Accepting…"
      keepLabel="Not yet"
      variant="primary"
      onCancel={() => setAsking(false)}
    />
  );
}

export function DeclineRequestForm({
  orgSlug,
  requestId,
}: {
  orgSlug: string;
  requestId: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button type="button" variant="danger" onClick={() => setAsking(true)}>
        Decline
      </Button>
    );
  }
  return (
    <Confirming
      action={declineConnectionRequestAction}
      orgSlug={orgSlug}
      requestId={requestId}
      // THE Q79 SENTENCE, STATED BEFORE THE CLICK.
      question="Decline this request? Declining is final — they won’t be able to send another request to this profile afterwards."
      confirmLabel="Yes, decline"
      confirmingLabel="Declining…"
      keepLabel="Keep pending"
      variant="danger"
      onCancel={() => setAsking(false)}
    />
  );
}

export function WithdrawRequestForm({
  orgSlug,
  requestId,
}: {
  orgSlug: string;
  requestId: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button type="button" variant="secondary" onClick={() => setAsking(true)}>
        Withdraw
      </Button>
    );
  }
  return (
    <Confirming
      action={withdrawConnectionRequestAction}
      orgSlug={orgSlug}
      requestId={requestId}
      question="Withdraw this request? You can send one more request to this profile afterwards."
      confirmLabel="Yes, withdraw"
      confirmingLabel="Withdrawing…"
      keepLabel="Keep it pending"
      variant="secondary"
      onCancel={() => setAsking(false)}
    />
  );
}

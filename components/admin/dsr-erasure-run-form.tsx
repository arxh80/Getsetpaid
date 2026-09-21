"use client";

import { useActionState } from "react";
import { runErasureForRequestAction } from "@/lib/dsr/admin-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import type { DsrQueueRow } from "@/lib/dsr/queue";
import { Button } from "@/components/ui/button";
import { useReportedAction } from "@/components/ui/action-outcome";

// RUNNING AN ERASURE FROM THE QUEUE (Phase 8 Task 5).
//
// It is a separate control from the transition buttons beside it, and that is
// the point rather than a layout accident: every other button on this row
// changes a STATUS. This one deletes a person's account. Putting it in the
// same row of "Mark in progress / Mark answered / Refuse" would make the one
// irreversible action on the operator's surface look like the three
// reversible ones.
//
// IT IS OFFERED ONLY WHERE IT CAN WORK: an account-scope `erasure` request
// that is still open. Every one of those conditions is re-checked by
// public.start_erasure_for_request() and again by the insert trigger, so this
// is a courtesy and never the gate.
//
// WHAT IT DOES NOT DO: close the request. The job is queued; when it has run,
// the fulfilment seam records itself on the row and only then does "Mark
// answered" become possible (private.dsr_fulfilment_job_ready('erasure') is
// TRUE since 20260930004000). So this control and the transition buttons are
// in a deliberate order, and the row says which stage it is at.
//
// NO OUTCOME OF ITS OWN: running an erasure revalidates the queue, and a
// closed request leaves the default open-only view -- the review's I6 bug
// class. The message goes to the page's <ActionOutcome>.

export function DsrErasureRunForm({ row }: { row: DsrQueueRow }) {
  const action = useReportedAction(runErasureForRequestAction);
  const [, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);

  const applicable =
    row.rightType === "erasure" &&
    row.subjectScope === "account" &&
    (row.status === "open" || row.status === "in_progress");

  if (!applicable) return null;

  if (row.fulfilmentKind === "erasure") {
    return (
      <p className="max-w-prose text-sm text-ink-muted">
        The erasure has run and recorded itself against this request. It can now be marked
        answered.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex max-w-prose flex-col items-start gap-2">
      <input type="hidden" name="requestId" value={row.id} />
      <Button type="submit" variant="danger" pending={pending} pendingLabel="Starting…">
        Delete this account
      </Button>
      <p className="text-sm text-ink-muted">
        This cannot be undone. It deletes their sign-in and their private notes, anonymises the
        audit trail, and leaves every workspace’s own records in place. The request stays open
        until the deletion has actually run.
      </p>
    </form>
  );
}

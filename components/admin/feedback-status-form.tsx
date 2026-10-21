"use client";

import { useActionState } from "react";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { updateFeedbackStatusAction } from "@/lib/feedback/admin-actions";
import {
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
} from "@/lib/feedback/contract";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The one control a feedback row carries: the founder's status flag.
//
// A native <select> plus an explicit "Update" button rather than an
// auto-submitting select: a change event on a select fires on every arrow
// key for a keyboard user, and auto-submitting on it is the WCAG 3.2.2
// "change of context on input" failure. The label is visually hidden but
// present -- one per row, keyed by the row's id.

export function FeedbackStatusForm({
  feedbackId,
  status,
}: {
  feedbackId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(
    updateFeedbackStatusAction,
    EMPTY_FORM_STATE,
  );
  const selectId = `feedback-status-${feedbackId}`;

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <input type="hidden" name="feedbackId" value={feedbackId} />
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
            Status
          </label>
          <select
            id={selectId}
            name="status"
            defaultValue={status}
            className="h-11 min-w-36 border border-rule bg-surface px-3 text-base text-ink transition-colors duration-[var(--dur-fast)] ease-brand hover:border-ink focus:border-accent"
          >
            {FEEDBACK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {FEEDBACK_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Updating…">
          Update
        </Button>
      </div>
    </form>
  );
}

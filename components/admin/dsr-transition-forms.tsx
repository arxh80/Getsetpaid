"use client";

import { useActionState, useId, useState } from "react";
import { transitionDataSubjectRequestAction } from "@/lib/dsr/admin-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import {
  DSR_REJECTION_REASON_MAX,
  DSR_STATUS_LABELS,
  REJECTION_REASON_WARNING,
  operatorTransitionsFrom,
  type DsrStatus,
} from "@/lib/dsr/contract";
import type { DsrQueueRow } from "@/lib/dsr/queue";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { TextAreaField, Field } from "@/components/ui/field";

// The operator's controls on one request.
//
// ONE FORM PER TRANSITION, not a <select> plus "Apply": two of the five
// transitions need an extra field (a rejection needs a reason, a routing needs
// a workspace) and one needs step-up, so a single control would have to reveal
// and hide fields as its value changed — a change of context on input, WCAG
// 3.2.2, and the failure mode the feedback status form's header already names.
// Buttons that say what they do, with the two that need more asking for it
// first.
//
// WHICH BUTTONS EXIST IS THE DATABASE'S ANSWER, mirrored:
// operatorTransitionsFrom() is private.dsr_transition_allowed() minus
// `withdrawn`, which is the requester's act alone. A button this list does not
// draw is refused by the RPC anyway (22023 illegal_transition), so the mirror
// is a courtesy and never the gate.

const REVEAL_LABELS: Partial<Record<DsrStatus, string>> = {
  rejected: "Refuse this request",
  routed: "Pass to the business",
};

export function DsrTransitionForms({ row }: { row: DsrQueueRow }) {
  const next = operatorTransitionsFrom(row.status);
  const [state, formAction, pending] = useActionState(
    transitionDataSubjectRequestAction,
    EMPTY_FORM_STATE,
  );
  const [revealed, setRevealed] = useState<DsrStatus | null>(null);
  const baseId = useId();

  if (next.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        This request is closed. Nothing further changes on it; a new request is a new row.
      </p>
    );
  }

  const plain = next.filter((s) => REVEAL_LABELS[s] === undefined);
  const needsMore = next.filter((s) => REVEAL_LABELS[s] !== undefined);

  return (
    <div className="flex flex-col gap-3">
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

      <div className="flex flex-wrap items-center gap-2">
        {plain.map((status) => (
          <form key={status} action={formAction}>
            <input type="hidden" name="requestId" value={row.id} />
            <input type="hidden" name="status" value={status} />
            <Button type="submit" variant="secondary" pending={pending} pendingLabel="Saving…">
              Mark {DSR_STATUS_LABELS[status].toLowerCase()}
            </Button>
          </form>
        ))}
        {needsMore.map((status) => (
          <Button
            key={status}
            type="button"
            variant="secondary"
            aria-expanded={revealed === status}
            aria-controls={`${baseId}-${status}`}
            onClick={() => setRevealed(revealed === status ? null : status)}
          >
            {REVEAL_LABELS[status]}
          </Button>
        ))}
      </div>

      {needsMore.map((status) =>
        revealed === status ? (
          <form
            key={status}
            id={`${baseId}-${status}`}
            action={formAction}
            className="flex max-w-prose flex-col gap-3 border border-rule p-4"
          >
            <input type="hidden" name="requestId" value={row.id} />
            <input type="hidden" name="status" value={status} />
            {status === "rejected" ? (
              <TextAreaField
                label="Why this request is refused"
                name="rejectionReason"
                required
                rows={4}
                maxLength={DSR_REJECTION_REASON_MAX}
                defaultValue={state.values?.rejectionReason ?? ""}
                error={state.fieldErrors?.rejectionReason}
                hint={REJECTION_REASON_WARNING}
              />
            ) : (
              <Field
                label="Workspace slug"
                name="organisationSlug"
                required
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                maxLength={64}
                defaultValue={state.values?.organisationSlug ?? ""}
                error={state.fieldErrors?.organisationSlug}
                hint="The business that holds the records and must answer — it is the controller, we are only its processor. This is recorded on the request and the requester is told it was passed on."
              />
            )}
            <div>
              <Button type="submit" pending={pending} pendingLabel="Saving…">
                {status === "rejected" ? "Refuse this request" : "Pass it on"}
              </Button>
            </div>
          </form>
        ) : null,
      )}
    </div>
  );
}

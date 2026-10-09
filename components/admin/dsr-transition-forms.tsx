"use client";

import { useActionState, useId, useState } from "react";
import {
  routeDataSubjectRequestAction,
  transitionDataSubjectRequestAction,
} from "@/lib/dsr/admin-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import {
  DSR_NOTE_MAX,
  DSR_REJECTION_REASON_MAX,
  DSR_STATUS_LABELS,
  REJECTION_REASON_WARNING,
  ROUTING_CONFIRMATION_TOKEN_KEY,
  ROUTING_CONFIRMED_SLUG_KEY,
  ROUTING_HANDOVER_HINT,
  ROUTING_RESOLVED_NAME_KEY,
  ROUTING_SENDS_NOTHING,
  operatorMayRoute,
  operatorTransitionsFrom,
  type DsrStatus,
} from "@/lib/dsr/contract";
import type { DsrQueueRow } from "@/lib/dsr/queue";
import { Button } from "@/components/ui/button";
import { TextAreaField, Field } from "@/components/ui/field";
import { useReportedAction } from "@/components/ui/action-outcome";

// The operator's controls on one request.
//
// ONE FORM PER TRANSITION, not a <select> plus "Apply": two of them need an
// extra field (a rejection needs a reason, a routing needs a workspace and a
// handover note) and one needs step-up, so a single control would have to
// reveal and hide fields as its value changed — a change of context on input,
// WCAG 3.2.2, and the failure mode the feedback status form's header already
// names. Buttons that say what they do, with the two that need more asking
// for it first.
//
// WHICH BUTTONS EXIST IS THE DATABASE'S ANSWER, mirrored:
// operatorTransitionsFrom() is private.dsr_transition_allowed() minus the two
// states public.transition_data_subject_request() refuses by name
// (`withdrawn`, the requester's act; `routed`, which has its own function).
// A button this list does not draw is refused by the RPC anyway, so the
// mirror is a courtesy and never the gate.
//
// NO FORM HERE RENDERS ITS OWN OUTCOME (review finding I6). Every action on
// this page can make the row it was submitted from disappear: the default
// queue lists OPEN requests only, so "Mark answered" and "Refuse this
// request" — the two that close a request, one of them behind a step-up
// prompt — used to answer with the row, and the message it was holding,
// unmounting. In the "show closed too" view the row survived and the
// component took its early return ABOVE its own live region instead, so the
// message was never rendered there either. Both submissions reached Postgres;
// neither was ever confirmed to a person. The outcome now lives in
// <ActionOutcome>, rendered by the page above the whole list, and the early
// return below is harmless because there is no live region under it.
//
// ROUTING IS NOT A TRANSITION BUTTON (review finding I7 / Q160). It is offered
// only on a request a workspace is the controller of (M7: it used to be drawn
// from the transition table alone, so an account-scope row offered a control
// whose only possible outcome was the database's `not_a_processor_request`),
// it says in words that nothing is sent, it makes the operator read the
// workspace's NAME before it writes, and it requires the note that records the
// handover they have to do by hand.

const REVEAL_LABELS: Partial<Record<DsrStatus, string>> = {
  rejected: "Refuse this request",
};

export function DsrTransitionForms({ row }: { row: DsrQueueRow }) {
  const next = operatorTransitionsFrom(row.status);
  const mayRoute = operatorMayRoute(row.status, row.subjectScope);
  const action = useReportedAction(transitionDataSubjectRequestAction);
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const [revealed, setRevealed] = useState<string | null>(null);
  const baseId = useId();

  if (next.length === 0 && !mayRoute) {
    return (
      <p className="text-sm text-ink-muted">
        This request is closed. Nothing further changes on it; a new request is a new row.
      </p>
    );
  }

  const plain = next.filter((s) => REVEAL_LABELS[s] === undefined);
  const needsMore = next.filter((s) => REVEAL_LABELS[s] !== undefined);
  const routeLabel =
    row.status === "routed" ? "Correct the workspace" : "Pass to the business";

  return (
    <div className="flex flex-col gap-3">
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
        {mayRoute ? (
          <Button
            type="button"
            variant="secondary"
            aria-expanded={revealed === "routing"}
            aria-controls={`${baseId}-routing`}
            onClick={() => setRevealed(revealed === "routing" ? null : "routing")}
          >
            {routeLabel}
          </Button>
        ) : null}
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
            <div>
              <Button type="submit" pending={pending} pendingLabel="Saving…">
                Refuse this request
              </Button>
            </div>
          </form>
        ) : null,
      )}

      {mayRoute && revealed === "routing" ? (
        <DsrRoutingForm row={row} formId={`${baseId}-routing`} />
      ) : null}
    </div>
  );
}

/**
 * "Pass to the business", as it has to read once the product is described
 * honestly (Q160).
 *
 * TWO PRESSES. The first resolves the slug and shows the workspace's NAME;
 * only a second submission carrying that same slug back writes anything. A
 * slug is typed, a typo can match a different real workspace, and — before
 * the database half of this round — a wrong routing was uncorrectable.
 */
function DsrRoutingForm({ row, formId }: { row: DsrQueueRow; formId: string }) {
  const action = useReportedAction(routeDataSubjectRequestAction);
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const resolvedName = state.values?.[ROUTING_RESOLVED_NAME_KEY];
  const confirmedSlug = state.values?.[ROUTING_CONFIRMED_SLUG_KEY];
  // The server's own token, bound to the request AND the organisation the slug
  // resolved to (fix round 2, R3). `confirmedSlug` is what the panel SHOWS;
  // this is what the second press is accepted on.
  const confirmationToken = state.values?.[ROUTING_CONFIRMATION_TOKEN_KEY];

  return (
    <form
      id={formId}
      action={formAction}
      className="flex max-w-prose flex-col gap-3 border border-rule p-4"
    >
      <input type="hidden" name="requestId" value={row.id} />

      {/* THE SENTENCE THE PRODUCT OWED THE OPERATOR. Nothing is sent. */}
      <p className="max-w-prose border-l-2 border-danger pl-3 text-sm text-ink">
        {ROUTING_SENDS_NOTHING}
      </p>
      {row.routedToOrganisationName ? (
        <p className="text-sm text-ink-muted">
          Currently recorded as passed to{" "}
          <span className="font-semibold text-ink">{row.routedToOrganisationName}</span>. Naming a
          different workspace corrects that record.
        </p>
      ) : null}

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
        hint="The business that holds the records and must answer — it is the controller, we are only its processor. This is the name in the workspace’s address bar."
      />

      <TextAreaField
        label="How you told the workspace"
        name="handoverNote"
        required
        rows={3}
        maxLength={DSR_NOTE_MAX}
        defaultValue={state.values?.handoverNote ?? ""}
        error={state.fieldErrors?.handoverNote}
        hint={ROUTING_HANDOVER_HINT}
      />

      {/* The confirmation lives IN the form: nothing has been written yet, so
          this is a question rather than an outcome, and the form is still on
          screen to answer it. */}
      {resolvedName && confirmedSlug && confirmationToken ? (
        <div
          role="status"
          data-testid="dsr-routing-confirm"
          className="flex flex-col gap-1 border border-rule-strong bg-surface p-3"
        >
          <p className="text-sm text-ink-muted">Check this is the right business</p>
          <p className="text-base font-semibold text-ink">{resolvedName}</p>
          <p className="text-sm text-ink-muted">
            {confirmedSlug} — press “Pass it on” again to record it. Change the slug above if this
            is not them.
          </p>
          <input
            type="hidden"
            name={ROUTING_CONFIRMATION_TOKEN_KEY}
            value={confirmationToken}
          />
        </div>
      ) : null}

      <div>
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          {resolvedName ? `Pass it on to ${resolvedName}` : "Pass it on"}
        </Button>
      </div>
    </form>
  );
}

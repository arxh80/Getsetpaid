"use client";

import { useActionState, useState } from "react";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import { useRevealFocus } from "@/components/ui/use-reveal-focus";
import {
  deleteOrganisationAction,
  reinstateOrganisationAction,
  suspendOrganisationAction,
} from "@/lib/admin/lifecycle";
import { ORGANISATION_RETENTION_DAYS } from "@/lib/admin/lifecycle-contract";
import { Field, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The three lifecycle controls.
//
// ===========================================================================
// TWO SHAPES, AND THE DIFFERENCE IS ABOUT MIS-CLICKS, NOT ABOUT DANGER
// ===========================================================================
// Suspend and close are TYPED forms: the operator writes the workspace's exact
// slug and a reason before anything happens. That is already a deliberate act
// three keystrokes deep, on top of step-up re-authentication, so the
// ask-then-confirm reveal that components/admin/impersonation-actions.tsx puts
// in front of its one-button controls would be a fourth beat guarding against
// a mis-click that cannot happen -- nobody types a slug by accident.
//
// Reinstate is a ROW button in a list of similar rows, which is exactly the
// case that reveal exists for (its header: "the mis-click cost of a Start next
// to a Decline in a table of similar rows"). So it gets the reveal -- and the
// reveal carries a reason field, because reinstating is a transition like any
// other and the audit record needs to say why.
//
// ===========================================================================
// WHY THE TWO DESTRUCTIVE FORMS DO NOT OFFER A PICKER
// ===========================================================================
// A dropdown of every workspace on the platform would be friendlier and worse.
// lib/admin/lifecycle-list.ts's header has the argument in full; the short
// version is that suspension is aimed rather than browsed, and a browsable
// roster of the customer base one click from a destructive action is not
// something the operator needs in order to suspend a named workspace.

function LifecycleForm({
  action,
  legend,
  intro,
  submitLabel,
  pendingLabel,
  reasonHint,
  variant,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  legend: string;
  intro: string;
  submitLabel: string;
  pendingLabel: string;
  reasonHint: string;
  variant: "primary" | "danger";
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <h3 className="text-base font-bold text-ink">{legend}</h3>
      <p className="max-w-prose text-sm text-ink-muted">{intro}</p>

      <Field
        label="Workspace URL name"
        name="organisationSlug"
        required
        defaultValue={state.values?.organisationSlug ?? ""}
        error={state.fieldErrors?.organisationSlug}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="none"
        hint="The slug from the workspace’s URL — the part after the first slash."
      />

      <TextAreaField
        label="Reason"
        name="reason"
        required
        rows={3}
        defaultValue={state.values?.reason ?? ""}
        error={state.fieldErrors?.reason}
        hint={reasonHint}
      />

      <div>
        <Button
          type="submit"
          variant={variant}
          pending={pending}
          pendingLabel={pendingLabel}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function SuspendOrganisationForm() {
  return (
    <LifecycleForm
      action={suspendOrganisationAction}
      legend="Suspend a workspace"
      intro={`It becomes read-only: everyone in it keeps reading everything, nobody can change anything, and its own Owner cannot undo it. It keeps its place in the network directory until its current subscription period ends, and its data is kept for ${ORGANISATION_RETENTION_DAYS} days.`}
      submitLabel="Suspend workspace"
      pendingLabel="Suspending…"
      reasonHint="THE WORKSPACE'S OWN PEOPLE WILL READ THIS on every page, and it goes on the permanent audit record. Write the sentence you would say to them — name the invoice or the decision — not an internal note."
      variant="danger"
    />
  );
}

export function CloseOrganisationForm() {
  return (
    <LifecycleForm
      action={deleteOrganisationAction}
      legend="Close a workspace"
      intro={`Soft-delete. Nothing is removed — the workspace becomes read-only exactly as a suspension does, leaves the network directory immediately rather than at period end, and its data is kept for ${ORGANISATION_RETENTION_DAYS} days. There is no hard delete in this product; reopening restores everything.`}
      submitLabel="Close workspace"
      pendingLabel="Closing…"
      reasonHint="THE WORKSPACE'S OWN PEOPLE WILL READ THIS on every page, and it goes on the permanent audit record. Write the sentence you would say to them — who asked and when — not an internal note."
      variant="danger"
    />
  );
}

/**
 * The wound-down list, and the ONE reinstate action behind all of its rows.
 *
 * ===========================================================================
 * WHY THE LIST IS A CLIENT COMPONENT AND THE ACTION STATE LIVES AT ITS TOP
 * ===========================================================================
 * FOUND IN THE BROWSER, NOT IN REVIEW, AND IT IS THE WHOLE REASON THIS FILE
 * IS SHAPED LIKE THIS. The first cut put a `useActionState` inside each row.
 * Reopening then worked perfectly and reported nothing: the action calls
 * revalidatePath, the server re-renders the list WITHOUT the workspace that is
 * no longer wound down, the row unmounts -- and the success Alert, which lived
 * inside it, unmounts with it. The operator clicked "Yes, reopen", the row
 * vanished, and the product said nothing at all. Silent success on a
 * privileged, audited action, and worse than silent for anyone relying on a
 * screen reader, who gets no announcement that anything happened.
 *
 * So the action state is hoisted ABOVE the rows, into a component that stays
 * mounted across the re-render because its position does not change. The rows
 * come and go underneath it; the confirmation stays.
 *
 * The empty state lives here too, for the same reason: reopening the LAST
 * wound-down workspace is exactly the case where the list becomes empty and
 * the message must still be readable.
 */
export function WoundDownOrganisationsList({
  rows,
  limit,
}: {
  rows: readonly {
    id: string;
    name: string;
    slug: string;
    stateLabel: string;
    changedAt: string | null;
    reason: string | null;
    retentionExpiresAt: string | null;
    retentionDays: number | null;
  }[];
  limit: number;
}) {
  const [state, formAction, pending] = useActionState(
    reinstateOrganisationAction,
    EMPTY_FORM_STATE,
  );
  const [askingId, setAskingId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      {rows.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">
          Every workspace on the platform is active.
        </p>
      ) : (
        <>
          <ul className="flex flex-col border-t border-rule">
            {rows.map((row) => (
              <WoundDownRow
                key={row.id}
                row={row}
                asking={askingId === row.id}
                pending={pending}
                fieldError={state.fieldErrors?.reason}
                formAction={formAction}
                onAsk={() => setAskingId(row.id)}
                onCancel={() => setAskingId(null)}
              />
            ))}
          </ul>
          {rows.length === limit ? (
            <p className="max-w-prose text-sm text-ink-muted">
              Showing the <span className="tabular-nums">{limit}</span> most
              recent. The complete history of every transition is in the audit
              log, filtered to <code>organisation.suspended</code>,{" "}
              <code>organisation.deleted</code> and{" "}
              <code>organisation.reinstated</code>.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function WoundDownRow({
  row,
  asking,
  pending,
  fieldError,
  formAction,
  onAsk,
  onCancel,
}: {
  row: {
    id: string;
    name: string;
    slug: string;
    stateLabel: string;
    changedAt: string | null;
    reason: string | null;
    retentionExpiresAt: string | null;
    retentionDays: number | null;
  };
  asking: boolean;
  pending: boolean;
  fieldError: string | undefined;
  formAction: (data: FormData) => void;
  onAsk: () => void;
  onCancel: () => void;
}) {
  const { triggerRef, revealRef, onRevealKeyDown } = useRevealFocus<
    HTMLParagraphElement,
    HTMLButtonElement
  >(asking, onCancel);

  return (
    <li className="flex flex-col gap-3 border-b border-rule py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-base font-semibold text-ink">{row.name}</span>
        <span className="text-sm text-ink-muted">/{row.slug}</span>
        <span className="text-sm font-semibold text-warning">{row.stateLabel}</span>
        {row.changedAt ? (
          <span className="text-sm text-ink-muted tabular-nums">
            since {row.changedAt}
          </span>
        ) : null}
      </div>

      {row.reason ? (
        <p className="max-w-prose text-base text-ink">{row.reason}</p>
      ) : null}

      {row.retentionExpiresAt ? (
        <p className="text-sm text-ink-muted">
          Retained until{" "}
          <span className="tabular-nums">{row.retentionExpiresAt}</span>
          {row.retentionDays !== null ? (
            <>
              {" "}
              (<span className="tabular-nums">{row.retentionDays}</span>{" "}
              {row.retentionDays === 1 ? "day" : "days"})
            </>
          ) : null}
          .
        </p>
      ) : null}

      {!asking ? (
        <div>
          <Button ref={triggerRef} type="button" variant="primary" onClick={onAsk}>
            Reopen
            <span className="sr-only"> — {row.name}</span>
          </Button>
        </div>
      ) : (
        <form
          action={formAction}
          onKeyDown={onRevealKeyDown}
          className="flex max-w-prose flex-col gap-3"
        >
          <input type="hidden" name="organisationSlug" value={row.slug} />
          {/* The reveal's focus target (tabIndex={-1}): focus lands on the
              question rather than on a button a repeated Enter could fire. */}
          <p
            ref={revealRef}
            tabIndex={-1}
            role="status"
            className="max-w-prose text-base text-ink"
          >
            Reopen {row.name}? Writes come back immediately for everyone in it,
            and its published profiles return to the network directory.
          </p>
          <TextAreaField
            label="Reason"
            name="reason"
            required
            rows={2}
            error={fieldError}
            hint="Goes on the permanent audit record beside the suspension it undoes. Not shown to the workspace — the banner is gone the moment this succeeds."
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              pending={pending}
              pendingLabel="Reopening…"
            >
              Yes, reopen
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Leave it closed
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

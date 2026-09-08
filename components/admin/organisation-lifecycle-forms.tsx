"use client";

import { useActionState, useState, type KeyboardEvent } from "react";
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
      reasonHint="Goes on the permanent audit record. Name the ticket, the invoice or the decision."
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
      reasonHint="Goes on the permanent audit record. Name who asked and when."
      variant="danger"
    />
  );
}

/**
 * The per-row reinstate control: a button that reveals a reason field.
 *
 * `subject` is written into both the sr-only trigger suffix and the question,
 * so a list of N rows does not announce N identical "Reopen" buttons -- the
 * same reason components/admin/impersonation-actions.tsx carries it.
 */
export function ReinstateOrganisationForm({
  slug,
  name,
}: {
  slug: string;
  name: string;
}) {
  const [asking, setAsking] = useState(false);
  const { triggerRef, revealRef, onRevealKeyDown } = useRevealFocus<
    HTMLParagraphElement,
    HTMLButtonElement
  >(asking, () => setAsking(false));

  if (!asking) {
    return (
      <Button
        ref={triggerRef}
        type="button"
        variant="primary"
        onClick={() => setAsking(true)}
      >
        Reopen
        <span className="sr-only"> — {name}</span>
      </Button>
    );
  }
  return (
    <ReinstateConfirm
      slug={slug}
      name={name}
      questionRef={revealRef}
      onKeyDown={onRevealKeyDown}
      onCancel={() => setAsking(false)}
    />
  );
}

function ReinstateConfirm({
  slug,
  name,
  questionRef,
  onKeyDown,
  onCancel,
}: {
  slug: string;
  name: string;
  questionRef: React.Ref<HTMLParagraphElement>;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    reinstateOrganisationAction,
    EMPTY_FORM_STATE,
  );

  return (
    <form
      action={formAction}
      onKeyDown={onKeyDown}
      className="flex max-w-prose flex-col gap-3"
    >
      <input type="hidden" name="organisationSlug" value={slug} />
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      {/* The reveal's focus target (tabIndex={-1}): focus lands on the
          question rather than on a button a repeated Enter could fire. */}
      <p
        ref={questionRef}
        tabIndex={-1}
        role="status"
        className="max-w-prose text-base text-ink"
      >
        Reopen {name}? Writes come back immediately for everyone in it, and its
        published profiles return to the network directory.
      </p>
      <TextAreaField
        label="Reason"
        name="reason"
        required
        rows={2}
        defaultValue={state.values?.reason ?? ""}
        error={state.fieldErrors?.reason}
        hint="Goes on the permanent audit record beside the suspension it undoes."
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
  );
}

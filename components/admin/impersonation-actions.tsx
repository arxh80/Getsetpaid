"use client";

import { useActionState, useState, type KeyboardEvent, type Ref } from "react";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import { useRevealFocus } from "@/components/ui/use-reveal-focus";
import {
  acceptImpersonationRequestAction,
  declineImpersonationRequestAction,
  endImpersonationAction,
  revokeImpersonationSessionAction,
  startImpersonationAction,
} from "@/lib/admin/impersonation";
import { IMPERSONATION_TIME_BOX_MINUTES } from "@/lib/admin/impersonation-contract";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The five one-button forms of the impersonation flow, in the SAME
// ask-then-confirm shape components/network/request-actions.tsx established
// (which itself copies components/crm/delete-restore.tsx) -- so a reader who
// knows either of those already knows this file.
//
// ===========================================================================
// EVERY ONE OF THE FIVE ASKS FIRST, INCLUDING THE TWO THAT LOOK HARMLESS
// ===========================================================================
// Starting a session and ending one both look like ordinary buttons. Neither
// is: starting opens a customer's private workspace to the operator and writes
// a permanent record of having done so, and ending is the control the customer
// is told they have. The mis-click cost of a "Start" next to a "Decline" in a
// table of similar rows is a support engineer inside a tenant they did not
// mean to open, with an audit trail saying they meant to. One beat of
// confirmation is cheap against that.
//
// ===========================================================================
// THE QUESTIONS STATE THE CONSEQUENCE, NOT THE MECHANISM
// ===========================================================================
// The admin accepting is not told "this sets status to accepted"; they are
// told what support will be able to see, for how long, and that they can stop
// it. That is the consent the whole feature rests on, and consent given
// against a description of a database column is not consent.

function Confirming({
  action,
  hiddenFields,
  question,
  confirmLabel,
  confirmingLabel,
  keepLabel,
  variant,
  onCancel,
  questionRef,
  onKeyDown,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  hiddenFields: Readonly<Record<string, string>>;
  question: string;
  confirmLabel: string;
  confirmingLabel: string;
  keepLabel: string;
  variant: "primary" | "danger" | "secondary";
  onCancel: () => void;
  questionRef: Ref<HTMLParagraphElement>;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  return (
    <form action={formAction} onKeyDown={onKeyDown} className="flex flex-col gap-3">
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      {/* The reveal's focus target (tabIndex={-1}): keyboard focus lands on
          the question rather than being dropped to <body> when the trigger
          unmounts, and never on a button a repeated Enter could fire. */}
      <p
        ref={questionRef}
        tabIndex={-1}
        role="status"
        className="max-w-prose text-base text-ink"
      >
        {question}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant={variant}
          pending={pending}
          pendingLabel={confirmingLabel}
        >
          {confirmLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {keepLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * The shared ask-then-confirm wrapper.
 *
 * `subject` is sr-only and is what stops a table of N rows announcing N
 * identical "Accept" buttons -- the same reason
 * components/network/request-actions.tsx carries it.
 */
function ConfirmButton({
  action,
  hiddenFields,
  triggerLabel,
  subject,
  question,
  confirmLabel,
  confirmingLabel,
  keepLabel,
  variant,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  hiddenFields: Readonly<Record<string, string>>;
  triggerLabel: string;
  subject?: string;
  question: string;
  confirmLabel: string;
  confirmingLabel: string;
  keepLabel: string;
  variant: "primary" | "danger" | "secondary";
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
        variant={variant}
        onClick={() => setAsking(true)}
      >
        {triggerLabel}
        {subject ? <span className="sr-only"> — {subject}</span> : null}
      </Button>
    );
  }
  return (
    <Confirming
      action={action}
      hiddenFields={hiddenFields}
      questionRef={revealRef}
      onKeyDown={onRevealKeyDown}
      question={question}
      confirmLabel={confirmLabel}
      confirmingLabel={confirmingLabel}
      keepLabel={keepLabel}
      variant={variant}
      onCancel={() => setAsking(false)}
    />
  );
}

// ---------------------------------------------------------------------------
// The superuser's two
// ---------------------------------------------------------------------------

export function StartImpersonationForm({
  sessionId,
  subject,
}: {
  sessionId: string;
  subject: string;
}) {
  return (
    <ConfirmButton
      action={startImpersonationAction}
      hiddenFields={{ sessionId }}
      triggerLabel="Start session"
      subject={subject}
      question={`Start the session on ${subject}? The clock starts now and runs for ${IMPERSONATION_TIME_BOX_MINUTES} minutes; every page you open is recorded against it.`}
      confirmLabel="Yes, start"
      confirmingLabel="Starting…"
      keepLabel="Not yet"
      variant="primary"
    />
  );
}

export function EndImpersonationForm({
  sessionId,
  subject,
}: {
  sessionId: string;
  subject: string;
}) {
  return (
    <ConfirmButton
      action={endImpersonationAction}
      hiddenFields={{ sessionId }}
      triggerLabel="End session"
      subject={subject}
      question={`End the session on ${subject} now? It can’t be resumed — a new request and a new acceptance would be needed.`}
      confirmLabel="Yes, end it"
      confirmingLabel="Ending…"
      keepLabel="Keep it open"
      variant="danger"
    />
  );
}

// ---------------------------------------------------------------------------
// The organisation's three
// ---------------------------------------------------------------------------

export function AcceptImpersonationForm({
  orgSlug,
  sessionId,
  subject,
}: {
  orgSlug: string;
  sessionId: string;
  subject: string;
}) {
  return (
    <ConfirmButton
      action={acceptImpersonationRequestAction}
      hiddenFields={{ orgSlug, sessionId }}
      triggerLabel="Accept"
      subject={subject}
      question={`Give GetSetPaid support read-only access to this workspace? They will be able to see your records — contacts, events, tasks, notes, documents and finance — but change nothing, for ${IMPERSONATION_TIME_BOX_MINUTES} minutes once they start. Every page they open is recorded, and you can end it at any time from this page.`}
      confirmLabel="Yes, allow it"
      confirmingLabel="Accepting…"
      keepLabel="Not now"
      variant="primary"
    />
  );
}

export function DeclineImpersonationForm({
  orgSlug,
  sessionId,
  subject,
}: {
  orgSlug: string;
  sessionId: string;
  subject: string;
}) {
  return (
    <ConfirmButton
      action={declineImpersonationRequestAction}
      hiddenFields={{ orgSlug, sessionId }}
      triggerLabel="Decline"
      subject={subject}
      question="Decline this request? Nothing is shared. Support can ask again later with a new reason, and this refusal stays on the record."
      confirmLabel="Yes, decline"
      confirmingLabel="Declining…"
      keepLabel="Keep it pending"
      variant="danger"
    />
  );
}

export function RevokeImpersonationForm({
  orgSlug,
  sessionId,
  subject,
}: {
  orgSlug: string;
  sessionId: string;
  subject: string;
}) {
  return (
    <ConfirmButton
      action={revokeImpersonationSessionAction}
      hiddenFields={{ orgSlug, sessionId }}
      triggerLabel="End access now"
      subject={subject}
      question="End support access to this workspace right now? Whatever support is looking at stops resolving immediately."
      confirmLabel="Yes, end it"
      confirmingLabel="Ending…"
      keepLabel="Leave it running"
      variant="danger"
    />
  );
}

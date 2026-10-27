"use client";

import { useActionState, type ReactNode } from "react";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import { deleteInvoiceDraftAction } from "@/lib/invoices/actions";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { BLOCKED_NOTE_ID } from "@/lib/invoices/draft-form";

/** The one explanation every disabled invoice control points at (rendered by the page). */

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

function ActionForm({
  action,
  orgSlug,
  invoiceId,
  submitLabel,
  pendingLabel,
  variant = "secondary",
  disabledReason,
  fields,
}: {
  action: Action;
  orgSlug: string;
  invoiceId: string;
  submitLabel: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
  disabledReason: string | null;
  fields?: (state: FormState) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const disabled = disabledReason !== null;
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {fields ? <fieldset disabled={disabled} className="flex flex-col gap-3">{fields(state)}</fieldset> : null}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <div>
        <Button
          type="submit"
          variant={variant}
          disabled={disabled}
          pending={pending}
          pendingLabel={pendingLabel}
          aria-describedby={disabled ? BLOCKED_NOTE_ID : undefined}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function DeleteDraftForm(props: { orgSlug: string; invoiceId: string; disabledReason: string | null }) {
  return <ActionForm {...props} action={deleteInvoiceDraftAction} submitLabel="Delete draft" pendingLabel="Deleting…" variant="danger" />;
}

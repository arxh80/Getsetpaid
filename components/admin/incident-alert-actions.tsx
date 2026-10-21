"use client";

import { useActionState } from "react";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { resolveIncidentAlertAction } from "@/lib/admin/health-actions";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The one control an alert row carries: Resolve.
//
// A PLAIN BUTTON, NOT A REVEAL-CONFIRM, and the difference from the revoke
// buttons beside it in this directory is deliberate: revoking an override
// changes what a customer's workspace can do; resolving an alert changes a
// bookkeeping flag only the operator can see, and it is reversible (the
// action and the guard trigger both support reopening -- the UI just does
// not offer it yet, because an operator who mis-clicks sees the row move to
// the resolved section of the same list, not disappear). A second
// are-you-sure beat would guard against a mistake with no cost.

export function ResolveAlertForm({ alertId }: { alertId: string }) {
  const [state, formAction, pending] = useActionState(
    resolveIncidentAlertAction,
    EMPTY_FORM_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <input type="hidden" name="alertId" value={alertId} />
      <Button type="submit" variant="secondary" pending={pending}>
        {pending ? "Resolving…" : "Resolve"}
      </Button>
    </form>
  );
}

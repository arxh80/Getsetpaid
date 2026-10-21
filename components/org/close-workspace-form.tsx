"use client";

import { useActionState } from "react";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { closeMyWorkspaceAction } from "@/lib/org/closure-actions";
import { CLOSE_REASON_MAX } from "@/lib/org/closure-contract";
import { Field, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { useReportedAction } from "@/components/ui/action-outcome";

// The Owner's "Close this workspace" form (Phase 8 Task 9c job 3b).
//
// THE OUTCOME IS REPORTED TO THE PAGE'S <ActionOutcome> REGION, not rendered
// here. A successful close revalidates the page, and the server half then
// renders a closed statement INSTEAD of this form -- so a confirmation held in
// this component's own state would be thrown away by the very revalidation
// the action caused (the bug class components/ui/action-outcome.tsx exists
// for). Field errors stay local: they only exist while the form does.
//
// The typed slug is not autocompleted, spell-checked or capitalised: it must
// match exactly, and the RPC compares it raw.

export function CloseWorkspaceForm({ orgSlug }: { orgSlug: string }) {
  const reported = useReportedAction(closeMyWorkspaceAction);
  const [state, action, pending] = useActionState(reported, EMPTY_FORM_STATE);

  return (
    <form
      action={action}
      className="flex max-w-prose flex-col gap-4"
      data-testid="close-workspace-form"
    >
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <Field
        label="Type the workspace’s URL name to confirm"
        name="confirmSlug"
        required
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="none"
        autoComplete="off"
        defaultValue={state.values?.confirmSlug ?? ""}
        error={state.fieldErrors?.confirmSlug}
        hint={`Exactly: ${orgSlug}`}
      />
      <TextAreaField
        label="Why are you closing it?"
        name="reason"
        required
        rows={3}
        maxLength={CLOSE_REASON_MAX}
        defaultValue={state.values?.reason ?? ""}
        error={state.fieldErrors?.reason}
        hint={`Up to ${CLOSE_REASON_MAX} characters. GetSetPaid reads it before deciding, it goes on the audit record, and everyone in the workspace sees it on the read-only banner.`}
      />
      <div>
        <Button
          type="submit"
          variant="danger"
          pending={pending}
          pendingLabel="Closing…"
        >
          Close this workspace
        </Button>
      </div>
    </form>
  );
}

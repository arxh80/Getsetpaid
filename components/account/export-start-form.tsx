"use client";

import { useActionState } from "react";
import { startExportAction } from "@/lib/export/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { useReportedAction } from "@/components/ui/action-outcome";

// ONE BUTTON, and its confirmation lives ABOVE everything the button changes.
//
// Starting an export revalidates the page, and the page then renders a list
// that did not exist a moment ago and a button that may now be disabled
// ("an export is already being prepared"). A message held by this component's
// own useActionState would be thrown away by exactly the re-render it caused
// — the bug this phase shipped three times. So the outcome is handed to the
// page’s <ActionOutcome> region through useReportedAction() and this
// component renders no message of its own at all.
// tests/unit/forms/action-outcome-census.test.ts holds this file to that.

export function ExportStartForm({
  kind,
  orgSlug,
  disabled,
  disabledReason,
}: {
  kind: "account" | "workspace";
  /** Only for a workspace export; the action re-resolves it server-side. */
  orgSlug?: string;
  /** True while a job is already queued or running for this subject. */
  disabled?: boolean;
  disabledReason?: string;
}) {
  const reported = useReportedAction(startExportAction);
  const [, formAction, pending] = useActionState(reported, EMPTY_FORM_STATE);

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="kind" value={kind} />
      {orgSlug ? <input type="hidden" name="orgSlug" value={orgSlug} /> : null}
      <Button type="submit" pending={pending} pendingLabel="Starting…" disabled={disabled}>
        {kind === "account" ? "Export my account data" : "Export this workspace"}
      </Button>
      {disabled && disabledReason ? (
        <p className="text-sm text-ink-muted">{disabledReason}</p>
      ) : null}
    </form>
  );
}

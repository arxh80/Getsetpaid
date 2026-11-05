"use client";

import { useActionState } from "react";
import { createDraftFromFinanceAction } from "@/lib/invoices/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { formatGbp } from "@/lib/format/money";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// "Invoice these lines" (spec § Screens 3): tick the event's income lines and
// get a draft with them pulled in and linked; the recipient is picked on the
// draft. Rendered only for a caller who can write finance on a live event
// (plan decision 14).
export function InvoiceFromFinanceForm({
  orgSlug,
  eventId,
  lines,
}: {
  orgSlug: string;
  eventId: string;
  lines: readonly { id: string; description: string | null; amountMinor: number; status: "budgeted" | "actual" }[];
}) {
  const [state, action, pending] = useActionState(createDraftFromFinanceAction, EMPTY_FORM_STATE);
  return (
    <section aria-labelledby="invoice-lines-heading" className="flex flex-col gap-4 border-t border-rule pt-6">
      <h2 id="invoice-lines-heading" className="text-xl font-bold text-ink">Invoice these lines</h2>
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="eventId" value={eventId} />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm text-ink-muted">Tick the income to bill. Each line becomes a line on a new draft invoice.</legend>
          {lines.map((l) => (
            <label key={l.id} className="flex min-h-11 items-center gap-3 text-base text-ink">
              <input type="checkbox" name="entryId" value={l.id} className="size-5 accent-[var(--color-primary)]" />
              <span>
                {l.description ?? "Income"} — <span className="tabular-nums">{formatGbp(l.amountMinor)}</span>{" "}
                <span className="text-ink-muted">({l.status === "budgeted" ? "Budgeted" : "Actual"})</span>
              </span>
            </label>
          ))}
        </fieldset>
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        <div>
          <Button type="submit" variant="secondary" pending={pending} pendingLabel="Creating…">Create draft invoice</Button>
        </div>
      </form>
    </section>
  );
}

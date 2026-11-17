"use client";

import { useActionState } from "react";
import { deliverInvoiceAction, withdrawInvoiceDeliveryAction } from "@/lib/invoices/actions";
import type { DeliveryStateRow } from "@/lib/invoices/delivery";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { formatDate } from "@/lib/format/date";
import { Button } from "@/components/ui/button";
import { useReportedAction } from "@/components/ui/action-outcome";

// INVOICES PART 3: deliver an issued or paid invoice into a connected
// workspace, or withdraw a delivery. Renders NOTHING when there is nothing to
// show: an invoice to a contact, or to an unlinked or unconnected company,
// gets no hint and no suggestion to link (linking stays manual-only).
// Both forms report to the page's <ActionOutcome> region: each one's
// submission revalidates the page into a tree without it.

function DeliverForm({ orgSlug, invoiceId, row }: { orgSlug: string; invoiceId: string; row: DeliveryStateRow }) {
  const reported = useReportedAction(deliverInvoiceAction);
  const [, action, pending] = useActionState(reported, EMPTY_FORM_STATE);
  return (
    <form action={action}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="profileId" value={row.networkProfileId ?? ""} />
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Delivering…">
        Deliver to {row.displayName}
      </Button>
    </form>
  );
}

function WithdrawForm({ orgSlug, invoiceId, row }: { orgSlug: string; invoiceId: string; row: DeliveryStateRow }) {
  const reported = useReportedAction(withdrawInvoiceDeliveryAction);
  const [, action, pending] = useActionState(reported, EMPTY_FORM_STATE);
  return (
    <form action={action}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="deliveryId" value={row.deliveryId ?? ""} />
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Withdrawing…">
        Withdraw
      </Button>
    </form>
  );
}

export function InvoiceDeliveryPanel({
  orgSlug,
  invoiceId,
  rows,
  canDeliver,
  canWithdraw,
}: {
  orgSlug: string;
  invoiceId: string;
  rows: DeliveryStateRow[];
  /** manage_finance + Pro + not suspended (getFinanceWriteAccess). */
  canDeliver: boolean;
  /** manage_finance + not suspended; no tier gate. */
  canWithdraw: boolean;
}) {
  const delivered = rows.filter((r) => r.deliveryId !== null);
  const offers = canDeliver ? rows.filter((r) => r.canDeliver && r.networkProfileId !== null) : [];
  if (delivered.length === 0 && offers.length === 0) return null;
  return (
    <section aria-labelledby="deliver-heading" className="flex max-w-prose flex-col gap-3">
      <h3 id="deliver-heading" className="text-lg font-bold text-ink">Deliver in GetSetPaid</h3>
      {delivered.map((row) => (
        <div key={row.deliveryId} className="flex flex-wrap items-center gap-3">
          <p className="text-base text-ink">
            Delivered{row.displayName ? <> to {row.displayName}</> : null} on{" "}
            <time dateTime={row.deliveredAt ?? undefined} className="tabular-nums">
              {row.deliveredAt ? formatDate(row.deliveredAt) : ""}
            </time>
            .
          </p>
          {canWithdraw ? <WithdrawForm orgSlug={orgSlug} invoiceId={invoiceId} row={row} /> : null}
        </div>
      ))}
      {offers.length > 0 ? (
        <>
          <p className="text-base text-ink-muted">
            Put this invoice straight into their GetSetPaid workspace. Their finance team can read it, download it and pay it there.
          </p>
          {offers.map((row) => (
            <DeliverForm key={row.networkProfileId} orgSlug={orgSlug} invoiceId={invoiceId} row={row} />
          ))}
        </>
      ) : null}
    </section>
  );
}

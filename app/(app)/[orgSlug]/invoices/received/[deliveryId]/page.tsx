import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getFinanceReadAccess } from "@/lib/crm/finance-access";
import { loadReceivedInvoice } from "@/lib/invoices/received";
import { parseSnapshot } from "@/lib/invoices/snapshot";
import { payLinkUrl } from "@/lib/stripe/pay-link";
import { Alert } from "@/components/ui/alert";
import { InvoiceView } from "@/components/invoices/invoice-view";
import { InvoiceStatusChip } from "@/components/invoices/invoice-status-chip";
import { formatDateTime } from "@/lib/format/date";

// A RECEIVED invoice (Invoices part 3), read-only, from the sender's snapshot
// through public.received_invoices. view_finance in THIS workspace, any tier.
// Wrong role, wrong workspace, withdrawn and unknown are all the same not-found.
export async function generateMetadata({ params }: PageProps<"/[orgSlug]/invoices/received/[deliveryId]">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return { title: org ? `Received invoice · ${org.name} · GetSetPaid` : "Not found · GetSetPaid" };
}

export default async function ReceivedInvoicePage({ params }: PageProps<"/[orgSlug]/invoices/received/[deliveryId]">) {
  const { orgSlug, deliveryId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();
  if (!(await getFinanceReadAccess(org))) notFound();
  const result = await loadReceivedInvoice(org.id, deliveryId);
  if (result.outcome === "unavailable") {
    return <Alert tone="error">We couldn’t load this invoice just now. Refresh the page to try again.</Alert>;
  }
  if (result.outcome === "missing") notFound();
  const invoice = result.invoice;
  const snapshot = parseSnapshot(invoice.snapshot);
  const payUrl = invoice.cardPaymentEnabled && invoice.status === "issued" ? payLinkUrl(invoice.invoiceId) : null;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-muted">
        <Link href={`/${org.slug}/invoices/received`} className="text-primary underline underline-offset-4 hover:text-ink">Received invoices</Link>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink tabular-nums">Invoice {invoice.number}</h1>
        <InvoiceStatusChip status={invoice.status} />
      </div>
      <p className="text-base text-ink-muted">
        From {invoice.senderName ?? "a connected workspace"}, received{" "}
        <time dateTime={invoice.deliveredAt} className="tabular-nums">{formatDateTime(invoice.deliveredAt)}</time>.
        This is their copy; nothing has been added to your finance.
      </p>
      {snapshot ? (
        <InvoiceView snapshot={snapshot} />
      ) : (
        <Alert tone="error">This invoice could not be read. Contact the sender.</Alert>
      )}
      <section aria-labelledby="received-actions-heading" className="flex flex-wrap gap-3 border-t border-rule pt-6">
        <h2 id="received-actions-heading" className="sr-only">Actions</h2>
        <a
          href={`/${org.slug}/invoices/received/${invoice.id}/pdf`}
          download
          className="inline-flex h-11 items-center justify-center border border-rule bg-surface px-4 text-base font-semibold text-ink hover:border-ink hover:bg-shell"
        >
          Download PDF
        </a>
        {payUrl ? (
          <a
            href={payUrl}
            className="inline-flex h-11 items-center justify-center border border-primary bg-primary px-4 text-base font-semibold text-on-primary hover:border-ink hover:bg-ink"
          >
            Pay by card
          </a>
        ) : null}
      </section>
    </div>
  );
}

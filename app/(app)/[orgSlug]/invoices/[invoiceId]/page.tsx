import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getFinanceReadAccess, getFinanceWriteAccess } from "@/lib/crm/finance-access";
import { loadLinkOptions } from "@/lib/crm/queries";
import { loadInvoice, loadInvoiceSends, loadInvoiceSettings, type InvoiceDetail } from "@/lib/invoices/queries";
import { parseSnapshot } from "@/lib/invoices/snapshot";
import { minorToPoundsInput } from "@/lib/format/money";
import { Alert } from "@/components/ui/alert";
import { InvoiceEditor } from "@/components/invoices/invoice-editor";
import { BLOCKED_NOTE_ID, type EditorInitial } from "@/lib/invoices/draft-form";
import { InvoiceView } from "@/components/invoices/invoice-view";
import { InvoiceStatusChip } from "@/components/invoices/invoice-status-chip";
import { DeleteDraftForm, IssueInvoiceForm, MarkPaidForm, SendInvoiceForm, VoidInvoiceForm } from "@/components/invoices/invoice-actions";
import { formatDateTime } from "@/lib/format/date";

export async function generateMetadata({ params }: PageProps<"/[orgSlug]/invoices/[invoiceId]">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return { title: org ? `Invoice · ${org.name} · GetSetPaid` : "Not found · GetSetPaid" };
}

function editorInitial(inv: InvoiceDetail): EditorInitial {
  return {
    recipient: inv.recipientCompanyId ? `company:${inv.recipientCompanyId}` : inv.recipientContactId ? `contact:${inv.recipientContactId}` : "",
    eventId: inv.eventId ?? "",
    recipientAddress: inv.recipientAddress ?? "",
    supplyDate: inv.supplyDate ?? "",
    notes: inv.notes ?? "",
    lines: inv.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: minorToPoundsInput(l.unitPriceMinor),
      vatRate: l.vatRate,
      entryId: l.financialEntryId ?? "",
    })),
  };
}

export default async function InvoicePage({ params }: PageProps<"/[orgSlug]/invoices/[invoiceId]">) {
  const { orgSlug, invoiceId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();
  if (!(await getFinanceReadAccess(org))) notFound();
  const [result, access] = await Promise.all([loadInvoice(org.id, invoiceId), getFinanceWriteAccess(org)]);
  if (result.outcome === "unavailable") {
    return <Alert tone="error">We couldn’t load this invoice just now. Refresh the page to try again — nothing has changed.</Alert>;
  }
  if (result.outcome === "missing") notFound();
  const invoice = result.invoice;
  const disabledReason = access.canWrite ? null : access.explanation;
  const blocked = disabledReason ? (
    <p id={BLOCKED_NOTE_ID} className="max-w-prose border border-rule bg-surface px-3 py-3 text-sm text-ink-muted">
      <span className="font-semibold text-ink">Read-only.</span> {disabledReason}
    </p>
  ) : null;
  const back = (
    <p className="text-sm text-ink-muted">
      <Link href={`/${org.slug}/invoices`} className="text-primary underline underline-offset-4 hover:text-ink">Invoices</Link>
    </p>
  );

  if (invoice.status === "draft") {
    const [companies, contacts, events, settings] = await Promise.all([
      loadLinkOptions("companies", org.id, []),
      loadLinkOptions("contacts", org.id, []),
      loadLinkOptions("events", org.id, []),
      loadInvoiceSettings(org.id),
    ]);
    const vatRegistered = settings.outcome === "loaded" && Boolean(settings.settings?.vatNumber);
    return (
      <div className="flex flex-col gap-6">
        {back}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tracking-display text-3xl font-extrabold text-ink">Draft invoice</h1>
          <InvoiceStatusChip status="draft" />
        </div>
        {blocked}
        <InvoiceEditor orgSlug={org.slug} invoiceId={invoice.id} companies={companies} contacts={contacts} events={events} vatRegistered={vatRegistered} initial={editorInitial(invoice)} disabledReason={disabledReason} />
        <section aria-labelledby="issue-heading" className="flex flex-col gap-3 border-t border-rule pt-6">
          <h2 id="issue-heading" className="text-xl font-bold text-ink">Issue</h2>
          <p className="max-w-prose text-base text-ink-muted">
            Issuing gives this draft the next invoice number and freezes it: after that it can be sent, marked paid or voided, never edited. Save any changes first.
          </p>
          <IssueInvoiceForm orgSlug={org.slug} invoiceId={invoice.id} disabledReason={disabledReason} />
        </section>
        <section aria-labelledby="delete-heading" className="flex flex-col gap-3 border-t border-rule pt-6">
          <h2 id="delete-heading" className="text-xl font-bold text-ink">Delete this draft</h2>
          <DeleteDraftForm orgSlug={org.slug} invoiceId={invoice.id} disabledReason={disabledReason} />
        </section>
      </div>
    );
  }

  const snapshot = parseSnapshot(invoice.snapshot);
  // The non-draft branch only: a draft has never been sent.
  const sends = await loadInvoiceSends(org.id, invoice.id);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  return (
    <div className="flex flex-col gap-6">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink tabular-nums">Invoice {invoice.number}</h1>
        <InvoiceStatusChip status={invoice.status} />
      </div>
      {invoice.status === "void" && invoice.voidReason ? (
        <p className="max-w-prose text-base text-ink-muted">Voided: {invoice.voidReason}</p>
      ) : null}
      {blocked}
      {snapshot ? (
        <InvoiceView snapshot={snapshot} />
      ) : (
        <Alert tone="error">This invoice’s issued copy could not be read. Nothing has been changed; contact support.</Alert>
      )}
      <section aria-labelledby="invoice-actions-heading" className="flex flex-col gap-6 border-t border-rule pt-6">
        <h2 id="invoice-actions-heading" className="text-xl font-bold text-ink">Actions</h2>
        <p>
          <a
            href={`/${org.slug}/invoices/${invoice.id}/pdf`}
            download
            className="inline-flex h-11 items-center justify-center border border-rule bg-surface px-4 text-base font-semibold text-ink hover:border-ink hover:bg-shell"
          >
            Download PDF
          </a>
        </p>
        {invoice.status === "issued" || invoice.status === "paid" ? (
          <div className="flex max-w-prose flex-col gap-3">
            <h3 className="text-lg font-bold text-ink">Send by email</h3>
            <SendInvoiceForm orgSlug={org.slug} invoiceId={invoice.id} defaultEmail={snapshot?.recipient.email ?? ""} disabledReason={disabledReason} />
            {sends.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm text-ink-muted">
                {sends.map((s) => (
                  <li key={`${s.sentAt}-${s.toEmail}`}>
                    Sent to {s.toEmail} on <time dateTime={s.sentAt} className="tabular-nums">{formatDateTime(s.sentAt)}</time>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {invoice.status === "issued" ? (
          <div className="flex max-w-prose flex-col gap-3">
            <h3 className="text-lg font-bold text-ink">Record the payment</h3>
            <MarkPaidForm orgSlug={org.slug} invoiceId={invoice.id} today={today} disabledReason={disabledReason} />
          </div>
        ) : null}
        {invoice.status === "issued" || invoice.status === "paid" ? (
          <div className="flex max-w-prose flex-col gap-3 border-t border-rule pt-6">
            <h3 className="text-lg font-bold text-ink">Void</h3>
            <VoidInvoiceForm orgSlug={org.slug} invoiceId={invoice.id} disabledReason={disabledReason} />
          </div>
        ) : null}
      </section>
    </div>
  );
}

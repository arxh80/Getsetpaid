import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getFinanceReadAccess, getFinanceWriteAccess } from "@/lib/crm/finance-access";
import { loadLinkOptions } from "@/lib/crm/queries";
import { loadInvoiceSettings } from "@/lib/invoices/queries";
import { InvoiceEditor } from "@/components/invoices/invoice-editor";
import { BLOCKED_NOTE_ID, EMPTY_LINE } from "@/lib/invoices/draft-form";

export async function generateMetadata({ params }: PageProps<"/[orgSlug]/invoices/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return { title: org ? `New invoice · ${org.name} · GetSetPaid` : "Not found · GetSetPaid" };
}

export default async function NewInvoicePage({ params }: PageProps<"/[orgSlug]/invoices/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();
  if (!(await getFinanceReadAccess(org))) notFound();
  const [access, companies, contacts, events, settings] = await Promise.all([
    getFinanceWriteAccess(org),
    loadLinkOptions("companies", org.id, []),
    loadLinkOptions("contacts", org.id, []),
    loadLinkOptions("events", org.id, []),
    loadInvoiceSettings(org.id),
  ]);
  const vatRegistered = settings.outcome === "loaded" && Boolean(settings.settings?.vatNumber);
  const disabledReason = access.canWrite ? null : access.explanation;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-muted">
        <Link href={`/${org.slug}/invoices`} className="text-primary underline underline-offset-4 hover:text-ink">Invoices</Link>
      </p>
      <h1 className="tracking-display text-3xl font-extrabold text-ink">New invoice</h1>
      {disabledReason ? (
        <p id={BLOCKED_NOTE_ID} className="max-w-prose border border-rule bg-surface px-3 py-3 text-sm text-ink-muted">
          <span className="font-semibold text-ink">Read-only.</span> {disabledReason}
        </p>
      ) : null}
      <InvoiceEditor
        orgSlug={org.slug}
        invoiceId={null}
        companies={companies}
        contacts={contacts}
        events={events}
        vatRegistered={vatRegistered}
        initial={{ recipient: "", eventId: "", recipientAddress: "", supplyDate: "", notes: "", lines: [{ ...EMPTY_LINE, vatRate: vatRegistered ? "standard_20" : "none" }] }}
        disabledReason={disabledReason}
      />
    </div>
  );
}

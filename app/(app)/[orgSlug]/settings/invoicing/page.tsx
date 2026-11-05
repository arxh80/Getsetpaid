import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getFinanceReadAccess, getFinanceWriteAccess } from "@/lib/crm/finance-access";
import { loadInvoiceSettings } from "@/lib/invoices/queries";
import { StepUpGate } from "@/components/auth/step-up-gate";
import { Alert } from "@/components/ui/alert";
import { InvoiceSettingsForm } from "@/components/invoices/invoice-settings-form";

// Settings › Invoicing (Invoices part 1). Rendered for view_finance holders
// only (Owner, Admin, Finance); anyone else gets the same not-found as a page
// that does not exist. Saving needs finance WRITE access AND a fresh
// credential (step-up): the gate renders the re-auth prompt when the
// session's last credential is over five minutes old, and the action
// re-checks it server-side either way.
export async function generateMetadata({ params }: PageProps<"/[orgSlug]/settings/invoicing">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return { title: org ? `Invoicing · Settings · ${org.name} · GetSetPaid` : "Not found · GetSetPaid" };
}

export default async function InvoiceSettingsPage({ params }: PageProps<"/[orgSlug]/settings/invoicing">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();
  if (!(await getFinanceReadAccess(org))) notFound();

  const [loaded, access] = await Promise.all([loadInvoiceSettings(org.id), getFinanceWriteAccess(org)]);
  const disabledReason = access.canWrite ? null : access.explanation;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Invoice settings</h1>
        <p className="max-w-prose text-lg text-ink-muted">
          What every invoice from {org.name} says about who it is from and how to pay it.
        </p>
      </div>
      {loaded.outcome === "unavailable" ? (
        <Alert tone="error">We couldn’t load the invoice settings just now. Refresh the page to try again — nothing has changed.</Alert>
      ) : disabledReason === null ? (
        <StepUpGate next={`/${org.slug}/settings/invoicing`}>
          <InvoiceSettingsForm orgSlug={org.slug} settings={loaded.settings} disabledReason={null} />
        </StepUpGate>
      ) : (
        <InvoiceSettingsForm orgSlug={org.slug} settings={loaded.settings} disabledReason={disabledReason} />
      )}
    </div>
  );
}

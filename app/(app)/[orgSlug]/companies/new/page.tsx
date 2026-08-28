import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { CompanyForm } from "@/components/crm/company-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";

// New company. See the contacts equivalent for why the ROUTE is gated and not
// only the button that leads to it.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/companies/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `New company · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NewCompanyPage({
  params,
}: PageProps<"/[orgSlug]/companies/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const access = await getCrmWriteAccess(org, "manage_contacts");
  const basePath = `/${org.slug}/companies`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Companies
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          New company
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          A business this workspace deals with. Only a name is required — the
          type can wait until you know it.
        </p>
      </div>

      {access.canWrite ? (
        <CompanyForm
          orgSlug={org.slug}
          values={{ name: "", type: [] }}
          cancelHref={basePath}
        />
      ) : (
        <WriteBlockedNote access={access} id="new-company-blocked" />
      )}
    </div>
  );
}

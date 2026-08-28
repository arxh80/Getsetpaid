import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadCompany } from "@/lib/crm/queries";
import { CompanyForm } from "@/components/crm/company-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { Alert } from "@/components/ui/alert";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/companies/[companyId]/edit">): Promise<Metadata> {
  const { orgSlug, companyId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadCompany(org.id, companyId);
  return {
    title:
      result.outcome === "found"
        ? `Edit ${result.record.name} · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function EditCompanyPage({
  params,
}: PageProps<"/[orgSlug]/companies/[companyId]/edit">) {
  const { orgSlug, companyId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadCompany(org.id, companyId),
    getCrmWriteAccess(org, "manage_contacts"),
  ]);

  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this company just now. Refresh the page to try again —
        nothing has been changed.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const company = result.record;
  const detailHref = `/${org.slug}/companies/${company.id}`;

  const breadcrumb = (
    <p className="text-sm text-ink-muted">
      <Link
        href={`/${org.slug}/companies`}
        className="text-primary underline underline-offset-4 hover:text-ink"
      >
        Companies
      </Link>
      {" › "}
      <Link
        href={detailHref}
        className="break-words text-primary underline underline-offset-4 hover:text-ink"
      >
        {company.name}
      </Link>
    </p>
  );

  // A deleted company is not editable and is not a 404 -- see the contact
  // equivalent. updateCompanyAction's predicate carries `deleted_at is null`,
  // so a submit from here would match no rows and be reported as refused.
  if (company.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb}
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Edit company
        </h1>
        <Alert tone="info">
          {company.name} has been deleted, so it can’t be edited. Restore it
          from its own page first and the form will be here.
        </Alert>
        <p>
          <Link
            href={detailHref}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            Go to {company.name}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {breadcrumb}
      <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
        Edit {company.name}
      </h1>

      {access.canWrite ? (
        <CompanyForm
          orgSlug={org.slug}
          values={{ id: company.id, name: company.name, type: company.type }}
          cancelHref={detailHref}
        />
      ) : (
        <WriteBlockedNote access={access} id="edit-company-blocked" />
      )}
    </div>
  );
}

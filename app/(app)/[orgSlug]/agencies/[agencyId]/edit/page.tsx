import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadAgency } from "@/lib/crm/queries";
import { AgencyForm } from "@/components/crm/agency-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { Alert } from "@/components/ui/alert";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/agencies/[agencyId]/edit">): Promise<Metadata> {
  const { orgSlug, agencyId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadAgency(org.id, agencyId);
  return {
    title:
      result.outcome === "found"
        ? `Edit ${result.record.name} · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function EditAgencyPage({
  params,
}: PageProps<"/[orgSlug]/agencies/[agencyId]/edit">) {
  const { orgSlug, agencyId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadAgency(org.id, agencyId),
    getCrmWriteAccess(org, "manage_contacts"),
  ]);

  // A FAILED QUERY IS NOT A MISSING RECORD. "There is no such agency" is a
  // claim about the customer's data, and making it because the database was
  // unreachable reads as deletion.
  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this agency just now. Refresh the page to try again —
        nothing has been changed.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const agency = result.record;
  const detailHref = `/${org.slug}/agencies/${agency.id}`;

  const breadcrumb = (
    <p className="text-sm text-ink-muted">
      <Link
        href={`/${org.slug}/agencies`}
        className="text-primary underline underline-offset-4 hover:text-ink"
      >
        Agencies
      </Link>
      {" › "}
      <Link
        href={detailHref}
        className="break-words text-primary underline underline-offset-4 hover:text-ink"
      >
        {agency.name}
      </Link>
    </p>
  );

  // A deleted agency is not editable and is not a 404. `updateAgencyAction`'s
  // predicate carries `deleted_at is null`, so a submit from here would match
  // no rows and be reported as refused -- this says so before the user types.
  if (agency.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb}
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Edit agency
        </h1>
        <Alert tone="info">
          {agency.name} has been deleted, so it can’t be edited. Restore it from
          its own page first and the form will be here.
        </Alert>
        <p>
          <Link
            href={detailHref}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            Go to {agency.name}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {breadcrumb}
      <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
        Edit {agency.name}
      </h1>

      {access.canWrite ? (
        <AgencyForm
          orgSlug={org.slug}
          values={{ id: agency.id, name: agency.name }}
          cancelHref={detailHref}
        />
      ) : (
        <WriteBlockedNote access={access} id="edit-agency-blocked" />
      )}
    </div>
  );
}

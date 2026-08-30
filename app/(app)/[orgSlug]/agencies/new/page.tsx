import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { AgencyForm } from "@/components/crm/agency-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";

// New agency.
//
// THE ROUTE IS GATED, NOT ONLY THE BUTTON THAT LEADS TO IT. A user who types
// this URL, or follows a stale link, gets the same explanation rather than a
// form that submits and is refused -- and the explanation is the SAME STRING
// the disabled button carries, because `getCrmWriteAccess()` produces both.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/agencies/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `New agency · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NewAgencyPage({
  params,
}: PageProps<"/[orgSlug]/agencies/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const access = await getCrmWriteAccess(org, "manage_contacts");
  const basePath = `/${org.slug}/agencies`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Agencies
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          New agency
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          A booking or management agency. Only a name is needed — who they
          represent, in what territory and from when goes on the agency’s own
          page once it exists.
        </p>
      </div>

      {access.canWrite ? (
        <AgencyForm orgSlug={org.slug} values={{ name: "" }} cancelHref={basePath} />
      ) : (
        <WriteBlockedNote access={access} id="new-agency-blocked" />
      )}
    </div>
  );
}

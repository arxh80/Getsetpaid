import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { VenueForm } from "@/components/crm/venue-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";

// New venue. The ROUTE is gated, not only the button that leads to it.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/venues/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `New venue · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NewVenuePage({
  params,
}: PageProps<"/[orgSlug]/venues/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const access = await getCrmWriteAccess(org, "manage_venues");
  const basePath = `/${org.slug}/venues`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Venues
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          New venue
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          A place you put events on. Only a name is required — capacity,
          address and technical information can wait until you know them, and
          rooms are added on the venue’s own page.
        </p>
      </div>

      {access.canWrite ? (
        <VenueForm
          orgSlug={org.slug}
          values={{
            name: "",
            address: "",
            location: "",
            capacity: "",
            website: "",
            technicalInfo: "",
            socials: {},
          }}
          cancelHref={basePath}
        />
      ) : (
        <WriteBlockedNote access={access} id="new-venue-blocked" />
      )}
    </div>
  );
}

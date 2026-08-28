import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadVenue } from "@/lib/crm/queries";
import { VenueForm } from "@/components/crm/venue-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { Alert } from "@/components/ui/alert";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/venues/[venueId]/edit">): Promise<Metadata> {
  const { orgSlug, venueId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadVenue(org.id, venueId);
  return {
    title:
      result.outcome === "found"
        ? `Edit ${result.record.name} · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function EditVenuePage({
  params,
}: PageProps<"/[orgSlug]/venues/[venueId]/edit">) {
  const { orgSlug, venueId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadVenue(org.id, venueId),
    getCrmWriteAccess(org, "manage_venues"),
  ]);

  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this venue just now. Refresh the page to try again —
        nothing has been changed.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const venue = result.record;
  const detailHref = `/${org.slug}/venues/${venue.id}`;

  const breadcrumb = (
    <p className="text-sm text-ink-muted">
      <Link
        href={`/${org.slug}/venues`}
        className="text-primary underline underline-offset-4 hover:text-ink"
      >
        Venues
      </Link>
      {" › "}
      <Link
        href={detailHref}
        className="break-words text-primary underline underline-offset-4 hover:text-ink"
      >
        {venue.name}
      </Link>
    </p>
  );

  // A deleted venue is not editable and is not a 404.
  if (venue.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb}
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Edit venue
        </h1>
        <Alert tone="info">
          {venue.name} has been deleted, so it can’t be edited. Restore it from
          its own page first and the form will be here.
        </Alert>
        <p>
          <Link
            href={detailHref}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            Go to {venue.name}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {breadcrumb}
      <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
        Edit {venue.name}
      </h1>

      {access.canWrite ? (
        <VenueForm
          orgSlug={org.slug}
          values={{
            id: venue.id,
            name: venue.name,
            address: venue.address ?? "",
            location: venue.location ?? "",
            // The empty string, NOT "0". `checkCapacity` turns an empty input
            // back into NULL, so a venue whose capacity nobody knows stays
            // unknown through an edit of another field.
            capacity: venue.capacity === null ? "" : String(venue.capacity),
            website: venue.website ?? "",
            technicalInfo: venue.technicalInfo ?? "",
            socials: venue.socialsRaw,
          }}
          cancelHref={detailHref}
        />
      ) : (
        <WriteBlockedNote access={access} id="edit-venue-blocked" />
      )}
    </div>
  );
}

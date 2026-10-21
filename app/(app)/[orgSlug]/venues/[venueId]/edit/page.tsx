import { loadVenue } from "@/lib/crm/queries";
import { VenueForm } from "@/components/crm/venue-form";
import { editRecordPage } from "@/components/crm/edit-record-page";

const { generateMetadata, Page } = editRecordPage({
  segment: "venues",
  backLabel: "Venues",
  noun: "venue",
  pronoun: "it",
  paramKey: "venueId",
  permissionKey: "manage_venues",
  load: loadVenue,
  label: (venue) => venue.name,
  deletedAt: (venue) => venue.deletedAt,
  form: ({ org, record, detailHref }) => (
    <VenueForm
      orgSlug={org.slug}
      values={{
        id: record.id,
        name: record.name,
        address: record.address ?? "",
        location: record.location ?? "",
        capacity: record.capacity === null ? "" : String(record.capacity),
        website: record.website ?? "",
        technicalInfo: record.technicalInfo ?? "",
        socials: record.socialsRaw,
      }}
      cancelHref={detailHref}
    />
  ),
});

export { generateMetadata };
export default Page;

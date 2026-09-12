import { VenueForm } from "@/components/crm/venue-form";
import { newRecordPage } from "@/components/crm/new-record-page";

const { generateMetadata, Page } = newRecordPage({
  segment: "venues",
  backLabel: "Venues",
  title: "New venue",
  blurb: (
    <>
      A place you put events on. Only a name is required — capacity, address and
      technical information can wait until you know them, and rooms are added on
      the venue’s own page.
    </>
  ),
  permissionKey: "manage_venues",
  blockedId: "new-venue-blocked",
  form: ({ org, basePath }) => (
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
  ),
});

export { generateMetadata };
export default Page;

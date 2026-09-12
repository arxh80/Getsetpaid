import { ArtistForm } from "@/components/crm/artist-form";
import { newRecordPage } from "@/components/crm/new-record-page";

const { generateMetadata, Page } = newRecordPage({
  segment: "artists",
  backLabel: "Artists",
  title: "New artist",
  blurb: (
    <>
      An artist or DJ you book. Only a name is required — who represents them
      goes on the artist’s own page once it exists.
    </>
  ),
  permissionKey: "manage_artists",
  blockedId: "new-artist-blocked",
  form: ({ org, basePath }) => (
    <ArtistForm
      orgSlug={org.slug}
      values={{
        name: "",
        genres: "",
        country: "",
        city: "",
        website: "",
        notes: "",
        socials: {},
      }}
      cancelHref={basePath}
    />
  ),
});

export { generateMetadata };
export default Page;

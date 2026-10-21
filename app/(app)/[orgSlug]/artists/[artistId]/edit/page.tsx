import { loadArtist } from "@/lib/crm/queries";
import { formatTags } from "@/lib/crm/validate";
import { ArtistForm } from "@/components/crm/artist-form";
import { editRecordPage } from "@/components/crm/edit-record-page";

// PRONOUN "they", AND IT IS THE ONLY ONE. An artist is a person or an act, so
// the refusal sentence reads "so they can't be edited. Restore them from their
// own page" where every other entity reads it/its. That difference shipped in
// the hand-written copy and is preserved here rather than flattened.
const { generateMetadata, Page } = editRecordPage({
  segment: "artists",
  backLabel: "Artists",
  noun: "artist",
  pronoun: "they",
  paramKey: "artistId",
  permissionKey: "manage_artists",
  load: loadArtist,
  label: (artist) => artist.name,
  deletedAt: (artist) => artist.deletedAt,
  form: ({ org, record, detailHref }) => (
    <ArtistForm
      orgSlug={org.slug}
      values={{
        id: record.id,
        name: record.name,
        genres: formatTags(record.genres),
        country: record.country ?? "",
        city: record.city ?? "",
        website: record.website ?? "",
        notes: record.notes ?? "",
        socials: record.socialsRaw,
      }}
      cancelHref={detailHref}
    />
  ),
});

export { generateMetadata };
export default Page;

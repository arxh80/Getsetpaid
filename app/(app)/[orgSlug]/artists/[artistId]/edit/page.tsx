import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadArtist } from "@/lib/crm/queries";
import { formatTags } from "@/lib/crm/validate";
import { ArtistForm } from "@/components/crm/artist-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { Alert } from "@/components/ui/alert";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/artists/[artistId]/edit">): Promise<Metadata> {
  const { orgSlug, artistId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadArtist(org.id, artistId);
  return {
    title:
      result.outcome === "found"
        ? `Edit ${result.record.name} · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function EditArtistPage({
  params,
}: PageProps<"/[orgSlug]/artists/[artistId]/edit">) {
  const { orgSlug, artistId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadArtist(org.id, artistId),
    getCrmWriteAccess(org, "manage_artists"),
  ]);

  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this artist just now. Refresh the page to try again —
        nothing has been changed.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const artist = result.record;
  const detailHref = `/${org.slug}/artists/${artist.id}`;

  const breadcrumb = (
    <p className="text-sm text-ink-muted">
      <Link
        href={`/${org.slug}/artists`}
        className="text-primary underline underline-offset-4 hover:text-ink"
      >
        Artists
      </Link>
      {" › "}
      <Link
        href={detailHref}
        className="break-words text-primary underline underline-offset-4 hover:text-ink"
      >
        {artist.name}
      </Link>
    </p>
  );

  // A deleted artist is not editable and is not a 404. `updateArtistAction`'s
  // predicate carries `deleted_at is null`, so a submit from here would match
  // no rows and be reported as refused -- this says so before the user types.
  if (artist.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb}
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Edit artist
        </h1>
        <Alert tone="info">
          {artist.name} has been deleted, so they can’t be edited. Restore them
          from their own page first and the form will be here.
        </Alert>
        <p>
          <Link
            href={detailHref}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            Go to {artist.name}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {breadcrumb}
      <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
        Edit {artist.name}
      </h1>

      {access.canWrite ? (
        <ArtistForm
          orgSlug={org.slug}
          values={{
            id: artist.id,
            name: artist.name,
            // The same comma-joined shape `parseGenres` reads back, so the
            // round trip through the form is lossless.
            genres: formatTags(artist.genres),
            country: artist.country ?? "",
            city: artist.city ?? "",
            website: artist.website ?? "",
            notes: artist.notes ?? "",
            socials: artist.socialsRaw,
          }}
          cancelHref={detailHref}
        />
      ) : (
        <WriteBlockedNote access={access} id="edit-artist-blocked" />
      )}
    </div>
  );
}

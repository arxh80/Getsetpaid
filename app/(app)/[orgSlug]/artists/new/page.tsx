import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { ArtistForm } from "@/components/crm/artist-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";

// New artist. The ROUTE is gated, not only the button that leads to it.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/artists/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `New artist · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NewArtistPage({
  params,
}: PageProps<"/[orgSlug]/artists/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const access = await getCrmWriteAccess(org, "manage_artists");
  const basePath = `/${org.slug}/artists`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Artists
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          New artist
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          An artist or DJ you book. Only a name is required — who represents
          them goes on the artist’s own page once it exists.
        </p>
      </div>

      {access.canWrite ? (
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
      ) : (
        <WriteBlockedNote access={access} id="new-artist-blocked" />
      )}
    </div>
  );
}

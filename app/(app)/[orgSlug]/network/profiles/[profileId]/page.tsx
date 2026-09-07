import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getNetworkReadAccess, getNetworkPublishAccessForEntity } from "@/lib/network/access";
import { loadEntityName, loadNetworkProfileById } from "@/lib/network/entities";
import { NETWORK_ENTITY_KIND_LABELS, type NetworkEntityKind } from "@/lib/network/fields";
import { ProfileEditor, PublishToggleForm } from "@/components/network/profile-editor";
import { ProfileStatusChip } from "@/components/network/profile-status-chip";
import { DeleteRecordForm } from "@/components/crm/delete-restore";
import { deleteNetworkProfileAction } from "@/lib/network/profiles";
import { Alert } from "@/components/ui/alert";

// The publish-field editor. THE MOST CONSEQUENTIAL SCREEN IN THE PRODUCT.
//
// ===========================================================================
// THE RENDER GATE, GATHERED HERE AND HANDED DOWN AS A RESULT, NOT A RECIPE
// ===========================================================================
// `getNetworkReadAccess(org)` decides whether this route exists for the
// caller at all (a suspended workspace, the rare real refusal). `getNetwork
// PublishAccessForEntity(org, profile.entityKind)` -- THE M4 CLOSURE -- is
// resolved ONLY AFTER the profile itself is loaded, because it needs the
// profile's own entity_kind: a marketing user editing a COMPANY profile
// passes it (manage_contacts); the SAME marketing user opening an ARTIST
// profile's editor does not (no manage_artists), and sees every control
// disabled with that exact sentence rather than a control the database would
// then refuse.
export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/network/profiles/[profileId]">): Promise<Metadata> {
  const { orgSlug, profileId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const profile = await loadNetworkProfileById(org.id, profileId);
  return {
    title: profile
      ? `${profile.displayName} · Network profiles · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NetworkProfileEditorPage({
  params,
}: PageProps<"/[orgSlug]/network/profiles/[profileId]">) {
  const { orgSlug, profileId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const canRead = await getNetworkReadAccess(org);
  const basePath = `/${org.slug}/network/profiles`;
  const backLink = (
    <p className="text-sm text-ink-muted">
      <Link
        href={basePath}
        className="text-primary underline underline-offset-4 hover:text-ink"
      >
        Network profiles
      </Link>
    </p>
  );

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <Alert tone="info">
          This workspace is suspended, so the network area is read-only in a
          way that includes not browsing it right now. Contact GetSetPaid
          support to have it reinstated.
        </Alert>
      </div>
    );
  }

  const profile = await loadNetworkProfileById(org.id, profileId);
  // NULL COVERS "no such profile", "another tenant's" and "soft-deleted"
  // ALIKE, ON PURPOSE -- the same enumeration-oracle argument DESIGN.md
  // makes for every other record in this product, applied to a profile.
  if (!profile) notFound();

  const [access, entityName] = await Promise.all([
    getNetworkPublishAccessForEntity(org, profile.entityKind),
    loadEntityName(org.id, profile.entityKind, profile.entityId),
  ]);
  const disabled = !access.canWrite;
  const disabledExplanation = access.canWrite ? null : access.explanation;
  const manageNoteId = "network-profile-manage-blocked";

  return (
    <div className="flex flex-col gap-8">
      {backLink}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
            {profile.displayName}
          </h1>
          <ProfileStatusChip status={profile.status} />
        </div>
        <p className="text-base text-ink-muted">
          {NETWORK_ENTITY_KIND_LABELS[profile.entityKind]}
          {entityName ? (
            <>
              {" · "}
              <Link
                href={`/${org.slug}/${entityLinkSegment(profile.entityKind)}/${profile.entityId}`}
                className="text-primary underline underline-offset-4 hover:text-ink"
              >
                View the record
              </Link>
            </>
          ) : null}
        </p>
      </div>

      <ProfileEditor
        orgSlug={org.slug}
        profileId={profile.id}
        stored={{
          displayName: profile.displayName,
          headline: profile.headline,
          bio: profile.bio,
          city: profile.city,
          region: profile.region,
          country: profile.country,
          website_url: profile.websiteUrl,
          contact_email: profile.contactEmail,
          visibility: profile.fieldVisibility,
        }}
        disabled={disabled}
        disabledExplanation={disabledExplanation}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Publish</h2>
        <PublishToggleForm
          orgSlug={org.slug}
          profileId={profile.id}
          status={profile.status}
          disabled={disabled}
          disabledExplanation={disabledExplanation}
        />
      </section>

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Manage</h2>
        {disabled ? (
          <p id={manageNoteId} className="max-w-prose text-sm text-ink-muted">
            {disabledExplanation}
          </p>
        ) : null}
        <DeleteRecordForm
          action={deleteNetworkProfileAction}
          hiddenFields={{ orgSlug: org.slug, profileId: profile.id }}
          label="Delete this network profile"
          question={`Delete this network profile? It comes out of the network directory${
            profile.status === "published" ? " immediately" : ""
          }, and out of your own profiles list. You can publish a new one for the same record later.`}
          blocked={disabled}
          describedBy={manageNoteId}
        />
      </section>
    </div>
  );
}

/** The URL segment each entity kind's own detail pages live under. */
const ENTITY_LINK_SEGMENT: Record<NetworkEntityKind, string> = {
  company: "companies",
  artist: "artists",
  venue: "venues",
  agency: "agencies",
};

function entityLinkSegment(kind: NetworkEntityKind): string {
  return ENTITY_LINK_SEGMENT[kind];
}

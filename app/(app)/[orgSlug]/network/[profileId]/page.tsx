import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getNetworkReadAccess, getNetworkConnectionAccess } from "@/lib/network/access";
import { loadNetworkProfileForViewer, type NetworkProfileForViewer } from "@/lib/network/discovery";
import {
  loadNetworkProfileById,
  loadOwnPublishedProfiles,
  type NetworkProfileDetail,
  type OwnPublishedProfile,
} from "@/lib/network/entities";
import {
  NETWORK_ENTITY_KIND_LABELS,
  NETWORK_ENTITY_URL_SEGMENT,
} from "@/lib/network/fields";
import type { NetworkDirectoryRow } from "@/lib/network/discovery-list";
import type { CrmWriteAccess } from "@/lib/crm/write-access";
import { ProfileCard } from "@/components/network/profile-card";
import { ProfileStatusChip } from "@/components/network/profile-status-chip";
import { ConnectButton } from "@/components/network/connect-button";
import { Alert } from "@/components/ui/alert";

// Task 3: a published profile, as ONE caller may see it -- the discovery
// area's detail page. Read path only.
//
// ===========================================================================
// TWO SOURCES, ONE ROUTE, AND THE BRANCH IS DECIDED BY OWNERSHIP FIRST
// ===========================================================================
// `loadNetworkProfileForViewer` (lib/network/discovery.ts) answers "what can
// ANY caller see of this profile" and never touches `network_profiles`.
// `loadNetworkProfileById` (lib/network/entities.ts, Task 2) answers "is this
// MY organisation's OWN profile" and is scoped to `organisation_id =
// organisationId` -- the caller's own, never a foreign one. Both are asked, in
// parallel, and OWNERSHIP WINS: an organisation viewing its own profile sees
// the full stored record (which is exactly its published `network`- and
// `connections`-level fields -- N3 means a `hidden` field has no value to show
// even here) with a Draft/Published chip, rather than the masked view of
// itself. That is what makes "owner sees own draft with Draft chip" true
// without a third code path: the views never carry a draft at all (both
// require `status = 'published'`), so `viewer` is null for one and `own` is
// the only source with an answer.
//
// A caller with NEITHER answer -- a foreign draft, a foreign soft-deleted
// profile, or an id that never existed -- gets `notFound()`. All three
// collapse to the identical 404, on purpose: DESIGN.md's enumeration-oracle
// argument, applied to a profile rather than a CRM record. Nothing here tells
// a prober which of the three they hit.
export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/network/[profileId]">): Promise<Metadata> {
  const { orgSlug, profileId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const [viewer, own] = await Promise.all([
    loadNetworkProfileForViewer(profileId),
    loadNetworkProfileById(org.id, profileId),
  ]);
  const name = own?.displayName ?? viewer?.row.displayName;
  return {
    title: name ? `${name} · Network · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function NetworkProfileViewPage({
  params,
}: PageProps<"/[orgSlug]/network/[profileId]">) {
  const { orgSlug, profileId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const backLink = (
    <p className="text-sm text-ink-muted">
      <Link
        href={`/${org.slug}/network`}
        className="text-primary underline underline-offset-4 hover:text-ink"
      >
        Network
      </Link>
    </p>
  );

  const canRead = await getNetworkReadAccess(org);
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

  const [viewer, own] = await Promise.all([
    loadNetworkProfileForViewer(profileId),
    loadNetworkProfileById(org.id, profileId),
  ]);

  if (own) {
    return (
      <div className="flex flex-col gap-8">
        {backLink}
        <OwnProfileView orgSlug={org.slug} own={own} />
      </div>
    );
  }

  if (!viewer) {
    // Neither this organisation's own record (drafts included) nor a
    // published one anybody may browse. Same 404 as a nonexistent id.
    notFound();
  }

  // TASK 4: real access AND the sender's own published profiles, both needed
  // by ConnectButton -- loaded in parallel, since neither depends on the
  // other and `ownProfiles` is a plain read of THIS organisation's own rows
  // (never a cross-tenant query).
  const [connectAccess, sendFrom] = await Promise.all([
    getNetworkConnectionAccess(org),
    loadOwnPublishedProfiles(org.id),
  ]);
  return (
    <div className="flex flex-col gap-8">
      {backLink}
      <PublicProfileView
        orgSlug={org.slug}
        viewer={viewer}
        connectAccess={connectAccess}
        ownProfiles={sendFrom.profiles}
        moreOwnProfiles={sendFrom.more}
      />
    </div>
  );
}

function OwnProfileView({
  orgSlug,
  own,
}: {
  orgSlug: string;
  own: NetworkProfileDetail;
}) {
  // A `NetworkDirectoryRow`-SHAPED VIEW OF OUR OWN STORED DATA, so this reuses
  // `ProfileCard` rather than re-deriving its render rules. `""` becomes
  // `null` for exactly the reason `NetworkDirectoryRow`'s own header gives:
  // ProfileCard omits a null field rather than rendering an empty line, and
  // `loadNetworkProfileById` returns `""` for an absent column (its own
  // convention) where the views return `null` (theirs). `publishedAt` is not
  // fetched by that lookup, so it is omitted here rather than guessed.
  const row: NetworkDirectoryRow = {
    id: own.id,
    entityKind: own.entityKind,
    displayName: own.displayName,
    headline: own.headline || null,
    bio: own.bio || null,
    city: own.city || null,
    region: own.region || null,
    country: own.country || null,
    websiteUrl: own.websiteUrl || null,
    contactEmail: own.contactEmail || null,
    publishedAt: null,
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
            {own.displayName}
          </h1>
          <ProfileStatusChip status={own.status} />
        </div>
        <p className="text-base text-ink-muted">
          {NETWORK_ENTITY_KIND_LABELS[own.entityKind]}
          {" · "}
          <Link
            href={`/${orgSlug}/${NETWORK_ENTITY_URL_SEGMENT[own.entityKind]}/${own.entityId}`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            View the record
          </Link>
        </p>
        <Alert tone="info">
          This is your own profile, shown as your workspace stored it. A
          field left at “Hidden” has no value to show here either — that is
          what makes hiding it a real removal rather than a mask. Manage what
          is published from{" "}
          <Link
            href={`/${orgSlug}/network/profiles/${own.id}`}
            className="font-semibold underline underline-offset-4"
          >
            your network profiles
          </Link>
          .
        </Alert>
      </div>

      <ProfileCard row={row} />
    </div>
  );
}

function PublicProfileView({
  orgSlug,
  viewer,
  connectAccess,
  ownProfiles,
  moreOwnProfiles,
}: {
  orgSlug: string;
  viewer: NetworkProfileForViewer;
  connectAccess: CrmWriteAccess;
  ownProfiles: readonly OwnPublishedProfile[];
  moreOwnProfiles: boolean;
}) {
  const { row, source } = viewer;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
            {row.displayName}
          </h1>
          {/* Both source views require status = 'published', so this is
              always true of anything reaching this branch -- rendered rather
              than inferred, for the same reason every other status in this
              product is a chip and not a fact left to the reader. */}
          <ProfileStatusChip status="published" />
        </div>
        <p className="text-base text-ink-muted">
          {NETWORK_ENTITY_KIND_LABELS[row.entityKind]}
        </p>
        {source === "connected" ? (
          <Alert tone="success">
            You’re connected. Fields this profile marked “Connections only”
            are included below, alongside the ones it published to everyone.
          </Alert>
        ) : null}
      </div>

      <ProfileCard row={row} />

      {/* THE REQUEST CONTROL. Task 3 shipped it rendered-and-disabled, never
          hidden (Constraint 12); this is where Task 4 gives it a real
          `action`. `ConnectButton` keeps the same three-state shape Task 3's
          shell established (suspended/tier/permission -> "no published
          profile" -> a real form), so a caller who strips the `disabled`
          attribute from the FIRST two states still meets a real, database-
          enforced refusal rather than a client-side no-op -- the
          `tests/e2e/finance.spec.ts:265-287` strip-and-submit pattern this
          task's own acceptance criteria name. */}
      <ConnectButton
        orgSlug={orgSlug}
        toProfileId={row.id}
        canWrite={connectAccess.canWrite}
        explanation={connectAccess.canWrite ? undefined : connectAccess.explanation}
        ownProfiles={ownProfiles}
        moreOwnProfiles={moreOwnProfiles}
      />
    </div>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getNetworkReadAccess, getNetworkConnectionAccess } from "@/lib/network/access";
import { loadNetworkProfileForViewer, type NetworkProfileForViewer } from "@/lib/network/discovery";
import { loadNetworkProfileById, type NetworkProfileDetail } from "@/lib/network/entities";
import { NETWORK_ENTITY_KIND_LABELS } from "@/lib/network/fields";
import type { NetworkDirectoryRow } from "@/lib/network/discovery-list";
import type { CrmWriteAccess } from "@/lib/crm/write-access";
import { ProfileCard } from "@/components/network/profile-card";
import { ProfileStatusChip } from "@/components/network/profile-status-chip";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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

  const connectAccess = await getNetworkConnectionAccess(org);
  return (
    <div className="flex flex-col gap-8">
      {backLink}
      <PublicProfileView viewer={viewer} connectAccess={connectAccess} />
    </div>
  );
}

/** The URL segment each entity kind's own detail pages live under. */
const ENTITY_LINK_SEGMENT: Record<NetworkProfileDetail["entityKind"], string> = {
  company: "companies",
  artist: "artists",
  venue: "venues",
  agency: "agencies",
};

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
            href={`/${orgSlug}/${ENTITY_LINK_SEGMENT[own.entityKind]}/${own.entityId}`}
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

const NOT_WIRED_NOTE_ID = "network-connect-not-wired";

function PublicProfileView({
  viewer,
  connectAccess,
}: {
  viewer: NetworkProfileForViewer;
  connectAccess: CrmWriteAccess;
}) {
  const { row, source } = viewer;

  // THE SHELL'S EXPLANATION. Task 4 wires the control's ACTION; this task
  // ships the DISABLED SHELL, unconditionally, for every tier -- there is no
  // sanctioned way to send a request from this screen yet regardless of plan.
  // The SENTENCE still tells the truth about WHY, and for a Free-tier caller
  // that truth is `getNetworkConnectionAccess`'s own tier explanation, which
  // names the plan and says an Owner can change it -- the exact acceptance
  // criterion this task owes. A caller who WOULD be permitted to write (a
  // paid tier, holding manage_network_connections) gets the honest "not built
  // here yet" sentence instead of a claim that they are blocked by their plan
  // or role, which would be false.
  const connectExplanation = connectAccess.canWrite
    ? "Sending a connection request from here isn’t available in this release yet — check back soon."
    : connectAccess.explanation;

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

      {/* THE REQUEST CONTROL. RENDERED AND DISABLED, NEVER HIDDEN
          (Constraint 12; CLAUDE.md's Free-tier honesty rule). Task 4 gives it
          a real `action`; until then this is a stable, named target -- a
          `<form>` wrapping one `<button>` with an accessible name of "Request
          connection" -- for a future e2e walk to find and strip the
          `disabled` attribute from (the `tests/e2e/finance.spec.ts:265-287`
          strip-and-submit pattern), which is the only kind of test that proves "hiding a
          button is not enforcement" rather than merely restating it. */}
      <form className="flex flex-col gap-2 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Connect</h2>
        <p id={NOT_WIRED_NOTE_ID} className="max-w-prose text-sm text-ink-muted">
          {connectExplanation}
        </p>
        <div>
          <Button type="submit" disabled aria-describedby={NOT_WIRED_NOTE_ID}>
            Request connection
          </Button>
        </div>
      </form>
    </div>
  );
}

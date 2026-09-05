import Link from "next/link";
import { ProfileStatusChip } from "@/components/network/profile-status-chip";
import { RepublishNotice } from "@/components/network/republish-notice";
import type { EntityNetworkProfile } from "@/lib/network/entities";

// The "Network identity" row the four private record detail pages each add
// (companies/[companyId], artists/[artistId], venues/[venueId],
// agencies/[agencyId]) -- one component rather than four copies of the same
// three states, the same discipline every other cross-entity panel in this
// codebase follows (ActivityTimeline, RelatedPanel, CustomFieldsPanel).
//
// THREE STATES, and the caller (each detail page) has already decided which
// one applies -- this component renders, it does not query:
//   1. NO PROFILE.        `profile` is null. A note and a link to where one is
//      created (the profiles list's "Publish a record" picker).
//   2. A PROFILE EXISTS.  Its status chip (draft/published) and a link into
//      its editor.
//   3. PUBLISHED AND DRIFTED. Everything from (2) plus RepublishNotice --
//      `drifted` is computed by the CALLING PAGE from lib/network/drift.ts's
//      `profileHasDrifted`, over the two objects that page already loaded.
//      This component never sees the private record at all, so there is no
//      path here from a network concern back into one.

export function NetworkIdentityRow({
  orgSlug,
  profile,
  drifted,
}: {
  orgSlug: string;
  profile: EntityNetworkProfile | null;
  /** Only meaningful when `profile !== null && profile.status === "published"`. */
  drifted: boolean;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-rule pt-6">
      <h2 className="text-xl font-bold text-ink">Network identity</h2>
      {profile === null ? (
        <div className="flex flex-col gap-2">
          <p className="max-w-prose text-base text-ink-muted">
            Not published to the network yet. Nobody outside this workspace
            can find this record until you create and publish a profile for
            it.
          </p>
          <p>
            <Link
              href={`/${orgSlug}/network/profiles`}
              className="text-primary underline underline-offset-4 hover:text-ink"
            >
              Publish this record
            </Link>
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <ProfileStatusChip status={profile.status} />
            <Link
              href={`/${orgSlug}/network/profiles/${profile.id}`}
              className="text-primary underline underline-offset-4 hover:text-ink"
            >
              Manage its network profile
            </Link>
          </div>
          {profile.status === "published" && drifted ? (
            <RepublishNotice orgSlug={orgSlug} profileId={profile.id} />
          ) : null}
        </div>
      )}
    </section>
  );
}

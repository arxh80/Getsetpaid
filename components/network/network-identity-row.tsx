import Link from "next/link";
import { ProfileStatusChip } from "@/components/network/profile-status-chip";
import { RepublishNotice } from "@/components/network/republish-notice";
import type { EntityNetworkProfile } from "@/lib/network/entities";

// The "Network identity" row the four private record detail pages each add
// (companies/[companyId], artists/[artistId], venues/[venueId],
// agencies/[agencyId]) -- one component rather than four copies of the same
// states, the same discipline every other cross-entity panel in this
// codebase follows (ActivityTimeline, RelatedPanel, CustomFieldsPanel).
//
// FOUR STATES, and the caller (each detail page) has already decided which
// one applies -- this component renders, it does not query:
//   0. UNREADABLE.         `canRead` is false. Fix round 1, I2: `view_crm`
//      survives workspace suspension and `view_network` does not
//      (lib/network/access.ts), so a suspended workspace could still open
//      this page while `loadNetworkProfileForEntity` (gated on the SAME
//      policy) quietly returned null for a record that is genuinely
//      published. Rendering state 1 in that case would tell the workspace
//      its own PUBLISHED record is "Not published to the network yet." --
//      the dishonest state this plan forbids by name, arrived at from the
//      opposite direction the brief called out. THIS STATE MUST BE CHECKED
//      FIRST, before `profile` is even looked at, and the caller must never
//      pass a real lookup result alongside `canRead: false` -- see
//      `tests/unit/network/source-shape.test.ts`'s "I2" describe block for
//      the census that pins the check order in every one of the four pages.
//   1. NO PROFILE.        `profile` is null (and `canRead` is true). A note
//      and a link to where one is created (the profiles list's "Publish a
//      record" picker).
//   2. A PROFILE EXISTS.  Its status chip (draft/published) and a link into
//      its editor.
//   3. PUBLISHED AND DRIFTED. Everything from (2) plus RepublishNotice --
//      `drifted` is computed by the CALLING PAGE from lib/network/drift.ts's
//      `profileHasDrifted`, over the two objects that page already loaded.
//      This component never sees the private record at all, so there is no
//      path here from a network concern back into one.

export function NetworkIdentityRow({
  orgSlug,
  canRead,
  profile,
  drifted,
}: {
  orgSlug: string;
  /** From `getNetworkReadAccess(org)`, resolved by the calling page BEFORE it
   *  decides whether to look up a profile at all. False for a suspended
   *  workspace (view_network does not survive suspension; view_crm does), so
   *  this is a real and reachable state, not a defensive-only branch. */
  canRead: boolean;
  /** Must be null whenever `canRead` is false -- the caller should not even
   *  run the lookup in that case (see the four detail pages). */
  profile: EntityNetworkProfile | null;
  /** Only meaningful when `profile !== null && profile.status === "published"`. */
  drifted: boolean;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-rule pt-6">
      <h2 className="text-xl font-bold text-ink">Network identity</h2>
      {!canRead ? (
        <p className="max-w-prose text-base text-ink-muted">
          This workspace can’t reach the network area right now, so whether
          this record is published can’t be shown here. If the workspace is
          suspended, that’s why — contact GetSetPaid support to have it
          reinstated.
        </p>
      ) : profile === null ? (
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

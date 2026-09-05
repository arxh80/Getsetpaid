import Link from "next/link";

// Q75's drift affordance, rendered on the four private record detail pages
// when this organisation's own PUBLISHED profile for this record has fallen
// out of step with the record itself.
//
// A SERVER COMPONENT, deliberately: the comparison it renders the RESULT of
// (lib/network/drift.ts's `profileHasDrifted`) runs in the calling detail
// page, over two objects that page already loaded separately -- the private
// record and this organisation's own network_profiles row for it. This
// component takes only the boolean and a link; it introduces no query of its
// own and therefore no database path from network_profiles to a private
// table, which is the one thing the brief says this affordance must not do.
//
// RENDERED ONLY FOR A PUBLISHED PROFILE. A draft is not live anywhere outside
// this workspace, so "the published copy differs" is not a sentence that
// applies to it -- the calling page checks `profile.status === "published"`
// before rendering this at all, which is why that check is not repeated here.

export function RepublishNotice({
  orgSlug,
  profileId,
}: {
  orgSlug: string;
  profileId: string;
}) {
  return (
    <div
      role="status"
      className="border border-rule-strong bg-surface px-4 py-3 text-base text-ink"
    >
      <p>
        <span className="font-semibold text-warning">Out of date.</span> The
        published copy of this record differs from what is here now.
      </p>
      <p className="mt-2">
        <Link
          href={`/${orgSlug}/network/profiles/${profileId}`}
          className="text-primary underline underline-offset-4 hover:text-ink"
        >
          Review the network profile
        </Link>
      </p>
    </div>
  );
}

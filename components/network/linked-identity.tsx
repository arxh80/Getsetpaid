"use client";

import { useActionState } from "react";
import Link from "next/link";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { removeNetworkLinkAction } from "@/lib/network/links";
import {
  NETWORK_ENTITY_KIND_LABELS,
  type NetworkEntityKind,
} from "@/lib/network/fields";
import type { NetworkProfileForViewer } from "@/lib/network/discovery";
import { ProfileCard } from "@/components/network/profile-card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Task 4 / Gap B (Q73/Q82): the private record's own linked-identity row --
// the counterpart to components/network/network-identity-row.tsx, which shows
// THIS organisation's OWN published profile. This shows a profile SOMEBODY
// ELSE published, that this organisation has explicitly linked to one of its
// private records.
//
// ===========================================================================
// EVERY PUBLISHED FIELD RENDERED HERE CAME THROUGH A MASKING VIEW
// ===========================================================================
// `profile` is a `NetworkProfileForViewer` -- `lib/network/discovery.ts`'s
// `loadNetworkProfileForViewer`, resolved through `network_connected_profiles`
// or `network_directory` and never through `public.network_profiles`
// (Constraint 19's network case, restated once more because this is the
// fourth surface in the product that has to get it right independently: the
// directory page, the profile detail page, the requests list, and now this
// one). `ProfileCard` -- the SAME component the directory and the profile
// page use -- renders it, so this surface cannot drift from what "a published
// field" means anywhere else.
//
// ===========================================================================
// `profile === null` IS A REAL, REACHABLE STATE, NOT A DEFENSIVE BRANCH
// ===========================================================================
// A standing `network_links` row is never re-validated against the profile it
// names (20260904000000's header: linking checks the profile is published and
// live only at INSERT time). The profile's owner can unpublish or soft-delete
// it at any moment afterwards, and neither view will carry it any more. This
// state says so honestly rather than rendering a blank card.
//
// ===========================================================================
// UNLINKING HAS NO CONFIRMATION, AND THAT IS lib/network/links.ts'S OWN RULE
// ===========================================================================
// `removeNetworkLinkAction`'s doc comment: "safe to offer as a plain button
// rather than behind a confirmation: it costs nothing and is fully
// reversible by doing it again" -- the partial unique index does not block
// re-linking the same pair. This component follows that rule rather than
// adding a confirmation step Task 1 already reasoned should not exist.
export function LinkedIdentity({
  orgSlug,
  linkId,
  entityType,
  entityId,
  profile,
}: {
  orgSlug: string;
  linkId: string;
  /** This organisation's own record the link is filed against -- passed
   *  through as hidden fields so `removeNetworkLinkAction` can revalidate
   *  this exact page on success. Never used for authorisation; see that
   *  action's own comment. */
  entityType: NetworkEntityKind;
  entityId: string;
  profile: NetworkProfileForViewer | null;
}) {
  const [state, formAction, pending] = useActionState(
    removeNetworkLinkAction,
    EMPTY_FORM_STATE,
  );

  return (
    <div className="flex flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      {profile === null ? (
        <p className="max-w-prose text-base text-ink-muted">
          Linked to a network profile that is no longer published. The link
          itself is unaffected — unlink it and search again if this was a
          mistake, or leave it in case the profile is republished.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-base text-ink">
            Linked to{" "}
            <Link
              href={`/${orgSlug}/network/${profile.row.id}`}
              className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
            >
              {profile.row.displayName}
            </Link>{" "}
            ({NETWORK_ENTITY_KIND_LABELS[profile.row.entityKind]}).
          </p>
          {profile.source === "connected" ? (
            <p className="text-sm text-ink-muted">
              You’re connected, so fields it marked “Connections only” are
              included below, alongside what it published to everyone.
            </p>
          ) : null}
          <ProfileCard row={profile.row} compact />
        </div>
      )}

      <div>
        <form action={formAction}>
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="linkId" value={linkId} />
          <input type="hidden" name="privateEntityType" value={entityType} />
          <input type="hidden" name="privateEntityId" value={entityId} />
          <Button type="submit" variant="quiet" pending={pending} pendingLabel="Unlinking…">
            Unlink
          </Button>
        </form>
      </div>
    </div>
  );
}

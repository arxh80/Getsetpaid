import { LinkedIdentity } from "@/components/network/linked-identity";
import { LinkPicker } from "@/components/network/link-picker";
import type { NetworkEntityKind } from "@/lib/network/fields";
import type { NetworkLinkRow } from "@/lib/network/links-list";
import type { NetworkProfileForViewer } from "@/lib/network/discovery";

// Task 4 / Gap B (Q73/Q82): the "Linked network identity" section the four
// private record detail pages each add (companies/[companyId],
// artists/[artistId], venues/[venueId], agencies/[agencyId]) -- ONE
// component rather than four copies of the same states, the same discipline
// components/network/network-identity-row.tsx follows for the record's OWN
// published profile (a DIFFERENT fact: that one is "has THIS organisation
// published this record"; this one is "has THIS organisation linked this
// record to SOMEBODY ELSE'S published identity"). The two sit side by side on
// every one of the four pages and are never conflated.
//
// THREE STATES, the caller (each detail page) has already decided which
// applies -- this component renders, it does not query:
//   0. UNREADABLE. `canRead` is false (view_network closes for a suspended
//      workspace, same I2 argument NetworkIdentityRow's header makes). Must
//      be checked first, before `link` is even looked at, for the identical
//      reason: a suspended workspace must not be told "not linked" about a
//      record that IS genuinely linked.
//   1. LINKED. `link` is not null. `LinkedIdentity` renders the resolved
//      profile (through the masking views only) plus the unlink control.
//   2. NOT LINKED. `link` is null. `LinkPicker`, Q73's explicit,
//      never-suggested search -- `pickerDisabledReason` is
//      `getNetworkConnectionAccess`'s own explanation when the caller may not
//      write (suspended/tier/permission), the same string a stripped-
//      `disabled`-attribute submission would meet from the server.
export function LinkedIdentitySection({
  orgSlug,
  canRead,
  entityType,
  entityId,
  link,
  linkedProfile,
  pickerDisabledReason,
}: {
  orgSlug: string;
  canRead: boolean;
  entityType: NetworkEntityKind;
  entityId: string;
  /** Null whenever `canRead` is false -- the caller should not run the
   *  lookup in that case (same rule as the four pages' `networkProfile`). */
  link: NetworkLinkRow | null;
  /** Only meaningful when `link` is not null; null when the linked profile is
   *  no longer reachable through either masking view. */
  linkedProfile: NetworkProfileForViewer | null;
  pickerDisabledReason: string | null;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-rule pt-6">
      {/* NOT "Linked network identity" -- FOUND IN A BROWSER WALK
          (Constraint 17): Playwright's `getByRole("heading", { name })`
          substring-matches case-insensitively by default, and that string
          contains "Network identity" verbatim, colliding with
          network-identity-row.tsx's OWN heading of that exact text on the
          same four pages. tests/e2e/network.spec.ts's existing
          `getByRole("heading", { name: "Network identity" })` started
          resolving to two elements the moment this section shipped beside
          it. "Linked profile" shares no substring with "Network identity". */}
      <h2 className="text-xl font-bold text-ink">Linked profile</h2>
      {!canRead ? (
        <p className="max-w-prose text-base text-ink-muted">
          This workspace can’t reach the network area right now, so whether
          this record is linked to a network identity can’t be shown here. If
          the workspace is suspended, that’s why — contact GetSetPaid support
          to have it reinstated.
        </p>
      ) : link !== null ? (
        <LinkedIdentity
          orgSlug={orgSlug}
          linkId={link.id}
          entityType={entityType}
          entityId={entityId}
          profile={linkedProfile}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="max-w-prose text-base text-ink-muted">
            Not linked to a network identity yet. If this is the same company,
            artist, venue or agency as one already published on the network,
            you can link them explicitly — nothing is suggested, and search
            shows nothing until you type.
          </p>
          <LinkPicker
            orgSlug={orgSlug}
            entityType={entityType}
            entityId={entityId}
            disabledReason={pickerDisabledReason}
          />
        </div>
      )}
    </section>
  );
}

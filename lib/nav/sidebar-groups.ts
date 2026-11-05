import "server-only";

import {
  ADMIN_ITEMS,
  CRM_AREAS,
  FINANCE_ITEMS,
  NETWORK_ITEMS,
  OPERATIONS_AREAS,
  OVERVIEW_ITEM,
} from "@/lib/nav/areas";
import { hasPermission } from "@/lib/auth";
import type { SidebarNavGroup } from "@/components/nav/types";

// The rail's contents for one workspace — moved verbatim out of
// app/(app)/layout.tsx (keyboard-a11y pass) so the command palette, which
// mounts in app/(app)/[orgSlug]/layout.tsx BELOW the MFA gate (see
// lib/palette/results.ts's PALETTE_OPEN_EVENT for why it cannot live in the
// shell), can build the same permission-filtered section list without the
// two layouts drifting. `hasPermission` is cache()-wrapped per request, so
// both layouts calling this costs one set of permission RPCs, not two.
//
// CRM and Operations render for every role that can reach an org route (they
// all hold `view_crm`; each list's own empty state explains record scope --
// see lib/nav/areas.ts). Network is gated as a GROUP on `view_network`; the
// two admin items are gated INDIVIDUALLY -- `manage_members` and
// `manage_custom_fields` are different permissions, so a Manager who can
// invite people but not define custom fields sees "Members" alone, not a
// half-disabled group. A group only appears once it has at least one item.
//
// THE FINANCE GROUP (Invoices part 1) is gated on view_finance: the invoices list
// and its settings now give it routes to point at; the event finance panel stays
// on the event page.
export async function buildSidebarGroups(
  orgId: string,
  orgSlug: string,
): Promise<SidebarNavGroup[]> {
  const [
    canViewFinance,
    canViewNetwork,
    canManageMembers,
    canManageCustomFields,
    canManageOrganisationKey,
    canEndSupportAccess,
  ] = await Promise.all([
    hasPermission(orgId, "view_finance"),
    hasPermission(orgId, "view_network"),
    hasPermission(orgId, "manage_members"),
    hasPermission(orgId, "manage_custom_fields"),
    // Phase 7 Task 2: gates the "Support access" item. Owner/Admin only, and
    // -- because manage_organisation is not in the impersonation envelope --
    // absent for an impersonating superuser.
    hasPermission(orgId, "manage_organisation"),
    // ...AND THE SUSPENDED CASE, pre-merge review finding I1. The line above
    // has survives_suspension = false, so a SUSPENDED workspace's own Owner
    // lost the rail item -- including while a support session granted before
    // the suspension was still running and still readable, since `view_crm`
    // survives. The one screen carrying the "End access now" control was then
    // reachable only by typing the URL. `end_support_access` is held by the
    // same roles and DOES survive suspension, so the item stays put for
    // exactly the person who may still end a session. It is not in the
    // impersonation envelope either (rls_phase7_impersonation.sql § IS9a), so
    // support access still cannot use it to extend itself.
    hasPermission(orgId, "end_support_access"),
  ]);
  const canManageOrganisation = canManageOrganisationKey || canEndSupportAccess;

  return [
    // The hub first (review finding 12): the rail's own way back to the
    // workspace overview, and the item that lights up while you are on it --
    // every other href is longer, so the longest-prefix active match only
    // ever picks this one on /[orgSlug] itself.
    {
      id: "workspace",
      heading: "Workspace",
      items: [toNavItem(orgSlug, OVERVIEW_ITEM)],
    },
    {
      id: "crm",
      heading: "CRM",
      items: CRM_AREAS.map((area) => toNavItem(orgSlug, area)),
    },
    {
      id: "operations",
      heading: "Operations",
      items: OPERATIONS_AREAS.map((area) => toNavItem(orgSlug, area)),
    },
    ...(canViewFinance
      ? [{ id: "finance", heading: "Finance", items: FINANCE_ITEMS.map((area) => toNavItem(orgSlug, area)) }]
      : []),
    ...(canViewNetwork
      ? [
          {
            id: "network",
            heading: "Network",
            items: NETWORK_ITEMS.map((area) => toNavItem(orgSlug, area)),
          },
        ]
      : []),
    ...(canManageMembers || canManageCustomFields || canManageOrganisation
      ? [
          {
            id: "admin",
            heading: "Admin",
            items: [
              ...(canManageMembers ? [toNavItem(orgSlug, ADMIN_ITEMS[0])] : []),
              ...(canManageCustomFields
                ? [toNavItem(orgSlug, ADMIN_ITEMS[1])]
                : []),
              ...(canManageOrganisation
                ? [toNavItem(orgSlug, ADMIN_ITEMS[2])]
                : []),
            ],
          },
        ]
      : []),
  ];
}

function toNavItem(
  orgSlug: string,
  area: { path: string; label: string; sub: string },
) {
  return {
    path: area.path,
    label: area.label,
    sub: area.sub,
    // OVERVIEW_ITEM's path is "" -- the hub itself -- and the template below
    // would give it a trailing slash Next treats as a different URL.
    href: area.path === "" ? `/${orgSlug}` : `/${orgSlug}/${area.path}`,
  };
}

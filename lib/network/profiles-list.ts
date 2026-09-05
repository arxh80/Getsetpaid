import { defineListSpec } from "@/lib/list/spec";
import {
  parseFieldVisibility,
  type FieldVisibility,
  type NetworkEntityKind,
  type ProfileStatus,
} from "@/lib/network/fields";

// "This organisation's own profiles" -- app/(app)/[orgSlug]/network/profiles/
// page.tsx. NOT the discovery list (lib/network/discovery-list.ts, Task 3):
// that one reads public.network_directory, spans every tenant and is not
// organisation-scoped; this one reads public.network_profiles directly,
// filtered to the caller's own organisation_id by fetchListPage's ordinary
// tenant clause, and shows drafts as well as published rows -- exactly the
// SELECT (own) policy's shape (20260904003000, "your own network profiles,
// drafts and published alike").
//
// Reading the BASE TABLE here, not a view, is correct and is not Constraint
// 19's network case: that constraint is about a CROSS-TENANT read bypassing
// the masking views (network_directory / network_connected_profiles). This
// list is org-scoped like every other entity list in the product -- the
// caller reading their OWN row, which the base table's own-profiles SELECT
// policy already permits column-for-column. There is nothing to mask from
// yourself.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * `field_visibility` is included so the list can show each row's own
 * publish-summary counts (lib/network/fields.ts's `publishSummary`) without a
 * second round trip per row -- it is this organisation's OWN jsonb column,
 * not a cross-tenant read, so there is no masking concern the way there would
 * be on the directory.
 */
export const NETWORK_OWN_PROFILE_SELECT =
  "id, entity_kind, entity_id, display_name, status, field_visibility, updated_at";

export interface NetworkOwnProfileRow {
  id: string;
  entityKind: NetworkEntityKind;
  entityId: string;
  displayName: string;
  status: ProfileStatus;
  fieldVisibility: FieldVisibility;
  updatedAt: string;
}

export function mapNetworkOwnProfileRow(
  row: Record<string, unknown>,
): NetworkOwnProfileRow {
  return {
    id: String(row.id),
    entityKind: row.entity_kind as NetworkEntityKind,
    entityId: String(row.entity_id),
    displayName: String(row.display_name),
    status: row.status as ProfileStatus,
    fieldVisibility: parseFieldVisibility(row.field_visibility),
    updatedAt: String(row.updated_at),
  };
}

export const NETWORK_OWN_PROFILE_LIST = defineListSpec({
  entity: "network-profiles",
  noun: { one: "profile", many: "profiles" },

  searchColumn: "display_name",
  searchLabel: "Search your profiles by name",

  sort: {
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      // NOT NULL and trigger-maintained (private.set_updated_at(),
      // 20260904000000), so a client cannot PATCH itself to the top.
      notNull: true,
      backedBy: "network_profiles_org_updated_at_id_live_idx",
    },
  },
  defaultSort: "updated",

  filters: {
    status: {
      label: "Status",
      choices: [
        { value: "any", label: "Any status" },
        { value: "draft", label: "Draft" },
        { value: "published", label: "Published" },
      ],
    },
  },

  // NAMESPACED FROM THE START (Constraint 10), the same discipline
  // NETWORK_DIRECTORY_LIST's header states: this page owns exactly one list
  // today, but a query-string key without a prefix silently collides with any
  // second list a later task adds to this route (Task 4's connection-request
  // queue is the obvious candidate).
  paramPrefix: "prof_",
});

export type NetworkOwnProfileSortKey =
  keyof (typeof NETWORK_OWN_PROFILE_LIST)["sort"];
export type NetworkOwnProfileFilterKey =
  keyof (typeof NETWORK_OWN_PROFILE_LIST)["filters"];

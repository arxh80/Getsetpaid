import "server-only";

// The read half of /super/closures (Phase 8 Task 9c job 3a; founder
// 2026-09-30, Q176/Q178): workspaces their Owner closed, awaiting the
// superuser's decision -- reassign to a new Owner, or delete permanently.
//
// A SEPARATE MODULE FROM lib/admin/closures.ts because that file is
// "use server": every export there is a callable Server Action endpoint, so a
// read helper living beside them would be published for no reason (the same
// split as lib/admin/lifecycle-list.ts beside lib/admin/lifecycle.ts).
//
// NOTHING HERE IS THE ENFORCEMENT. Both RPCs are SECURITY DEFINER and re-check
// the platform superuser at aal2 themselves; the second refuses any workspace
// that is not owner_closed. The page still calls isSuperuser() and notFound()s.
//
// AGGREGATE METADATA ONLY (CLAUDE.md § Superuser dashboard): name, slug, the
// two clocks, an active member count and the closure backup's STATUS (Q209 --
// there is no superuser download). The candidates read adds display names and
// roles of the closed workspace's active members, because the reassign
// decision cannot be made without naming one (Q215).

import { createClient } from "@/lib/supabase/server";
import { EXPORT_STATUSES, type ExportStatus } from "@/lib/export/contract";
import {
  buildListHref,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { defineListSpec, type ListSpec } from "@/lib/list/spec";

export interface ClosedWorkspaceRow {
  readonly organisationId: string;
  readonly slug: string;
  readonly name: string;
  readonly closedAt: string | null;
  readonly purgeDueAt: string | null;
  readonly activeMembers: number;
  readonly backupStatus: ExportStatus | null;
}

export interface ReassignCandidate {
  readonly userId: string;
  readonly displayName: string | null;
  readonly role: string;
}

export type ClosuresSort = "closed_at";

/**
 * The ListSpec that lets lib/list own the cursor and the page-size ceiling
 * (tests/unit/list/one-cursor-only.test.ts: no hand-rolled keyset). One sort,
 * no filters, no search box. The order itself is the RPC's own
 * `(lifecycle_changed_at, id)` over the owner_closed set, inside a SECURITY
 * DEFINER function rather than a PostgREST sort -- there is no index behind it
 * because that set is small by nature; Q216 asks whether it should have one.
 */
export const CLOSURES_SPEC: ListSpec<ClosuresSort, never> = defineListSpec({
  entity: "closed_workspace",
  noun: { one: "workspace", many: "workspaces" },
  searchColumn: "slug",
  searchLabel: "Search workspace",
  sort: {
    closed_at: {
      column: "lifecycle_changed_at",
      label: "Closed",
      defaultDirection: "asc",
      directionLabels: { asc: "Nearest purge first", desc: "Most recent first" },
      notNull: true,
      backedBy: "closed_workspaces_awaiting_decision (RPC order; no index, Q216)",
    },
  },
  defaultSort: "closed_at",
  filters: {},
});

export type ClosuresParams = ListParams<ClosuresSort, never>;

export function parseClosuresParams(raw: RawSearchParams): ClosuresParams {
  return parseListParams(CLOSURES_SPEC, raw);
}

export function buildClosuresNextHref(params: ClosuresParams, row: ClosedWorkspaceRow): string | null {
  if (!row.closedAt) return null;
  return buildListHref(CLOSURES_SPEC, "/super/closures", params, {
    cursor: {
      direction: "after",
      cursor: { value: new Date(row.closedAt).toISOString(), id: row.organisationId, sort: "closed_at" },
    },
  });
}

export type ClosuresListResult =
  | { readonly ok: true; readonly rows: readonly ClosedWorkspaceRow[]; readonly hasMore: boolean }
  | { readonly ok: false };

function asStatus(value: unknown): ExportStatus | null {
  return typeof value === "string" && (EXPORT_STATUSES as readonly string[]).includes(value)
    ? (value as ExportStatus)
    : null;
}

/**
 * One page of owner_closed workspaces, oldest closure first (the nearest
 * purge first). A read failure is a DISTINGUISHABLE result, not an empty list:
 * "nothing awaits a decision" is the one wrong answer that would let a
 * workspace drift to its 60-day purge unseen.
 */
export async function listClosedWorkspaces(
  params: ClosuresParams,
): Promise<ClosuresListResult> {
  const { pageSize } = params;
  // decodeCursor checked the cursor's SHAPE; its value is still a string from
  // the query string, so it must parse as an instant before it reaches the
  // RPC's timestamptz parameter. Anything else is page one.
  const cursor =
    params.cursor && !Number.isNaN(Date.parse(params.cursor.value)) ? params.cursor : null;
  const supabase = await createClient();
  // One extra row tells us whether a next page exists without a count query.
  const { data, error } = await supabase.rpc("closed_workspaces_awaiting_decision", {
    p_after_closed_at: cursor?.value ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: pageSize + 1,
  });
  if (error) {
    console.error("[admin] closed workspace list failed:", error.message);
    return { ok: false };
  }
  const all = ((data ?? []) as Record<string, unknown>[]).map(
    (row): ClosedWorkspaceRow => ({
      organisationId: row.organisation_id as string,
      slug: row.slug as string,
      name: row.name as string,
      closedAt: (row.closed_at as string | null) ?? null,
      purgeDueAt: (row.purge_due_at as string | null) ?? null,
      activeMembers: Number(row.active_members ?? 0),
      backupStatus: asStatus(row.backup_status),
    }),
  );
  return {
    ok: true,
    rows: all.slice(0, pageSize),
    hasMore: all.length > pageSize,
  };
}

/** The active members a closed workspace could be reassigned to. */
export async function listReassignCandidates(
  organisationId: string,
): Promise<readonly ReassignCandidate[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("closed_workspace_reassign_candidates", {
    p_organisation_id: organisationId,
  });
  if (error) {
    console.error("[admin] reassign candidate list failed:", error.message);
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    userId: row.user_id as string,
    displayName: (row.display_name as string | null) ?? null,
    role: row.role as string,
  }));
}

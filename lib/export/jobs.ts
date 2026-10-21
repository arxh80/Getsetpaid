import "server-only";

// The signed-in person's OWN export jobs, read under their own session.
//
// `export_jobs_select_own` admits only rows whose requested_by is the caller,
// for BOTH kinds, so this needs no user argument and could not read anybody
// else's if it had one. That is also why the WORKSPACE page filters on the
// organisation and not on "this workspace's jobs": there is no such read —
// an Admin cannot see that a colleague exported the workspace, deliberately
// (20260927001000 § 7), and the audit log is the surface for that.

import { createClient } from "@/lib/supabase/server";
import type { ExportKind, ExportManifest, ExportStatus } from "./contract";

export interface OwnExportJob {
  readonly id: string;
  readonly kind: ExportKind | string;
  readonly organisationId: string | null;
  readonly status: ExportStatus | string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
  readonly byteSize: number | null;
  readonly rowCount: number | null;
  readonly tableCount: number | null;
  readonly failureReason: string | null;
  readonly manifest: ExportManifest | null;
}

/**
 * Paginate-everything: bounded. Exports are metered at five an hour, so
 * fifteen is several hours of an unusually busy person — and the page says so
 * when it truncates.
 */
export const OWN_EXPORT_LIMIT = 15;

interface Row {
  id: string;
  kind: string;
  organisation_id: string | null;
  status: string;
  requested_at: string;
  completed_at: string | null;
  expires_at: string | null;
  byte_size: number | null;
  row_count: number | null;
  table_count: number | null;
  failure_reason: string | null;
  manifest: unknown;
}

export interface OwnExportState {
  readonly jobs: readonly OwnExportJob[];
  readonly truncated: boolean;
}

const COLUMNS =
  "id, kind, organisation_id, status, requested_at, completed_at, expires_at, byte_size, row_count, table_count, failure_reason, manifest";

/**
 * FAILS LOUDLY on a query error. A page that rendered "you have no exports"
 * during a database blip would tell someone their statutory copy had
 * vanished.
 */
export async function getOwnExportJobs(
  kind: ExportKind,
  organisationId?: string,
): Promise<OwnExportState> {
  const supabase = await createClient();
  let query = supabase
    .from("export_jobs")
    .select(COLUMNS)
    .eq("kind", kind)
    .order("requested_at", { ascending: false })
    .limit(OWN_EXPORT_LIMIT + 1);
  if (organisationId !== undefined) query = query.eq("organisation_id", organisationId);

  const { data, error } = await query;
  if (error) {
    throw new Error(`export jobs could not be read: ${error.message}`);
  }
  const rows = (data ?? []) as Row[];
  const truncated = rows.length > OWN_EXPORT_LIMIT;
  return {
    truncated,
    jobs: rows.slice(0, OWN_EXPORT_LIMIT).map((r) => ({
      id: r.id,
      kind: r.kind,
      organisationId: r.organisation_id,
      status: r.status,
      requestedAt: r.requested_at,
      completedAt: r.completed_at,
      expiresAt: r.expires_at,
      byteSize: r.byte_size,
      rowCount: r.row_count,
      tableCount: r.table_count,
      failureReason: r.failure_reason,
      manifest: (r.manifest ?? null) as ExportManifest | null,
    })),
  };
}

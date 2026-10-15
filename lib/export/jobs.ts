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
  /** Q228: a workspace-closure backup (built in parts), not an ordinary export. */
  readonly closureBackup: boolean;
  /** Stored parts of a multi-part backup; 0 or 1 means one archive at storage_key. */
  readonly partCount: number;
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
  closure_backup: boolean;
  part_count: number;
}

export interface OwnExportState {
  readonly jobs: readonly OwnExportJob[];
  readonly truncated: boolean;
}

const COLUMNS =
  "id, kind, organisation_id, status, requested_at, completed_at, expires_at, byte_size, row_count, table_count, failure_reason, manifest, closure_backup, part_count";

function toJob(r: Row): OwnExportJob {
  return {
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
    closureBackup: r.closure_backup,
    partCount: r.part_count,
  };
}

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
    jobs: rows.slice(0, OWN_EXPORT_LIMIT).map(toJob),
  };
}

/**
 * Q228: the signed-in Owner's newest closure backup of this workspace, read
 * under their own RLS (export_jobs_select_own), so it is only ever theirs.
 * One row: `limit 1`. FAILS LOUDLY like getOwnExportJobs -- "your backup
 * failed" must never render as "no backup" because of a database blip.
 */
export async function getLatestClosureBackup(
  organisationId: string,
): Promise<OwnExportJob | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("export_jobs")
    .select(COLUMNS)
    .eq("organisation_id", organisationId)
    .eq("closure_backup", true)
    .order("requested_at", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(`closure backup could not be read: ${error.message}`);
  }
  const r = ((data ?? []) as Row[])[0];
  if (!r) return null;
  return toJob(r);
}

/** Parts shown per page of a backup's parts list. */
export const PARTS_PAGE_SIZE = 50;

export interface ExportPartsPage {
  readonly parts: { part: number; byteSize: number }[];
  /** The first part of the next page, or null on the last. */
  readonly nextFrom: number | null;
}

/**
 * One page of a multi-part backup's parts, keyset on `part_no`: `part_no >=
 * fromPart order by part_no limit limit + 1`, so the extra row is the next
 * page's first and never an unbounded read. Own RLS
 * (export_job_parts_select_own): another person's job id returns nothing.
 */
export async function getExportJobParts(
  jobId: string,
  fromPart: number,
  limit = PARTS_PAGE_SIZE,
): Promise<ExportPartsPage> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("export_job_parts")
    .select("part_no, byte_size")
    .eq("job_id", jobId)
    .gte("part_no", fromPart)
    .order("part_no", { ascending: true })
    .limit(limit + 1);
  if (error) {
    throw new Error(`backup parts could not be read: ${error.message}`);
  }
  const rows = (data ?? []) as { part_no: number; byte_size: number | string }[];
  const page = rows.slice(0, limit);
  return {
    parts: page.map((r) => ({ part: r.part_no, byteSize: Number(r.byte_size) })),
    nextFrom: rows.length > limit ? rows[limit].part_no : null,
  };
}

// Data exports: the closed vocabularies, the bounds, the key shape and the
// copy, shared by the two pages, the server actions, the runner and the
// tests.
//
// PURE. No "server-only", no Supabase import — the unit suite drives every
// helper here and the client components read the labels. Everything that
// also lives in the database (20260927000000 / 20260927001000) is mirrored
// for the UI, and tests/integration/export/limits-match-db.test.ts asserts
// the two agree against a real Postgres. The database is the enforcement;
// this is the vocabulary.
//
// IT IS ALSO NOT A "use server" MODULE, and that is load-bearing rather than
// tidy: `lib/export/actions.ts` carries "use server", and such a module may
// export nothing but async functions — a single `export const` silently drops
// EVERY export from it for the client and SSR graphs and takes the page down,
// invisibly to lint, tsc and the unit suite (Phase 8 Task 3 fix round 1 shipped
// exactly that). `lib/dsr/contract.ts` is the precedent this file follows.

/** Q132's two controllers, as public.export_jobs.kind. */
export const EXPORT_KINDS = ["account", "workspace"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** public.export_jobs.status. */
export const EXPORT_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** What the requester reads. */
export const EXPORT_STATUS_LABELS: Record<ExportStatus, string> = {
  queued: "Waiting to start",
  running: "Being prepared",
  succeeded: "Ready to download",
  failed: "Could not be prepared",
};

/**
 * `private.export_limits()`, mirrored for the UI copy and the runner's own
 * ceilings. The database is the declaration; these are read back from it at
 * job time by the runner, so a drift here changes what a page SAYS and never
 * what the job DOES — which is the safe direction, and is why the binding
 * test exists rather than a second enforcement point.
 */
export const EXPORT_LIMITS = {
  pageSize: 500,
  maxRowsPerTable: 50_000,
  maxTotalRows: 500_000,
  maxArchiveBytes: 41_943_040,
  archiveDays: 7,
} as const;

/** The archive's schema version, written into every manifest. */
export const EXPORT_MANIFEST_VERSION = 1;

/** The private bucket the archives live in. */
export const EXPORT_BUCKET = "exports";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * The storage key for an archive: `exports/{jobId}.zip`.
 *
 * THE KEY CARRIES NO USER INPUT, the documents pipeline's rule
 * (lib/crm/storage-keys.ts) — and here the database says so too, as the
 * `export_jobs_storage_key_shape` CHECK, so a raw writer cannot invent one
 * either.
 */
export function exportStorageKey(jobId: string): string {
  if (!isUuid(jobId)) {
    throw new Error("exportStorageKey: jobId is not a uuid");
  }
  return `exports/${jobId}.zip`;
}

/**
 * Why something is not in an archive. Every one of these ends up in
 * `manifest.json` under `withheld`, because an export that quietly leaves
 * something out is the failure mode a statutory access response cannot have.
 */
export type WithholdingReason =
  | "table_excused"
  | "document_not_clean"
  | "screenshot_not_clean"
  | "audit_payload_withheld";

export const WITHHOLDING_COPY: Record<WithholdingReason, string> = {
  table_excused:
    "This table is deliberately not part of this export. The reason is recorded beside it.",
  document_not_clean:
    "This file's bytes are not included: it did not pass the malware scan, or the scan has not finished. The document's own record is included, with its scan status.",
  screenshot_not_clean:
    "This screenshot's bytes are not included: it did not pass the malware scan, or the scan has not finished.",
  audit_payload_withheld:
    "Audit rows are included as identifiers, action and timestamps. The before/after payload is not: it holds the changed column names and structural values of other people's records, which are not your data.",
};

export interface ExportWithholding {
  readonly what: string;
  readonly reason: WithholdingReason;
  readonly detail: string;
}

export interface ExportManifest {
  readonly schemaVersion: number;
  readonly kind: ExportKind;
  readonly jobId: string;
  readonly generatedAt: string;
  readonly subject: { readonly userId: string; readonly organisationId: string | null };
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
  readonly withheld: readonly ExportWithholding[];
  readonly notes: readonly string[];
}

/** Where a person starts and tracks their own account export. */
export const ACCOUNT_EXPORTS_PATH = "/account/exports";

/** Where an Owner or Admin starts a workspace export. */
export function workspaceExportPath(orgSlug: string): string {
  return `/${orgSlug}/settings/export`;
}

/**
 * The two sentences each page has to be honest about, in one place so the
 * page and the e2e assertion cannot drift.
 */
export const ACCOUNT_EXPORT_INCLUDES =
  "Your profile, the workspaces you belong to and your role in each, your marketing choices, your data protection requests, the feedback you have sent us, the support-access sessions you accepted or declined, and the record of what you did in the product.";

export const ACCOUNT_EXPORT_EXCLUDES =
  "It does not contain a workspace’s records — its contacts, artists, events, documents or finances. That data belongs to the business that keeps it, not to your account, and an Owner or Admin there can export it from the workspace’s own settings.";

export const WORKSPACE_EXPORT_INCLUDES =
  "Every record this workspace holds, deleted ones included and marked as deleted, as one JSON file per table, plus the files themselves.";

export const WORKSPACE_EXPORT_EXCLUDES =
  "It is built with YOUR access, not with everybody’s: anything you cannot see in the product is not in the archive either — a colleague’s private notes, for example. It also leaves out the platform’s own records about this workspace: the security audit log, operational alerts, and feedback sent to us.";

/** The one sentence about who may open the file. */
export const EXPORT_DOWNLOAD_IS_YOURS =
  "Only you can download it, from this page. The link is signed and lasts a minute; the archive itself is kept for";

export function describeArchiveLife(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** Whether an archive can still be downloaded, read-time. */
export function archiveIsDownloadable(
  status: string,
  expiresAt: string | null,
  now: Date = new Date(),
): boolean {
  if (status !== "succeeded" || expiresAt === null) return false;
  const at = Date.parse(expiresAt);
  return !Number.isNaN(at) && at > now.getTime();
}

export const EXPORT_STARTED_MESSAGE =
  "Your export has started. This page shows its progress — reload it in a moment.";

export const EXPORT_ALREADY_RUNNING =
  "An export is already being prepared. Wait for it to finish before starting another.";

export const EXPORT_RATE_LIMITED_PREFIX = "Too many exports.";

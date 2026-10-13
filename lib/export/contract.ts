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

/**
 * The archive's schema version, written into every manifest.
 *
 * 2 since 20261009000000 (founder 2026-09-30, Q167 CHANGED): an ACCOUNT
 * archive's `tables/impersonation_sessions.json` gained two columns, the
 * operator's break-glass `reason` and `superuser_user_id`. A reader keyed to
 * version 1's column set would otherwise meet them unannounced.
 */
export const EXPORT_MANIFEST_VERSION = 2;

/**
 * What the support-access rows in an ACCOUNT archive mean, stated in the
 * manifest so the data subject can use them (Q167 CHANGED, founder
 * 2026-09-30). The operator is identified by the account id recorded on the
 * session -- the narrowest identifier the row holds -- and this note is what
 * makes that id meaningful without exporting anything the session does not
 * record (no email, no profile). Written only when the plan exports the table.
 */
export const SUPPORT_ACCESS_NOTE =
  "tables/impersonation_sessions.json lists every support-access request you accepted or declined. " +
  "Each one includes the reason GetSetPaid's operator gave for asking (`reason`) and the operator who " +
  "asked (`superuser_user_id`, the GetSetPaid platform operator's account id). Requests that a colleague " +
  "decided are not included: they are not your decision, and your workspace's Owner or Admin can see them.";

/** The private bucket the archives live in. */
export const EXPORT_BUCKET = "exports";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * The storage key for an archive: `exports/{jobId}.zip`, and for part n >= 2
 * of a closure backup (Q228) `exports/{jobId}-part-{n padded to at least four
 * digits}.zip`.
 *
 * THE KEY CARRIES NO USER INPUT, the documents pipeline's rule
 * (lib/crm/storage-keys.ts) — and here the database says so too, as the
 * `export_jobs_storage_key_shape` CHECK and, for parts,
 * `export_job_parts_storage_key_shape`, so a raw writer cannot invent one
 * either. Part 1 is the key every archive has always had, so a single-part
 * backup is where it always was. The pad never TRUNCATES (part 12345 is
 * `-part-12345`), exactly as the CHECK's greatest(4, length) does; the two
 * are bound by tests/integration/export/closure-parts.test.ts.
 */
export function exportStorageKey(jobId: string, part: number = 1): string {
  if (!isUuid(jobId)) {
    throw new Error("exportStorageKey: jobId is not a uuid");
  }
  if (!Number.isSafeInteger(part) || part < 1) {
    throw new Error("exportStorageKey: part is not a positive whole number");
  }
  return part === 1
    ? `exports/${jobId}.zip`
    : `exports/${jobId}-part-${String(part).padStart(4, "0")}.zip`;
}

/**
 * `?part=N` on the download route (Q228): no parameter is part 1; one to nine
 * digits with no leading zero is that part; anything else -- `0`, `01`,
 * `1.0`, `1e3`, a space, ten digits -- is `null`, which the route answers
 * with the same indistinguishable 404 as every other refusal.
 */
export function parsePartParam(raw: string | null): number | null {
  if (raw === null) return 1;
  return /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : null;
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

/**
 * THE TABLES THE CATALOGUE CANNOT HOLD A ROW FOR, AND THAT ARE STILL WITHHELD.
 *
 * RR4 (Task 4 scoped re-review). `manifest.withheld` is built from the PLAN's
 * excused rows, and a table in the completeness census's `NEITHER_DERIVATION`
 * remainder has no catalogue row BY CONSTRUCTION -- a table with no foreign
 * key cannot be catalogued without the both-directions assertions reporting it
 * as `extra`. So it contributed nothing to `withheld`, and
 * `public.rate_limit_counters` -- the one table in that remainder with a real
 * row -> user path -- was left out of an account export with NO STATEMENT OF
 * THAT FACT ANYWHERE THE DATA SUBJECT CAN READ. Every other excluded table
 * says so in the archive. That is a transparency gap in a GDPR artefact, not
 * an untidiness: the `withheld` array exists precisely so that what is absent
 * is absent ON THE RECORD.
 *
 * Reference data in that remainder (the tier catalogue, the rate-limit
 * policies, the permission catalogue) is NOT listed: it holds nothing about
 * anybody, so naming it would pad the honest list with noise.
 *
 * `tests/integration/export/completeness-census.test.ts` binds this list to
 * the census's own roll, so a later table with a subject path and no foreign
 * key cannot join the remainder without joining this too.
 */
export const REMAINDER_WITHHELD: readonly { readonly table: string; readonly detail: string }[] = [
  {
    table: "rate_limit_counters",
    detail:
      "Rate-limit counters are GetSetPaid's own enforcement state -- how many times a budget has been " +
      "spent in the current window -- rather than a record about you. A counter's subject can be a user " +
      "or a whole workspace, chosen per budget, so including them would put one person's throttling " +
      "history into another's copy. They are deliberately and permanently excluded.",
  },
] as const;

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

// ===========================================================================
// Q228: A CLOSURE BACKUP IN PARTS.
// ===========================================================================

/**
 * A closure backup's parts carry manifest version 3: each part's manifest
 * names its `part` and its table `slices`, and the last part's manifest is the
 * INDEX (`parts`, `indexPart`). An ordinary archive stays version 2.
 */
export const CLOSURE_PARTS_MANIFEST_VERSION = 3;

/** Which ceiling closed a part -- or `final`, the part that holds the index. */
export type PartCloseReason = "rows_per_table" | "total_rows" | "bytes" | "entries" | "final";

const PART_CLOSE_REASONS: readonly PartCloseReason[] = [
  "rows_per_table",
  "total_rows",
  "bytes",
  "entries",
  "final",
];

/** One table's rows in one part: `tables/<table>.json`, from `firstKey` to `lastKey` in keyset order. */
export interface PartSlice {
  table: string;
  file: string;
  firstKey: string;
  lastKey: string;
  rows: number;
}

/** One stored part, as the index lists it. */
export interface PartSummary {
  part: number;
  key: string;
  bytes: number;
  rows: number;
  slices: PartSlice[];
  files: number;
  closedBy: PartCloseReason;
}

/** The manifest.json of every part but the last. */
export interface ClosurePartManifest extends Omit<ExportManifest, "schemaVersion"> {
  schemaVersion: 3;
  part: number;
  slices: PartSlice[];
}

/** The INDEX: the last part's manifest.json, and the job row's `manifest`. */
export interface ClosureIndexManifest extends Omit<ExportManifest, "schemaVersion"> {
  schemaVersion: 3;
  parts: PartSummary[];
  indexPart: number;
}

/**
 * Where the next claim of a closure backup resumes, persisted between claims
 * in `export_jobs.resume_cursor`. Opaque to everybody but the runner; never a
 * person's data -- keys, counts, file paths and the withholding statements.
 */
export interface ResumeCursor {
  v: 1;
  phase: "tables" | "files" | "index";
  /** The index into the plan's EXPORTED tables. */
  planIndex: number;
  /** The key last written; `""` at a table's (or the files phase's) start. */
  after: string;
  /** Rows of the current table already written in earlier parts. */
  tableRowsSoFar: number;
  rowCounts: Record<string, number>;
  withheld: ExportWithholding[];
  files: { path: string; bytes: number }[];
  parts: PartSummary[];
  generatedAt: string;
}

const WITHHOLDING_REASONS = Object.keys(WITHHOLDING_COPY) as WithholdingReason[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSlice(value: unknown): value is PartSlice {
  return (
    isRecord(value) &&
    typeof value.table === "string" &&
    typeof value.file === "string" &&
    typeof value.firstKey === "string" &&
    typeof value.lastKey === "string" &&
    isCount(value.rows)
  );
}

function isSummary(value: unknown): value is PartSummary {
  return (
    isRecord(value) &&
    isCount(value.part) &&
    value.part >= 1 &&
    typeof value.key === "string" &&
    isCount(value.bytes) &&
    isCount(value.rows) &&
    Array.isArray(value.slices) &&
    value.slices.every(isSlice) &&
    isCount(value.files) &&
    PART_CLOSE_REASONS.includes(value.closedBy as PartCloseReason)
  );
}

/**
 * The cursor, or `null` for anything that is not exactly one. STRICT: a wrong
 * version, an unknown phase, a negative or fractional count, or a malformed
 * nested entry is `null`, and the runner fails the job on it rather than
 * resuming from a guess.
 */
export function parseResumeCursor(value: unknown): ResumeCursor | null {
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;
  if (value.phase !== "tables" && value.phase !== "files" && value.phase !== "index") return null;
  if (!isCount(value.planIndex) || !isCount(value.tableRowsSoFar)) return null;
  if (typeof value.after !== "string" || typeof value.generatedAt !== "string") return null;
  if (!isRecord(value.rowCounts) || !Object.values(value.rowCounts).every(isCount)) return null;
  if (
    !Array.isArray(value.withheld) ||
    !value.withheld.every(
      (w) =>
        isRecord(w) &&
        typeof w.what === "string" &&
        typeof w.detail === "string" &&
        WITHHOLDING_REASONS.includes(w.reason as WithholdingReason),
    )
  ) {
    return null;
  }
  if (
    !Array.isArray(value.files) ||
    !value.files.every((f) => isRecord(f) && typeof f.path === "string" && isCount(f.bytes))
  ) {
    return null;
  }
  if (!Array.isArray(value.parts) || !value.parts.every(isSummary)) return null;
  return {
    v: 1,
    phase: value.phase,
    planIndex: value.planIndex,
    after: value.after,
    tableRowsSoFar: value.tableRowsSoFar,
    rowCounts: value.rowCounts as Record<string, number>,
    withheld: value.withheld as ExportWithholding[],
    files: value.files as { path: string; bytes: number }[],
    parts: value.parts as PartSummary[],
    generatedAt: value.generatedAt,
  };
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
  "Your profile, the workspaces you belong to and your role in each, your marketing choices, your data protection requests, the feedback you have sent us, the support-access sessions you accepted or declined, the connections to other services you made for yourself (never the keys that let us reach them), and the record of what you did in the product.";

export const ACCOUNT_EXPORT_EXCLUDES =
  "It does not contain a workspace’s records — its contacts, artists, events, documents or finances. That data belongs to the business that keeps it, not to your account, and an Owner or Admin there can export it from the workspace’s own settings.";

export const WORKSPACE_EXPORT_INCLUDES =
  "Every record this workspace holds, deleted ones included and marked as deleted, as one JSON file per table, plus the files themselves.";

/**
 * WHAT THE WORKSPACE EXPORT LEAVES OUT, one entry per EXCUSED catalogue row.
 *
 * ===========================================================================
 * THE PAGE'S LIST AND THE MANIFEST'S ARE NOW ONE LIST (Task 4 review, M8)
 * ===========================================================================
 * The sentence below used to be written out by hand and named three of the
 * five tables `private.export_catalogue()` excuses: the audit log, the alerts
 * and the feedback. `export_jobs` and `data_subject_requests` were in the
 * archive's manifest.json with their full reasons and NOT on the page, so the
 * archive was honest and the page was short — and the missing one a customer
 * would most want named is the second: "a data subject request routed to this
 * workspace is not in this file" is exactly what somebody answering a routed
 * request needs to know.
 *
 * So the page's sentence is BUILT from this roll, and
 * tests/integration/export/excluded-tables-match-db.test.ts asserts the roll
 * is the catalogue's five, by name. A sixth excused table lands as a red test
 * and then as a clause on the page, rather than silently only in the
 * manifest. The plain-English phrases are the page's own voice — the
 * catalogue's reasons are written for an engineer reading a census — which is
 * why the binding is on the NAMES.
 */
export const WORKSPACE_EXCLUDED_TABLES: readonly {
  readonly table: string;
  readonly plainEnglish: string;
}[] = [
  { table: "audit_events", plainEnglish: "the security audit log" },
  { table: "incident_alerts", plainEnglish: "operational alerts" },
  { table: "feedback", plainEnglish: "feedback sent to us" },
  { table: "export_jobs", plainEnglish: "the record of exports like this one" },
  {
    table: "erasure_jobs",
    plainEnglish: "the record of any request to delete this workspace or an account",
  },
  {
    table: "data_subject_requests",
    plainEnglish: "data protection requests routed to this workspace, which belong to the person who made them",
  },
];

function listPhrases(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export const WORKSPACE_EXPORT_EXCLUDES =
  "It is built with YOUR access, not with everybody’s: anything you cannot see in the product is not in the archive either — a colleague’s private notes, for example. It also leaves out the platform’s own records about this workspace: " +
  `${listPhrases(WORKSPACE_EXCLUDED_TABLES.map((t) => t.plainEnglish))}.`;

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

import "server-only";

// ===========================================================================
// Q228: A CLOSURE BACKUP OF ANY SIZE, BUILT IN PARTS -- ONE BOUNDED PART PER
// CLAIM (founder ruling Q228 CHANGED, 2026-10-10;
// docs/superpowers/specs/2026-10-10-closure-backup-parts-design.md).
// ===========================================================================
//
// An ordinary export FAILS at a ceiling (lib/export/runner.ts buildAndStore).
// A closure backup -- the Owner's copy of a workspace they have closed --
// must not: the founder asked that the Owner can download a backup of any
// size. So a closure backup is written as a run of PARTS, each a complete zip
// under the SAME per-archive ceilings an ordinary archive has
// (private.export_limits(), plus the 65 535 entries a zip without ZIP64 can
// hold), and a part is CLOSED BEFORE a ceiling would be passed instead of the
// job failing. The number of parts is not capped; every unit of work is.
//
// ONE PART PER CLAIM. buildNextClosurePart() builds and stores exactly one
// part and hands back where the next claim resumes; the runner then re-queues
// the job (the one backward transition 20261101000000 admits) or, when the
// plan is exhausted, stamps it succeeded with the INDEX as its manifest. The
// workspace is closed and read-only for everybody, so parts built across
// claims describe one state -- and if the superuser reopens it part-way, or
// the closer stops being an Owner, public.export_read_page() refuses the next
// page (20261101002000, Q242) and the job fails with its parts removed.
//
// WHAT THIS FILE IS NOT ALLOWED TO DECIDE is what runner.ts is not: every row
// comes back from public.export_read_page() under the closing Owner's own
// rights, the table list is public.export_plan()'s, and the ceilings are the
// database's (an override can only tighten them, runner.ts effectiveLimits).
// Parts change how rows are WRITTEN, never which rows exist.
//
// THE SHAPES
//   * a table larger than a part may hold is split at keyset boundaries into
//     `tables/<table>.json` SLICES, one per part, each named in its part's
//     manifest by its first and last key and its row count;
//   * a document's bytes are never split -- one file always fits an empty
//     part (tests/unit/export/parts-contract.test.ts pins the upload caps
//     against the part ceiling), and a file that does not is a refusal;
//   * every part's manifest.json is version 3 and says which part it is; the
//     LAST part's manifest is the index, which lists every part.

import { createStorageClient } from "@/lib/supabase/storage";
import { sanitiseFilename } from "@/lib/security/file-allowlist";
import {
  CLOSURE_BACKUP_STOPPED,
  CLOSURE_PARTS_MANIFEST_VERSION,
  EXPORT_BUCKET,
  REMAINDER_WITHHELD,
  SUPPORT_ACCESS_NOTE,
  WITHHOLDING_COPY,
  exportStorageKey,
  parseResumeCursor,
  type ClosureIndexManifest,
  type ClosurePartManifest,
  type DocumentWithheldBecause,
  type ExportKind,
  type ExportWithholding,
  type PartCloseReason,
  type PartSlice,
  type ResumeCursor,
} from "./contract";
import { ZipWriter } from "./zip";
// Types only: the service-role client is the RUNNER's (it is one of the
// sessionless runners tests/unit/email/service-client-census.test.ts names);
// this file is handed it and never constructs one.
import type { Limits, ServiceClient } from "./runner";

/**
 * What a part's manifest.json may cost beyond the entries recorded in it: its
 * local header and directory record, the subject, the notes, the per-part
 * row counts and every statement that is the same in every part. Each slice,
 * file and withheld entry added to the part is reserved on top as it is
 * added, and the real manifest is checked against the room at close -- a
 * manifest that does not fit is a bug in this accounting, and throws.
 */
export const PART_MANIFEST_BASE_RESERVE = 65_536;

/** Objects removed per Storage call when a failed backup's parts are cleaned up. */
const REMOVE_CHUNK = 100;

/** The runner's limits after the override: the database's, or tighter. */
export type PartLimits = Limits & { max_entries: number };

export interface ClaimedClosureJob {
  id: string;
  kind: ExportKind;
  organisation_id: string | null;
  requested_by: string;
  requested_at: string;
  /** Parts already stored (export_jobs.part_count). */
  part_count: number;
  /** export_jobs.resume_cursor, as stored -- parsed strictly here. */
  resume_cursor: unknown;
}

/** The final part's manifest: the index, plus the part's own slices. */
export type ClosureFinalManifest = ClosureIndexManifest & { part: number; slices: PartSlice[] };

export type ClosurePartResult =
  | { final: false; part: number; cursor: ResumeCursor }
  | {
      final: true;
      part: number;
      index: ClosureFinalManifest;
      byteSize: number;
      rowCount: number;
      tableCount: number;
    };

interface PlanRow {
  table_name: string;
  disposition: "exported" | "excused";
  reason: string | null;
  authorisation: string | null;
  key_column: string | null;
}

/** What has gone into the part being built. */
interface PartState {
  rows: number;
  slices: PartSlice[];
  files: { path: string; bytes: number }[];
  withheld: ExportWithholding[];
  rowCounts: Record<string, number>;
  /** Bytes still owed to manifest.json: the base, plus each entry recorded. */
  reserve: number;
}

const TABLE_HEAD = "[\n";
const TABLE_TAIL = "\n]\n";
const TAIL_BYTES = Buffer.byteLength(TABLE_TAIL, "utf8");

/**
 * Build and store the next part of a closure backup.
 *
 * Returns `{ final: false, cursor }` when the plan is not exhausted -- the
 * caller re-queues the job with that cursor and part_count = part -- or
 * `{ final: true, index, ... }` when this part holds the index and the
 * backup is complete. Throws on anything that cannot be built in parts: a
 * corrupt cursor, a row or a file larger than one part, an index that does
 * not fit an empty part.
 */
export async function buildNextClosurePart(
  supabase: ServiceClient,
  job: ClaimedClosureJob,
  limits: PartLimits,
): Promise<ClosurePartResult> {
  const plan = await readPlan(supabase, job.id);
  const exported = plan.filter((p) => p.disposition === "exported");
  for (const entry of exported) {
    if (typeof entry.key_column !== "string" || entry.key_column === "") {
      throw new Error(
        `export plan: public.${entry.table_name} is exported with no key column. private.export_catalogue_is_sound() refuses that shape, so the catalogue and the plan disagree.`,
      );
    }
  }

  let cursor: ResumeCursor;
  if (job.part_count === 0) {
    cursor = freshCursor();
  } else {
    const parsed = parseResumeCursor(job.resume_cursor);
    if (parsed === null || parsed.parts.length !== job.part_count) {
      throw new Error("the closure backup's resume point is missing or corrupt, so it cannot be continued");
    }
    cursor = structuredClone(parsed);
  }

  const n = job.part_count + 1;
  const key = exportStorageKey(job.id, n);
  const at = new Date(cursor.generatedAt);
  const zip = new ZipWriter(limits.max_archive_bytes, limits.max_entries);
  const part: PartState = {
    rows: 0,
    slices: [],
    files: [],
    withheld: [],
    rowCounts: {},
    reserve: PART_MANIFEST_BASE_RESERVE,
  };
  let closedBy: PartCloseReason | null = null;
  let emptyBecause = "a part of the closure backup would close with nothing in it";

  // ---- the tables -------------------------------------------------------
  while (cursor.phase === "tables" && closedBy === null) {
    if (cursor.planIndex >= exported.length) {
      const hasDocuments = job.kind === "workspace" && exported.some((t) => t.table_name === "documents");
      cursor.phase = hasDocuments ? "files" : "index";
      cursor.after = "";
      cursor.tableRowsSoFar = 0;
      break;
    }
    const entry = exported[cursor.planIndex];
    const reason = await writeSlice(supabase, zip, job.id, entry.table_name, entry.key_column!, limits, cursor, part, at);
    if (reason === null) {
      cursor.planIndex += 1;
      cursor.after = "";
      cursor.tableRowsSoFar = 0;
    } else {
      closedBy = reason;
      emptyBecause = `a row of public.${entry.table_name} is larger than one part of the backup can hold`;
    }
  }

  // ---- the files (a closure backup is a workspace export: documents) -----
  if (cursor.phase === "files" && closedBy === null) {
    const documents = exported.find((t) => t.table_name === "documents")!;
    closedBy = await writeDocuments(supabase, zip, job.id, documents.key_column!, limits, cursor, part, at);
  }

  // ---- the index ---------------------------------------------------------
  if (cursor.phase === "index" && closedBy === null) {
    // The paths and withholding sentences are RE-DERIVED here, from the
    // database, never carried in the cursor (no record content in it).
    const documentsEntry = exported.find((t) => t.table_name === "documents");
    const names =
      cursor.documents.length + cursor.withheldDocuments.length > 0 && documentsEntry
        ? await readDocumentNames(supabase, job.id, documentsEntry.key_column!, limits.page_size)
        : new Map<string, { filename: string; scan: unknown }>();
    const nameOf = (id: string): { filename: string; scan: unknown } => {
      const found = names.get(id);
      if (!found) throw new Error(`documents/${id} is no longer readable, so the backup's index cannot name it`);
      return found;
    };
    const files = cursor.documents.map((d) => ({ path: documentPath(d.id, nameOf(d.id).filename), bytes: d.bytes }));
    const withheld = [
      ...staticWithheld(plan),
      ...cursor.withheldDocuments.map((w) => documentWithholding(w.id, nameOf(w.id).filename, w.why, nameOf(w.id).scan)),
    ];
    const indexOf = (bytes: number): ClosureFinalManifest => ({
      schemaVersion: CLOSURE_PARTS_MANIFEST_VERSION,
      kind: job.kind,
      jobId: job.id,
      generatedAt: cursor.generatedAt,
      subject: { userId: job.requested_by, organisationId: job.organisation_id },
      rowCounts: cursor.rowCounts,
      files,
      withheld,
      notes: [
        ...archiveNotes(job.kind, plan),
        `This backup is ${n} parts. Together they are the whole backup; this part (${n}) holds the index.`,
      ],
      parts: [
        ...cursor.parts,
        {
          part: n,
          key,
          bytes,
          rows: part.rows,
          slices: part.slices,
          files: part.files.length,
          closedBy: "final",
        },
      ],
      indexPart: n,
      part: n,
      slices: part.slices,
    });

    const placed = placeIndex(zip, manifestBytes(indexOf(Number.MAX_SAFE_INTEGER)).length, isEmpty(zip, part));
    if (placed === "here") {
      // THE INDEX STATES ITS OWN PART'S LENGTH. Stored rather than deflated,
      // the archive's length is the bytes so far plus the manifest's own
      // length, which depends on the byte count only through its number of
      // digits: so try each digit count and keep the one that agrees with
      // itself.
      const nameBytes = Buffer.byteLength("manifest.json", "utf8");
      const base = zip.byteLength + 30 + nameBytes + zip.directoryByteLength + 46 + nameBytes + 22;
      let finalBytes = -1;
      for (let digits = 1; digits <= 16 && finalBytes < 0; digits += 1) {
        const total = base + manifestBytes(indexOf(10 ** (digits - 1))).length;
        if (String(total).length === digits) finalBytes = total;
      }
      if (finalBytes < 0) throw new Error("the closure backup's index could not state its own length");

      const index = indexOf(finalBytes);
      zip.addEntry("manifest.json", manifestBytes(index), at, { store: true });
      const archive = zip.finish();
      if (archive.length !== finalBytes) {
        throw new Error(`the closure backup's index says ${finalBytes} bytes and the part is ${archive.length}`);
      }
      await storePart(supabase, job.id, n, key, archive, part.rows);
      return {
        final: true,
        part: n,
        index,
        byteSize: cursor.parts.reduce((s, p) => s + p.bytes, 0) + archive.length,
        rowCount: cursor.parts.reduce((s, p) => s + p.rows, 0) + part.rows,
        tableCount: Object.keys(cursor.rowCounts).length,
      };
    }

    // Close this part with the ceiling the index met, and put the index alone
    // in the next one (the cursor stays at "index").
    closedBy = placed;
  }

  // ---- close an ordinary part -------------------------------------------
  if (closedBy === null) {
    throw new Error("the closure backup's builder stopped without closing a part");
  }
  if (isEmpty(zip, part)) throw new Error(emptyBecause);

  const manifest: ClosurePartManifest = {
    schemaVersion: CLOSURE_PARTS_MANIFEST_VERSION,
    kind: job.kind,
    jobId: job.id,
    generatedAt: cursor.generatedAt,
    subject: { userId: job.requested_by, organisationId: job.organisation_id },
    rowCounts: part.rowCounts,
    files: part.files,
    withheld: part.withheld,
    notes: [
      `This is part ${n} of a closure backup in several parts. Together the parts are the whole backup; the last part holds the index, which lists every part.`,
      "Deleted records are included and carry their deleted_at timestamp.",
      "Times are UTC.",
    ],
    part: n,
    slices: part.slices,
  };
  const manifestBuf = manifestBytes(manifest);
  if (!zip.wouldFit("manifest.json", manifestBuf.length, 0, 0)) {
    throw new Error(
      `part ${n}'s manifest (${manifestBuf.length} bytes) outgrew the room reserved for it -- a bug in the part builder's accounting`,
    );
  }
  zip.addEntry("manifest.json", manifestBuf, at);
  const archive = zip.finish();
  await storePart(supabase, job.id, n, key, archive, part.rows);

  cursor.parts.push({
    part: n,
    key,
    bytes: archive.length,
    rows: part.rows,
    slices: part.slices,
    files: part.files.length,
    closedBy,
  });
  return { final: false, part: n, cursor };
}

/**
 * Remove every part of a FAILED closure backup: the objects at
 * exportStorageKey(jobId, k) for k = 1 .. (stored parts + 1, which covers an
 * upload whose part row never landed), in chunks, then the part rows -- which
 * private.export_job_parts_guard() admits only once the job has failed.
 *
 * Throws with what could not be removed; the runner logs it and goes on, and
 * a failed job's leftover objects are orphans the retention sweep takes.
 */
export async function removeClosureParts(supabase: ServiceClient, jobId: string): Promise<void> {
  // ONE ROW, THE HIGHEST. An unordered read of every part row is capped by
  // PostgREST's max_rows (1000, supabase/config.toml), so past a thousand
  // parts it would pick the highest of an arbitrary page and leave objects
  // behind -- and the rows are deleted below, so a retry could not find them.
  const { data, error } = await supabase
    .from("export_job_parts")
    .select("part_no")
    .eq("job_id", jobId)
    .order("part_no", { ascending: false })
    .limit(1);
  if (error) throw new Error(`the stored parts could not be read: ${error.message}`);
  const highest = ((data ?? []) as { part_no: number }[])[0]?.part_no ?? 0;

  const keys: string[] = [];
  for (let k = 1; k <= highest + 1; k += 1) keys.push(exportStorageKey(jobId, k));

  const failures: string[] = [];
  const bucket = createStorageClient().storage.from(EXPORT_BUCKET);
  for (let i = 0; i < keys.length; i += REMOVE_CHUNK) {
    const { error: removeError } = await bucket.remove(keys.slice(i, i + REMOVE_CHUNK));
    if (removeError) failures.push(`objects ${i + 1}-${Math.min(i + REMOVE_CHUNK, keys.length)}: ${removeError.message}`);
  }
  const { error: deleteError } = await supabase.from("export_job_parts").delete().eq("job_id", jobId);
  if (deleteError) failures.push(`part rows: ${deleteError.message}`);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

async function readPlan(supabase: ServiceClient, jobId: string): Promise<PlanRow[]> {
  const { data, error } = await supabase.rpc("export_plan", { p_job_id: jobId });
  if (error) throw new Error(`export plan: ${error.message}`);
  return (data ?? []) as PlanRow[];
}

/** A new backup's cursor: ids, keys and counts only, nothing a person typed. */
function freshCursor(): ResumeCursor {
  return {
    v: 1,
    phase: "tables",
    planIndex: 0,
    after: "",
    tableRowsSoFar: 0,
    rowCounts: {},
    documents: [],
    withheldDocuments: [],
    parts: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * What buildAndStore states as withheld for every archive, from the plan: the
 * FK-less remainder, every excused table, and the audit-payload line.
 * Re-derived for the index rather than carried in the cursor. A COPY of
 * buildAndStore's text (which stays untouched): the parity assertion in
 * tests/integration/export/closure-parts.test.ts reds if the two drift.
 */
function staticWithheld(plan: PlanRow[]): ExportWithholding[] {
  const withheld: ExportWithholding[] = REMAINDER_WITHHELD.map((entry) => ({
    what: `public.${entry.table}`,
    reason: "table_excused" as const,
    detail: entry.detail,
  }));
  for (const entry of plan) {
    if (entry.disposition === "excused") {
      withheld.push({
        what: `public.${entry.table_name}`,
        reason: "table_excused",
        detail: entry.reason ?? WITHHOLDING_COPY.table_excused,
      });
    } else if (entry.authorisation === "elevated" && entry.table_name === "audit_events") {
      withheld.push({
        what: "public.audit_events.before / .after",
        reason: "audit_payload_withheld",
        detail: WITHHOLDING_COPY.audit_payload_withheld,
      });
    }
  }
  return withheld;
}

/** A document's path in the archive -- buildAndStore's shape. */
function documentPath(id: string, filename: string): string {
  return `files/documents/${id}-${sanitiseFilename(filename)}`;
}

/**
 * The statement for a withheld document -- buildAndStore's two sentences,
 * copied (parity-tested against an ordinary archive in closure-parts.test.ts).
 */
function documentWithholding(
  id: string,
  filename: string,
  why: DocumentWithheldBecause,
  scanStatus: unknown,
): ExportWithholding {
  return {
    what: `documents/${id} (${sanitiseFilename(filename)})`,
    reason: "document_not_clean",
    detail:
      why === "not_clean"
        ? `${WITHHOLDING_COPY.document_not_clean} Scan status: ${String(scanStatus)}.`
        : "This file's record is included but its bytes could not be read from storage when the archive was built.",
  };
}

/**
 * Re-read the documents' filenames and scan statuses for the index, keyset by
 * page under the same RLS as every other read. The workspace is closed and
 * read-only, so these are the rows the files phase saw; a document the cursor
 * names that is no longer readable is a refusal, not a guess.
 */
async function readDocumentNames(
  supabase: ServiceClient,
  jobId: string,
  keyColumn: string,
  pageSize: number,
): Promise<Map<string, { filename: string; scan: unknown }>> {
  const out = new Map<string, { filename: string; scan: unknown }>();
  let after = "";
  for (;;) {
    const page = await readPage(supabase, jobId, "documents", after, pageSize);
    for (const row of page) {
      if (typeof row.id === "string") {
        out.set(row.id, {
          filename: typeof row.filename === "string" ? row.filename : "document",
          scan: row.scan_status,
        });
      }
    }
    if (page.length < pageSize) return out;
    const last = keyOf(page[page.length - 1], keyColumn);
    if (last === null || last === after) throw new Error("export read documents: the page cursor did not advance");
    after = last;
  }
}

/**
 * WHERE THE INDEX GOES (Q228). `"here"` when an index of at most
 * `indexUpperBound` bytes fits this part; otherwise the ceiling that refused
 * it, so the part closes and the index goes alone into the next. An index
 * that does not fit an EMPTY part cannot be written at all, and is a named
 * refusal (Spec correction 8). Pure, so the refusal is unit-tested.
 */
export function placeIndex(
  zip: ZipWriter,
  indexUpperBound: number,
  partIsEmpty: boolean,
): "here" | "bytes" | "entries" {
  if (zip.wouldFit("manifest.json", indexUpperBound, 0, 0)) return "here";
  if (partIsEmpty) {
    throw new Error("the index of this backup is larger than one part of the backup can hold");
  }
  return zip.entryCount + 1 > zip.entryLimit ? "entries" : "bytes";
}

/** The notes buildAndStore writes into an ordinary archive, for the index (a parity-tested copy). */
function archiveNotes(kind: ExportKind, plan: PlanRow[]): string[] {
  return [
    kind === "workspace"
      ? "Every table in this archive was read with the access rights of the person who asked for it, so anything they cannot see in the product — a colleague's private notes, for example — is not here either."
      : "This archive is about your ACCOUNT. It does not contain the records a workspace keeps: those belong to the business that keeps them, and its Owner or Admin can export them from the workspace's own settings.",
    "Deleted records are included and carry their deleted_at timestamp.",
    "Times are UTC.",
    ...(kind === "account" &&
    plan.some((p) => p.table_name === "impersonation_sessions" && p.disposition === "exported")
      ? [SUPPORT_ACCESS_NOTE]
      : []),
  ];
}

/**
 * Upload a finished part and record it. The object first, then the row: a
 * row never names bytes that are not there, and an object whose row did not
 * land is the one removeClosureParts covers with its `+ 1`. upsert, as for an
 * ordinary archive: the key is derived from the job and the part, and a job
 * is claimed by one runner at a time.
 */
async function storePart(
  supabase: ServiceClient,
  jobId: string,
  partNo: number,
  key: string,
  archive: Buffer,
  rows: number,
): Promise<void> {
  const { error: uploadError } = await createStorageClient()
    .storage.from(EXPORT_BUCKET)
    .upload(key, archive, { contentType: "application/zip", upsert: true });
  if (uploadError) throw new Error(`export upload (part ${partNo}): ${uploadError.message}`);
  const { error } = await supabase.from("export_job_parts").insert({
    job_id: jobId,
    part_no: partNo,
    storage_key: key,
    byte_size: archive.length,
    row_count: rows,
  });
  if (error) throw new Error(`export part ${partNo}: ${error.message}`);
}

function manifestBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** The pretty-printed cost of one entry in a manifest list, with room for its nesting. */
function entryReserve(value: unknown, extra = 0): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") + 8 + 64 + extra;
}

function sliceReserve(table: string, firstKey: string, lastKey: string, rows: number): number {
  const slice: PartSlice = { table, file: `tables/${table}.json`, firstKey, lastKey, rows };
  // + the part's rowCounts line for the table.
  return entryReserve(slice, Buffer.byteLength(table, "utf8") + 32);
}

function isEmpty(zip: ZipWriter, part: PartState): boolean {
  return zip.entryCount === 0 && part.withheld.length === 0;
}

/** Which ceiling refused the next entry (with manifest.json still owed). */
function closeReasonOf(zip: ZipWriter): PartCloseReason {
  return zip.entryCount + 2 > zip.entryLimit ? "entries" : "bytes";
}

function keyOf(row: Record<string, unknown>, keyColumn: string): string | null {
  const candidate = row[keyColumn];
  return typeof candidate === "string" ? candidate : null;
}

async function readPage(
  supabase: ServiceClient,
  jobId: string,
  table: string,
  after: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase.rpc("export_read_page", {
    p_job_id: jobId,
    p_table: table,
    p_after: after,
    p_limit: limit,
  });
  if (error) {
    // Q242: the workspace was reopened, or its closer is no longer an Owner.
    // Said plainly, because the failed job shows this sentence to the Owner.
    const stopped =
      error.hint && Object.hasOwn(CLOSURE_BACKUP_STOPPED, error.hint) ? CLOSURE_BACKUP_STOPPED[error.hint] : null;
    throw new Error(stopped ?? `export read ${table}: ${error.message}`);
  }
  return (data ?? []) as Record<string, unknown>[];
}

/**
 * Write this part's slice of one table, from `cursor.after`.
 *
 * Returns `null` when the table ENDED inside this part (the caller moves to
 * the next table), or the ceiling that closed the part. On a cut the slice
 * ends at the LAST ROW WRITTEN and `cursor.after` is that row's key -- never
 * the page's last key: rows of a page beyond the cut are discarded and read
 * again by the next claim (keyset, so nothing is skipped or repeated).
 *
 * The page asked for is never larger than the room left under the two row
 * ceilings, so the row ceilings cannot be passed; the byte and entry
 * ceilings are asked of the writer row by row (ZipWriter.wouldFit), with the
 * slice's own manifest entry reserved.
 */
async function writeSlice(
  supabase: ServiceClient,
  zip: ZipWriter,
  jobId: string,
  table: string,
  keyColumn: string,
  limits: PartLimits,
  cursor: ResumeCursor,
  part: PartState,
  at: Date,
): Promise<PartCloseReason | null> {
  const name = `tables/${table}.json`;
  const pieces: string[] = [];
  let bytes = Buffer.byteLength(TABLE_HEAD, "utf8");
  let rows = 0;
  let firstKey = "";
  let lastKey = "";
  let after = cursor.after;
  let reason: PartCloseReason | null = null;
  let exhausted = false;

  pages: for (;;) {
    const leftInTable = limits.max_rows_per_table - rows;
    const leftInPart = limits.max_total_rows - part.rows - rows;
    if (leftInTable <= 0) {
      reason = "rows_per_table";
      break;
    }
    if (leftInPart <= 0) {
      reason = "total_rows";
      break;
    }
    const pageLimit = Math.min(limits.page_size, leftInTable, leftInPart);
    const page = await readPage(supabase, jobId, table, after, pageLimit);
    if (page.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of page) {
      const rowKey = keyOf(row, keyColumn);
      if (rowKey === null) throw new Error(`export read ${table}: a row has no ${keyColumn}`);
      const piece = `${rows === 0 ? "" : ",\n"}${JSON.stringify(row)}`;
      const pieceBytes = Buffer.byteLength(piece, "utf8");
      const reserve = part.reserve + sliceReserve(table, rows === 0 ? rowKey : firstKey, rowKey, rows + 1);
      if (!zip.wouldFit(name, bytes + pieceBytes + TAIL_BYTES, reserve, 1)) {
        reason = closeReasonOf(zip);
        break pages;
      }
      pieces.push(piece);
      bytes += pieceBytes;
      rows += 1;
      if (rows === 1) firstKey = rowKey;
      lastKey = rowKey;
    }
    if (lastKey === after) throw new Error(`export read ${table}: the page cursor did not advance`);
    after = lastKey;
    if (page.length < pageLimit) {
      exhausted = true;
      break;
    }
  }

  if (rows === 0 && exhausted && cursor.tableRowsSoFar === 0) {
    // An EMPTY table still gets its (empty) file, as in an ordinary archive,
    // so the parts hold every table the plan exports.
    if (!zip.wouldFit(name, bytes + TAIL_BYTES, part.reserve + sliceReserve(table, "", "", 0), 1)) {
      return closeReasonOf(zip);
    }
  } else if (rows === 0) {
    return exhausted ? null : reason;
  }

  zip.addEntry(name, Buffer.from(`${TABLE_HEAD}${pieces.join("")}${TABLE_TAIL}`, "utf8"), at);
  const slice: PartSlice = { table, file: name, firstKey, lastKey, rows };
  part.slices.push(slice);
  part.reserve += sliceReserve(table, firstKey, lastKey, rows);
  part.rows += rows;
  part.rowCounts[table] = rows;
  cursor.rowCounts[table] = (cursor.rowCounts[table] ?? 0) + rows;

  if (exhausted) return null;
  cursor.after = lastKey;
  cursor.tableRowsSoFar += rows;
  return reason;
}

/**
 * The documents' BYTES, from `cursor.after` in the documents' keyset order.
 * A clean file goes in whole or not at all: when it does not fit, the part
 * closes and the next claim starts with it -- and when it does not fit an
 * EMPTY part, the backup cannot be built and the job fails (Spec correction
 * 8). A file that is not clean, or whose bytes cannot be read, is withheld
 * with the same statement an ordinary archive makes.
 *
 * Returns the ceiling that closed the part, or `null` when the documents
 * ended (the cursor moves to the index).
 */
async function writeDocuments(
  supabase: ServiceClient,
  zip: ZipWriter,
  jobId: string,
  keyColumn: string,
  limits: PartLimits,
  cursor: ResumeCursor,
  part: PartState,
  at: Date,
): Promise<PartCloseReason | null> {
  const bucket = createStorageClient().storage.from("documents");
  // The part's own manifest (inside the zip) states the sentence; the CURSOR
  // keeps only the document's id and why -- never its filename.
  const withhold = (id: string, name: string, why: DocumentWithheldBecause, scan: unknown): boolean => {
    const entry = documentWithholding(id, name, why, scan);
    const cost = entryReserve(entry);
    if (!zip.wouldFit("manifest.json", 0, part.reserve + cost, 0)) return false;
    part.withheld.push(entry);
    cursor.withheldDocuments.push({ id, why });
    part.reserve += cost;
    return true;
  };

  for (;;) {
    const page = await readPage(supabase, jobId, "documents", cursor.after, limits.page_size);
    if (page.length === 0) break;
    for (const row of page) {
      const rowKey = keyOf(row, keyColumn);
      if (rowKey === null) throw new Error(`export read documents: a row has no ${keyColumn}`);
      const id = typeof row.id === "string" ? row.id : null;
      const storageKey = typeof row.storage_key === "string" ? row.storage_key : null;
      const name = typeof row.filename === "string" ? row.filename : "document";

      if (id !== null && storageKey !== null) {
        if (row.scan_status !== "clean") {
          if (!withhold(id, name, "not_clean", row.scan_status)) return "bytes";
        } else {
          const { data, error } = await bucket.download(storageKey);
          const bytes = error || !data ? null : new Uint8Array(await data.arrayBuffer());
          if (bytes === null) {
            if (!withhold(id, name, "unreadable", row.scan_status)) return "bytes";
          } else {
            const path = documentPath(id, name);
            const cost = entryReserve({ path, bytes: bytes.length });
            if (!zip.wouldFit(path, bytes.length, part.reserve + cost, 1)) {
              if (zip.entryCount === 0) {
                throw new Error(`documents/${id} is larger than one part of the backup can hold`);
              }
              return closeReasonOf(zip);
            }
            zip.addEntry(path, bytes, at);
            part.files.push({ path, bytes: bytes.length });
            cursor.documents.push({ id, bytes: bytes.length });
            part.reserve += cost;
          }
        }
      }
      cursor.after = rowKey;
    }
    if (page.length < limits.page_size) break;
  }
  cursor.phase = "index";
  cursor.after = "";
  return null;
}

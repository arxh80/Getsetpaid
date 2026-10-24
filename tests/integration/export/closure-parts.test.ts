// Q228: A CLOSURE BACKUP OF ANY SIZE, IN PARTS -- built by the real runner,
// against the real stack, and opened part by part from the real bucket.
//
// THE QUESTION THIS FILE ANSWERS is the founder's: "can the Owner download a
// backup of any size?" -- so it plants small workspaces, squeezes the four
// per-archive ceilings down until each one must bind (the runner's
// `limitsOverride`, which can only TIGHTEN a ceiling), and then proves three
// things about the parts that come out:
//
//   * NO PART BREAKS A CEILING -- and, the denominator, each ceiling really
//     did close a part (the index's `closedBy`), because a build that never
//     split would pass "no part breaks a ceiling" perfectly;
//   * THE UNION OF THE PARTS IS THE BACKUP: every table's slices, concatenated
//     in part order, hold exactly the rows an ordinary export of the same
//     workspace held a moment before it was closed -- no row missing at a
//     slice boundary, none written twice;
//   * A FAILURE LEAVES NOTHING: a backup that cannot be built in parts fails
//     whole, and the parts it had already stored are gone from the bucket and
//     from export_job_parts.
//
// The archive is read with a parser that walks the end-of-central-directory
// record (runner.test.ts's), not with the writer's bookkeeping.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { MINT_STEP_UP_SQL } from "../rls/support/step-up";

type Override = {
  max_rows_per_table?: number;
  max_total_rows?: number;
  max_archive_bytes?: number;
  max_entries?: number;
};

let pool: Pool;
let runPendingExportJobs: typeof import("@/lib/export/runner").runPendingExportJobs;
let createStorageClient: typeof import("@/lib/supabase/storage").createStorageClient;
let exportStorageKey: typeof import("@/lib/export/contract").exportStorageKey;

const DB_DEFAULTS = {
  max_rows_per_table: 50_000,
  max_total_rows: 500_000,
  max_archive_bytes: 41_943_040,
  max_entries: 65_535,
};

/** 80 KiB, incompressible: one fits a 160 KiB part beside the 64 KiB manifest reserve, two do not. */
const DOC_BYTES = 80 * 1024;
const OVERSIZED_DOC_BYTES = 200 * 1024;

/** The test-only schema that captures every resume cursor written (see beforeAll). */
const CURSOR_LOG = "q228_test_cursor_log";

/**
 * A company note of about 40 KB. Three of them are larger than the room a
 * 160 KiB part has beside its manifest reserve, so under the byte ceiling the
 * notes table is CUT IN THE MIDDLE OF A PAGE -- the only kind of cut where
 * resuming from the page's last key instead of the last row written would
 * skip rows (mutant T5). A row-ceiling cut never is: the page asked for is
 * never larger than the rows that still fit.
 */
function bigNote(label: string, i: number): string {
  return `${label} company note ${i}: ${randomBytes(20 * 1024).toString("hex")}`;
}

const created = { users: [] as string[], orgs: [] as string[], jobs: [] as string[], docKeys: [] as string[] };

// ---------------------------------------------------------------------------
// The archive reader
// ---------------------------------------------------------------------------
function readZip(archive: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = archive.subarray(start, start + compressedSize);
    out.set(name, method === 0 ? Buffer.from(payload) : inflateRawSync(payload));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

async function download(key: string): Promise<Buffer> {
  const { data, error } = await createStorageClient().storage.from("exports").download(key);
  if (error || !data) throw new Error(`could not download ${key}: ${error?.message ?? "no data"}`);
  return Buffer.from(await data.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
interface Workspace {
  orgId: string;
  slug: string;
  ownerId: string;
  managerId: string;
  cleanDocs: Map<string, Buffer>;
  dirtyDocId: string;
  /** A "clean" document whose object was never uploaded: withheld as unreadable. */
  missingDocId: string;
  /** Record content the resume cursor must never carry (filenames, names). */
  forbidden: string[];
}

async function asPerson<T>(userId: string, fn: (q: (sql: string, args?: unknown[]) => Promise<T[]>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2" }),
    ]);
    const out = await fn(async (sql, args) => (await client.query(sql, args)).rows as T[]);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedClosableWorkspace(label: string): Promise<Workspace> {
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const managerId = randomUUID();
  const slug = `qp-int-${label}-${orgId.slice(0, 8)}`;
  created.users.push(ownerId, managerId);
  created.orgs.push(orgId);

  await pool.query(
    `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
     select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
       from (values ($1::uuid, $3::text), ($2::uuid, $4::text)) v(u, e)`,
    [ownerId, managerId, `qp-int-owner-${ownerId}@test.local`, `qp-int-mgr-${managerId}@test.local`],
  );
  await pool.query(`insert into public.organisations (id, name, slug) values ($1, $2, $3)`, [
    orgId,
    `Parts ${label}`,
    slug,
  ]);
  await pool.query(
    `insert into public.organisation_subscriptions
       (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
     values ($1, 'starter', 'monthly', 2, 'active', now() + interval '30 days')
     on conflict (organisation_id) do update set plan_id = 'starter', status = 'active'`,
    [orgId],
  );
  await pool.query(
    `insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
     values ($1, $2, 'owner', 'active', now()), ($1, $3, 'manager', 'active', now())`,
    [orgId, ownerId, managerId],
  );
  for (let i = 1; i <= 9; i += 1) {
    await pool.query(`insert into public.contacts (organisation_id, name) values ($1, $2)`, [
      orgId,
      `${label} contact ${i}`,
    ]);
  }
  for (let i = 1; i <= 4; i += 1) {
    await pool.query(`insert into public.companies (organisation_id, name) values ($1, $2)`, [
      orgId,
      `${label} company ${i}`,
    ]);
  }
  await pool.query(
    `insert into public.notes (organisation_id, owner_user_id, body, visibility)
     values ($1, $3, $4, 'company'), ($1, $3, $5, 'company'), ($1, $3, $6, 'company'), ($1, $2, $7, 'private')`,
    [orgId, ownerId, managerId, bigNote(label, 1), bigNote(label, 2), bigNote(label, 3), `${label} owner private`],
  );

  const bucket = createStorageClient().storage.from("documents");
  const cleanDocs = new Map<string, Buffer>();
  let dirtyDocId = "";
  let missingDocId = "";
  const forbidden: string[] = [`${label} contact `, `${label} company `];
  for (const [i, kind] of (["clean", "clean", "clean", "quarantined", "missing"] as const).entries()) {
    const scan = kind === "quarantined" ? "quarantined" : "clean";
    const bytes = kind === "clean" ? randomBytes(DOC_BYTES) : Buffer.from(`%PDF-1.4 ${label} ${kind}\n`);
    forbidden.push(`${label}-${i}.pdf`);
    const { rows } = await pool.query<{ id: string; storage_key: string }>(
      `insert into public.documents
         (id, organisation_id, owner_user_id, filename, storage_key, mime_type, size_bytes, scan_status)
       select v.id, $1::uuid, $2::uuid, $3::text, $1::uuid::text || '/' || v.id::text, 'application/pdf', $4::bigint, 'pending'
         from (select gen_random_uuid() as id) v
       returning id, storage_key`,
      [orgId, ownerId, `${label}-${i}.pdf`, bytes.length],
    );
    await pool.query(`update public.documents set scan_status = $2, scanned_at = now() where id = $1`, [
      rows[0].id,
      scan,
    ]);
    if (kind === "missing") {
      // Its object is never uploaded, so both an ordinary archive and a
      // closure backup withhold it with the "could not be read" sentence --
      // the second document-withholding sentence the parity check compares.
      missingDocId = rows[0].id;
      continue;
    }
    const up = await bucket.upload(rows[0].storage_key, bytes, { contentType: "application/pdf", upsert: true });
    if (up.error) throw new Error(`fixture upload: ${up.error.message}`);
    created.docKeys.push(rows[0].storage_key);
    if (kind === "clean") cleanDocs.set(rows[0].id, bytes);
    else dirtyDocId = rows[0].id;
  }
  return { orgId, slug, ownerId, managerId, cleanDocs, dirtyDocId, missingDocId, forbidden };
}

async function startExport(userId: string, kind: "workspace" | "account", orgId: string | null): Promise<string> {
  const id = await asPerson<{ id: string }>(userId, async (q) => {
    if (kind === "workspace") await q(MINT_STEP_UP_SQL, ["workspace_export"]);
    const rows = await q(
      `insert into public.export_jobs (kind, organisation_id) values ($1, $2) returning id`,
      [kind, orgId],
    );
    return rows[0];
  });
  created.jobs.push(id.id);
  return id.id;
}

async function closeWorkspace(ws: Workspace): Promise<string> {
  const row = await asPerson<{ id: string }>(ws.ownerId, async (q) => {
    await q(MINT_STEP_UP_SQL, ["workspace_close"]);
    const rows = await q(`select public.close_my_workspace($1, $2, $3)::text as id`, [
      ws.orgId,
      ws.slug,
      "Q228 integration: closing to build a backup in parts",
    ]);
    return rows[0];
  });
  created.jobs.push(row.id);
  return row.id;
}

interface JobRow {
  status: string;
  failure_reason: string | null;
  storage_key: string | null;
  byte_size: string | null;
  row_count: string | null;
  table_count: number | null;
  part_count: number;
  resume_cursor: unknown;
  manifest: Record<string, unknown> | null;
}

async function jobRow(id: string): Promise<JobRow> {
  const { rows } = await pool.query<JobRow>(
    `select status, failure_reason, storage_key, byte_size::text, row_count::text, table_count,
            part_count, resume_cursor, manifest
       from public.export_jobs where id = $1`,
    [id],
  );
  return rows[0];
}

async function partRows(id: string): Promise<{ part_no: number; storage_key: string; byte_size: string; row_count: string }[]> {
  const { rows } = await pool.query(
    `select part_no, storage_key, byte_size::text, row_count::text
       from public.export_job_parts where job_id = $1 order by part_no`,
    [id],
  );
  return rows;
}

async function buildUntilDone(jobId: string, override?: Override, maxCalls = 500): Promise<JobRow> {
  for (let i = 0; i < maxCalls; i += 1) {
    const outcome = await runPendingExportJobs(override ? { limitsOverride: override } : undefined);
    expect(outcome.outcome).toBe("ok");
    const row = await jobRow(jobId);
    if (row.status === "succeeded" || row.status === "failed") return row;
    if (outcome.claimed === 0) throw new Error(`job ${jobId} is ${row.status} and nothing was claimed`);
  }
  throw new Error(`job ${jobId} did not finish in ${maxCalls} runner calls`);
}

async function keyColumns(jobId: string): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ table_name: string; key_column: string | null; disposition: string }>(
    `select table_name, key_column, disposition from public.export_plan($1)`,
    [jobId],
  );
  return new Map(rows.filter((r) => r.disposition === "exported").map((r) => [r.table_name, r.key_column!]));
}

interface Slice {
  table: string;
  file: string;
  firstKey: string;
  lastKey: string;
  rows: number;
}
interface PartSummary {
  part: number;
  key: string;
  bytes: number;
  rows: number;
  slices: Slice[];
  files: number;
  closedBy: string;
}
interface PartManifest {
  schemaVersion: number;
  part: number;
  slices: Slice[];
  rowCounts: Record<string, number>;
  files: { path: string; bytes: number }[];
  withheld: { what: string; reason: string; detail: string }[];
  notes: string[];
  parts?: PartSummary[];
  indexPart?: number;
}

interface Built {
  ws: Workspace;
  referenceJob: string;
  reference: Map<string, Buffer>;
  closureJob: string;
  row: JobRow;
  parts: { no: number; key: string; bytes: Buffer; entries: Map<string, Buffer>; manifest: PartManifest }[];
  keys: Map<string, string>;
}

async function buildCase(label: string, override: Override): Promise<Built> {
  const ws = await seedClosableWorkspace(label);

  // THE REFERENCE: an ordinary export of the same workspace, a moment before
  // it is closed, with no override -- one archive, today's shape.
  const referenceJob = await startExport(ws.ownerId, "workspace", ws.orgId);
  const refRow = await buildUntilDone(referenceJob);
  expect(refRow.status, `the reference export failed: ${refRow.failure_reason}`).toBe("succeeded");
  const reference = readZip(await download(refRow.storage_key!));
  const keys = await keyColumns(referenceJob);

  const closureJob = await closeWorkspace(ws);
  const row = await buildUntilDone(closureJob, override);

  const parts: Built["parts"] = [];
  if (row.status === "succeeded") {
    for (let n = 1; n <= row.part_count; n += 1) {
      const key = exportStorageKey(closureJob, n);
      const bytes = await download(key);
      const entries = readZip(bytes);
      const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as PartManifest;
      parts.push({ no: n, key, bytes, entries, manifest });
    }
  }
  return { ws, referenceJob, reference, closureJob, row, parts, keys };
}

function tableRows(entries: Map<string, Buffer>, name: string): Record<string, unknown>[] {
  return JSON.parse(entries.get(name)!.toString("utf8")) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
  ({ runPendingExportJobs } = await import("@/lib/export/runner"));
  ({ createStorageClient } = await import("@/lib/supabase/storage"));
  ({ exportStorageKey } = await import("@/lib/export/contract"));
  pool = new Pool({ connectionString: status.dbUrl });

  // Nothing else may be waiting: the runner claims whatever is queued, and an
  // override meant for this file's jobs must not reach somebody else's.
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from public.export_jobs where status in ('queued', 'running')`,
  );
  expect(rows[0].n, "another export is queued or running on this database; this file needs the queue to itself").toBe("0");

  // EVERY RESUME CURSOR THE RUNNER WRITES, captured as it is written. Sampling
  // the job between runner calls misses most of them (one call can claim a
  // job three times), and a no-record-content check that sees a third of the
  // cursors proves a third of the claim. Test-only: a schema of its own,
  // dropped (with its function and so its trigger) first thing in afterAll.
  await pool.query(`
    drop schema if exists ${CURSOR_LOG} cascade;
    create schema ${CURSOR_LOG};
    create table ${CURSOR_LOG}.cursors (seq bigserial primary key, job_id uuid not null, cursor jsonb not null);
    create function ${CURSOR_LOG}.capture() returns trigger language plpgsql security definer set search_path = '' as $$
    begin
      insert into ${CURSOR_LOG}.cursors (job_id, cursor) values (new.id, new.resume_cursor);
      return new;
    end $$;
    create trigger q228_test_capture_resume_cursor
      after update of resume_cursor on public.export_jobs
      for each row when (new.resume_cursor is not null)
      execute function ${CURSOR_LOG}.capture();`);
}, 60_000);

afterAll(async () => {
  if (!pool) return;
  await pool
    .query(`drop schema if exists ${CURSOR_LOG} cascade`)
    .catch((e) => console.error("teardown cursor log:", e));
  const storage = createStorageClient().storage;
  for (const job of created.jobs) {
    const { data } = await storage.from("exports").list("exports", { search: job, limit: 1000 });
    const names = (data ?? []).map((o) => `exports/${o.name}`);
    if (names.length > 0) await storage.from("exports").remove(names).catch(() => undefined);
  }
  if (created.docKeys.length > 0) await storage.from("documents").remove(created.docKeys).catch(() => undefined);
  await pool
    .query(`delete from public.audit_events where organisation_id = any($1::uuid[]) or actor_user_id = any($2::uuid[])`, [
      created.orgs,
      created.users,
    ])
    .catch((e) => console.error("teardown audit:", e));
  await pool
    .query(`delete from public.export_jobs where id = any($1::uuid[]) or organisation_id = any($2::uuid[]) or requested_by = any($3::uuid[])`, [
      created.jobs,
      created.orgs,
      created.users,
    ])
    .catch((e) => console.error("teardown jobs:", e));
  await pool
    .query(`delete from public.organisations where id = any($1::uuid[])`, [created.orgs])
    .catch((e) => console.error("teardown orgs:", e));
  await pool
    .query(`delete from public.platform_admins where user_id = any($1::uuid[])`, [created.users])
    .catch((e) => console.error("teardown platform admins:", e));
  await pool
    .query(`delete from auth.users where id = any($1::uuid[])`, [created.users])
    .catch((e) => console.error("teardown users:", e));
  await pool.end();
}, 120_000);

// ---------------------------------------------------------------------------
describe("THE KEY BINDING: exportStorageKey(job, n) is the database's CHECK expression", () => {
  it("for parts 1, 2, 9999, 10000 and 123456", async () => {
    const { rows } = await pool.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = 'public.export_job_parts'::regclass and c.conname = 'export_job_parts_storage_key_shape'`,
    );
    expect(rows.length, "the key-shape CHECK is missing").toBe(1);
    const body = rows[0].def.replace(/^CHECK\s*/, "");
    const job = randomUUID();
    for (const n of [1, 2, 9999, 10000, 123456]) {
      const key = exportStorageKey(job, n);
      const ok = await pool.query<{ ok: boolean }>(
        `select ${body} as ok from (select $1::uuid as job_id, $2::int as part_no, $3::text as storage_key) t`,
        [job, n, key],
      );
      expect(ok.rows[0].ok, `part ${n}: ${key}`).toBe(true);
      // ...and it is not a CHECK that admits anything: a neighbour's key is refused.
      const wrong = await pool.query<{ ok: boolean }>(
        `select ${body} as ok from (select $1::uuid as job_id, $2::int as part_no, $3::text as storage_key) t`,
        [job, n + 1, key],
      );
      expect(wrong.rows[0].ok, `part ${n + 1} accepted part ${n}'s key`).toBe(false);
    }
  });
});

const CASES: { name: string; override: Override; reasons: string[]; atLeast: number }[] = [
  { name: "C1 rows per table", override: { max_rows_per_table: 3 }, reasons: ["rows_per_table"], atLeast: 1 },
  { name: "C2 total rows", override: { max_total_rows: 7 }, reasons: ["total_rows"], atLeast: 1 },
  { name: "C3 bytes", override: { max_archive_bytes: 160 * 1024 }, reasons: ["bytes"], atLeast: 1 },
  { name: "C4 entries", override: { max_entries: 6 }, reasons: ["entries"], atLeast: 1 },
  {
    name: "C5 all four at once",
    override: { max_rows_per_table: 3, max_total_rows: 7, max_archive_bytes: 160 * 1024, max_entries: 6 },
    reasons: ["rows_per_table", "total_rows", "bytes", "entries"],
    atLeast: 2,
  },
];

describe.each(CASES)("$name", ({ name, override, reasons, atLeast }) => {
  let b: Built;
  const ceiling = { ...DB_DEFAULTS, ...override };

  beforeAll(async () => {
    b = await buildCase(name.split(" ")[0].toLowerCase(), override);
  }, 600_000);

  it("(a) the backup succeeded, in at least two parts, with part_count equal to the part rows", async () => {
    expect(b.row.status, `the closure backup failed: ${b.row.failure_reason}`).toBe("succeeded");
    expect(b.row.part_count).toBeGreaterThanOrEqual(2);
    expect((await partRows(b.closureJob)).length).toBe(b.row.part_count);
    expect(b.row.resume_cursor).toBeNull();
  });

  it("(b) the part keys are derived, and part 1 is the job's storage_key", async () => {
    const rows = await partRows(b.closureJob);
    expect(rows.map((r) => r.storage_key)).toEqual(rows.map((r) => exportStorageKey(b.closureJob, r.part_no)));
    expect(rows.map((r) => r.part_no)).toEqual(Array.from({ length: b.row.part_count }, (_, i) => i + 1));
    expect(b.row.storage_key).toBe(exportStorageKey(b.closureJob, 1));
  });

  it("(c) every part opens, says which part it is, and breaks no ceiling", () => {
    for (const p of b.parts) {
      expect(p.manifest.schemaVersion, `part ${p.no}`).toBe(3);
      expect(p.manifest.part, `part ${p.no}`).toBe(p.no);
      let partTotal = 0;
      for (const [name] of p.entries) {
        if (!name.startsWith("tables/")) continue;
        const n = tableRows(p.entries, name).length;
        expect(n, `part ${p.no} ${name} has more rows than the per-table ceiling`).toBeLessThanOrEqual(
          ceiling.max_rows_per_table,
        );
        partTotal += n;
      }
      expect(partTotal, `part ${p.no} has more rows than the total ceiling`).toBeLessThanOrEqual(ceiling.max_total_rows);
      expect(p.bytes.length, `part ${p.no} is larger than the byte ceiling`).toBeLessThanOrEqual(
        ceiling.max_archive_bytes,
      );
      expect(p.entries.size, `part ${p.no} has more entries than the entry ceiling`).toBeLessThanOrEqual(
        ceiling.max_entries,
      );
    }
  });

  it("(d) DENOMINATOR: the ceiling actually bound -- a part was closed by it", () => {
    const index = b.parts[b.parts.length - 1].manifest;
    const closedBy = new Set((index.parts ?? []).map((p) => p.closedBy));
    const bound = reasons.filter((r) => closedBy.has(r));
    expect(bound.length, `closedBy was ${[...closedBy].join(", ")}`).toBeGreaterThanOrEqual(atLeast);
    expect(index.parts?.[index.parts.length - 1].closedBy).toBe("final");
  });

  it("(e) THE UNION IS THE SOURCE: every table's slices hold exactly the reference's rows", () => {
    const refTables = [...b.reference.keys()].filter((k) => k.startsWith("tables/"));
    expect(refTables.length).toBeGreaterThan(20);
    const partTables = new Set(b.parts.flatMap((p) => [...p.entries.keys()].filter((k) => k.startsWith("tables/"))));
    expect([...partTables].sort(), "the parts hold a table file the reference does not, or miss one").toEqual(
      [...refTables].sort(),
    );
    for (const file of refTables) {
      const table = file.slice("tables/".length, -".json".length);
      const keyCol = b.keys.get(table);
      expect(keyCol, `no key column for ${table}`).toBeTruthy();
      const ref = tableRows(b.reference, file);
      const union = b.parts.flatMap((p) => (p.entries.has(file) ? tableRows(p.entries, file) : []));
      const refKeys = ref.map((r) => String(r[keyCol!]));
      const unionKeys = union.map((r) => String(r[keyCol!]));
      expect(new Set(unionKeys).size, `${table}: a row is written twice across parts`).toBe(unionKeys.length);
      expect([...unionKeys].sort(), `${table}: the parts' rows are not the reference's rows`).toEqual(
        [...refKeys].sort(),
      );
      if (table === "organisations") continue; // its lifecycle columns moved at closure
      const byKey = new Map(union.map((r) => [String(r[keyCol!]), r]));
      for (const r of ref) {
        expect(byKey.get(String(r[keyCol!])), `${table} ${String(r[keyCol!])}`).toEqual(r);
      }
    }
    // The fixture really was split: contacts has more rows than one part may hold in C1.
    if (override.max_rows_per_table) {
      expect(b.parts.filter((p) => p.entries.has("tables/contacts.json")).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("(f) every clean document is in exactly one part, byte for byte; the quarantined one is withheld", () => {
    for (const [id, bytes] of b.ws.cleanDocs) {
      const holders = b.parts.flatMap((p) =>
        [...p.entries.keys()].filter((k) => k.startsWith(`files/documents/${id}-`)).map((k) => ({ p, k })),
      );
      expect(holders.length, `document ${id} is in ${holders.length} parts`).toBe(1);
      expect(holders[0].p.entries.get(holders[0].k)!.equals(bytes), `document ${id}'s bytes differ`).toBe(true);
    }
    const dirty = b.ws.dirtyDocId;
    for (const p of b.parts) {
      expect([...p.entries.keys()].some((k) => k.includes(dirty)), `part ${p.no} carries the quarantined file`).toBe(false);
    }
    const index = b.row.manifest as unknown as PartManifest;
    expect(index.withheld.some((w) => w.what.includes(dirty) && w.reason === "document_not_clean")).toBe(true);
    // Named in exactly one non-index part, or -- when it was reached in the
    // index part itself -- only there.
    const naming = b.parts
      .slice(0, -1)
      .filter((p) => p.manifest.withheld.some((w) => w.what.includes(dirty)));
    expect(naming.length).toBeLessThanOrEqual(1);
  });

  it("(g) each slice's manifest entry matches its file: row count, first and last key", () => {
    for (const p of b.parts) {
      const files = [...p.entries.keys()].filter((k) => k.startsWith("tables/"));
      expect(p.manifest.slices.map((s) => s.file).sort(), `part ${p.no}: slices and files disagree`).toEqual(files.sort());
      for (const s of p.manifest.slices) {
        const rows = tableRows(p.entries, s.file);
        expect(s.rows, `part ${p.no} ${s.file}`).toBe(rows.length);
        if (rows.length === 0) continue;
        const keyCol = b.keys.get(s.table)!;
        expect(s.firstKey).toBe(String(rows[0][keyCol]));
        expect(s.lastKey).toBe(String(rows[rows.length - 1][keyCol]));
      }
    }
  });

  it("(i) NO RECORD CONTENT in the resume cursor: ids and counts, never a filename or a name", async () => {
    const { rows } = await pool.query<{ cursor: unknown }>(
      `select cursor from ${CURSOR_LOG}.cursors where job_id = $1 order by seq`,
      [b.closureJob],
    );
    const cursors = rows.map((r) => r.cursor);
    // Every re-queue writes one: one per part but the last.
    expect(cursors.length, "DENOMINATOR: not every re-queue's cursor was captured").toBe(b.row.part_count - 1);
    // ...and when a document was written before the last part, a cursor
    // after it carried that document -- the case the check is for.
    if (b.parts.slice(0, -1).some((p) => [...p.entries.keys()].some((k) => k.startsWith("files/documents/")))) {
      expect(
        cursors.some((c) => ((c as { documents?: unknown[] }).documents ?? []).length > 0),
        "DENOMINATOR: no captured cursor had reached a document",
      ).toBe(true);
    }
    const files = (b.row.manifest as unknown as PartManifest).files;
    expect(files.length, "DENOMINATOR: the backup wrote no document").toBeGreaterThan(0);
    for (const cursor of cursors) {
      const text = JSON.stringify(cursor);
      for (const needle of b.ws.forbidden) expect(text, `the cursor carries "${needle}"`).not.toContain(needle);
      expect(text).not.toContain("files/documents/");
    }
  });

  it("(j) PARITY with buildAndStore: the index states the reference archive's notes, withholdings and files", () => {
    // The closure builder holds COPIES of buildAndStore's text (which stays
    // untouched): the notes, the remainder/excused/audit statements, and the
    // two document-withholding sentences. A copy that drifts reds here.
    const index = b.row.manifest as unknown as PartManifest;
    const ref = JSON.parse(b.reference.get("manifest.json")!.toString("utf8")) as PartManifest;
    expect(index.notes.slice(0, -1)).toEqual(ref.notes);
    // Keys sorted: the job row's manifest is jsonb, which reorders them.
    const canon = (x: unknown) => JSON.stringify(Object.fromEntries(Object.entries(x as object).sort()));
    const sorted = (list: unknown[]) => list.map(canon).sort();
    expect(sorted(index.withheld)).toEqual(sorted(ref.withheld));
    expect(sorted(index.files)).toEqual(sorted(ref.files));
    // DENOMINATOR: both document sentences are in play.
    expect(ref.withheld.some((w) => w.what.includes(b.ws.dirtyDocId) && w.detail.includes("Scan status"))).toBe(true);
    expect(ref.withheld.some((w) => w.what.includes(b.ws.missingDocId) && w.detail.includes("could not be read"))).toBe(true);
  });

  it("(h) the job row: totals are the parts' sums, and the manifest is the index", async () => {
    const rows = await partRows(b.closureJob);
    const sumBytes = rows.reduce((s, r) => s + Number(r.byte_size), 0);
    const sumRows = rows.reduce((s, r) => s + Number(r.row_count), 0);
    expect(Number(b.row.byte_size)).toBe(sumBytes);
    expect(sumBytes).toBe(b.parts.reduce((s, p) => s + p.bytes.length, 0));
    for (const r of rows) expect(Number(r.byte_size)).toBe(b.parts[r.part_no - 1].bytes.length);
    expect(Number(b.row.row_count)).toBe(sumRows);
    const refRowTotal = [...b.reference.keys()]
      .filter((k) => k.startsWith("tables/"))
      .reduce((s, k) => s + tableRows(b.reference, k).length, 0);
    expect(sumRows).toBe(refRowTotal);
    const refTableCount = [...b.reference.keys()].filter((k) => k.startsWith("tables/")).length;
    expect(b.row.table_count).toBe(refTableCount);
    const index = b.row.manifest as unknown as PartManifest;
    expect(index.schemaVersion).toBe(3);
    expect(index.parts?.length).toBe(b.row.part_count);
    expect(index.indexPart).toBe(b.row.part_count);
    expect(index.parts?.map((p) => p.key)).toEqual(rows.map((r) => r.storage_key));
    expect(index.parts?.map((p) => p.bytes)).toEqual(rows.map((r) => Number(r.byte_size)));
    // ...and the index part's own manifest.json is that same index.
    expect(b.parts[b.parts.length - 1].manifest).toEqual(index);
    expect(index.notes.join(" ")).toContain(`This backup is ${b.row.part_count} parts.`);
  });
});

describe("C6: one claim builds at most one part", () => {
  it("after one runner call the job is queued with a cursor, or done, and part_count <= claimed", async () => {
    const ws = await seedClosableWorkspace("c6");
    const job = await closeWorkspace(ws);
    const outcome = await runPendingExportJobs({ limitsOverride: { max_rows_per_table: 3 } });
    expect(outcome.claimed).toBeGreaterThanOrEqual(1);
    expect(outcome.claimed).toBeLessThanOrEqual(3);
    const row = await jobRow(job);
    expect(["queued", "succeeded"]).toContain(row.status);
    expect(row.part_count).toBeLessThanOrEqual(outcome.claimed);
    expect(row.part_count).toBeGreaterThanOrEqual(1);
    if (row.status === "queued") {
      expect(row.resume_cursor).not.toBeNull();
      expect(outcome.requeued).toBeGreaterThanOrEqual(1);
    }
    // Finish it, so nothing is left queued for another file's runner.
    const done = await buildUntilDone(job, { max_rows_per_table: 3 });
    expect(done.status, `${done.failure_reason}`).toBe("succeeded");
  }, 600_000);
});

describe("C7: a backup that cannot be built in parts fails whole, and leaves nothing behind", () => {
  it("a document larger than any part fails the job, and every stored part is removed", async () => {
    const ws = await seedClosableWorkspace("c7");
    // One clean document re-uploaded at 200 KiB: larger than a 160 KiB part
    // can hold beside its manifest reserve. (160 KiB is C3's ceiling, where
    // the 80 KiB documents are proved to fit one per part.)
    const [bigId] = [...ws.cleanDocs.keys()];
    const key = `${ws.orgId}/${bigId}`;
    const up = await createStorageClient()
      .storage.from("documents")
      .upload(key, randomBytes(OVERSIZED_DOC_BYTES), { contentType: "application/pdf", upsert: true });
    expect(up.error?.message).toBeUndefined();

    const job = await closeWorkspace(ws);
    const row = await buildUntilDone(job, { max_archive_bytes: 160 * 1024 });

    expect(row.status).toBe("failed");
    expect(row.failure_reason).toContain(`documents/${bigId} is larger than one part of the backup can hold`);
    // DENOMINATOR: parts HAD been stored. part_count only advances through the
    // re-queue, which the database admits only when that many part rows
    // exist, and a failure does not reset it.
    expect(row.part_count, "no part was stored before the failure, so the cleanup proved nothing").toBeGreaterThanOrEqual(1);
    expect(row.resume_cursor).toBeNull();
    expect(await partRows(job)).toEqual([]);
    const { data, error } = await createStorageClient().storage.from("exports").list("exports", { search: job, limit: 1000 });
    expect(error?.message).toBeUndefined();
    expect((data ?? []).map((o) => o.name)).toEqual([]);
  }, 600_000);
});

describe("C9: a row larger than an empty part is a named refusal", () => {
  it("one ~40 KB note under a 100 KiB ceiling fails the job by name, and leaves nothing behind", async () => {
    // 100 KiB less the 64 KiB manifest reserve leaves about 36 KiB: smaller
    // than one of the fixture's ~40 KB company notes. No part can ever hold
    // that row, so the backup cannot be built and must say why -- rather than
    // storing empty parts for ever (the guard's mutant does exactly that).
    const ws = await seedClosableWorkspace("c9");
    const job = await closeWorkspace(ws);
    const row = await buildUntilDone(job, { max_archive_bytes: 100 * 1024 }, 60);
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toContain("a row of public.notes is larger than one part of the backup can hold");
    expect(await partRows(job)).toEqual([]);
    const { data } = await createStorageClient().storage.from("exports").list("exports", { search: job, limit: 1000 });
    expect((data ?? []).map((o) => o.name)).toEqual([]);
  }, 600_000);
});

describe("C10: removeClosureParts finds every part, past PostgREST's 1000-row page", () => {
  it("1005 stored parts and the in-flight 1006th are all removed, with their rows", async () => {
    const { removeClosureParts } = await import("@/lib/export/parts");
    const { createServiceClient } = await import("@/lib/supabase/service");
    const ws = await seedClosableWorkspace("c10");
    const job = await closeWorkspace(ws);
    // 1005 parts, stored the way the runner stores them: each while the job
    // is running and in order, then the legal re-queue, then a re-claim. As
    // postgres (a server session, which the guard admits).
    await pool.query(`
      do $$
      declare k integer; j uuid := '${job}';
      begin
        update public.export_jobs set status = 'running' where id = j;
        for k in 1..1005 loop
          insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
          values (j, k,
                  case when k = 1 then 'exports/' || j::text || '.zip'
                       else 'exports/' || j::text || '-part-' || lpad(k::text, greatest(4, length(k::text)), '0') || '.zip' end,
                  1, 0);
          update public.export_jobs set status = 'queued', part_count = k, resume_cursor = '{"v":1}' where id = j;
          update public.export_jobs set status = 'running' where id = j;
        end loop;
        update public.export_jobs set status = 'failed', failure_reason = 'C10' where id = j;
      end $$;`);
    expect((await partRows(job)).length, "DENOMINATOR: more part rows than one PostgREST page").toBe(1005);

    const bucket = createStorageClient().storage.from("exports");
    const planted = [1, 1000, 1001, 1005, 1006].map((k) => exportStorageKey(job, k));
    for (const key of planted) {
      const up = await bucket.upload(key, Buffer.from("PK"), { contentType: "application/zip", upsert: true });
      expect(up.error?.message).toBeUndefined();
    }
    await removeClosureParts(createServiceClient(), job);

    expect(await partRows(job)).toEqual([]);
    const { data, error } = await bucket.list("exports", { search: job, limit: 1000 });
    expect(error?.message).toBeUndefined();
    expect((data ?? []).map((o) => o.name), "objects past the first thousand parts were left behind").toEqual([]);
  }, 600_000);
});

describe("C11: a workspace reopened part-way stops its backup, and leaves nothing behind (Q242)", () => {
  it("the superuser reassigns between claims: the next claim fails the job by name and removes every part", async () => {
    const { CLOSURE_BACKUP_STOPPED } = await import("@/lib/export/contract");
    const ws = await seedClosableWorkspace("c11");
    const job = await closeWorkspace(ws);

    // One runner call under a one-row-per-table ceiling stores at most three
    // parts of a backup that needs dozens, and leaves it queued for the next.
    const override = { max_rows_per_table: 1 };
    const first = await runPendingExportJobs({ limitsOverride: override });
    expect(first.outcome).toBe("ok");
    const mid = await jobRow(job);
    expect(mid.status, `${mid.failure_reason}`).toBe("queued");
    expect(mid.part_count, "DENOMINATOR: no part was stored before the reopen, so the cleanup proves nothing").toBeGreaterThanOrEqual(1);
    expect((await partRows(job)).length).toBe(mid.part_count);

    // The aal2 platform superuser hands the closed workspace to its Manager,
    // which reopens it: the members can edit it again.
    const suId = randomUUID();
    created.users.push(suId);
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), now(), now())`,
      [suId, `qp-int-su-${suId}@test.local`],
    );
    await pool.query(`insert into public.platform_admins (user_id) values ($1)`, [suId]);
    await asPerson<null>(suId, async (q) => {
      await q(MINT_STEP_UP_SQL, ["closure_decision"]);
      await q(`select public.reassign_closed_workspace($1, $2, $3)`, [ws.slug, ws.managerId, "C11: reopened part-way"]);
      return null;
    });
    const { rows: org } = await pool.query<{ lifecycle_state: string }>(
      `select lifecycle_state from public.organisations where id = $1`,
      [ws.orgId],
    );
    expect(org[0].lifecycle_state).toBe("active");

    const row = await buildUntilDone(job, override, 5);
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toBe(
      `The export could not be built: ${CLOSURE_BACKUP_STOPPED.closure_backup_workspace_reopened}`,
    );
    expect(row.part_count, "the parts stored before the reopen are the ones removed").toBe(mid.part_count);
    expect(await partRows(job)).toEqual([]);
    const { data, error } = await createStorageClient().storage.from("exports").list("exports", { search: job, limit: 1000 });
    expect(error?.message).toBeUndefined();
    expect((data ?? []).map((o) => o.name)).toEqual([]);
  }, 600_000);
});

describe("C8: ordinary exports are unchanged", () => {
  it("an ordinary workspace export and an account export are one archive each, version 2, part_count 0", async () => {
    const ws = await seedClosableWorkspace("c8a");
    const wsJob = await startExport(ws.ownerId, "workspace", ws.orgId);
    const acJob = await startExport(ws.managerId, "account", null);
    for (const job of [wsJob, acJob]) {
      const row = await buildUntilDone(job);
      expect(row.status, `${row.failure_reason}`).toBe("succeeded");
      expect(row.part_count).toBe(0);
      expect(await partRows(job)).toEqual([]);
      const entries = readZip(await download(row.storage_key!));
      expect(JSON.parse(entries.get("manifest.json")!.toString("utf8")).schemaVersion).toBe(2);
      expect(row.storage_key).toBe(exportStorageKey(job));
    }
  }, 300_000);

  it("an ordinary export over a ceiling still FAILS with today's sentence -- it is never split", async () => {
    const ws = await seedClosableWorkspace("c8b");
    const job = await startExport(ws.ownerId, "workspace", ws.orgId);
    const row = await buildUntilDone(job, { max_rows_per_table: 3 });
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toMatch(
      /^The export could not be built: public\.\w+ has more than the 3-row ceiling for one table\. Nothing was truncated: the export failed instead\.$/,
    );
    expect(row.part_count).toBe(0);
    expect(await partRows(job)).toEqual([]);
  }, 300_000);
});

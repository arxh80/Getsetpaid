// THE EXPORT, OPENED AND READ.
//
// Everything else about this feature can be asserted from the catalogue: who
// may start a job, who may read the register, what the guards refuse. This
// file is the one that answers the only question that finally matters — WHAT
// IS IN THE ZIP — by running the real runner against the real stack and then
// parsing the archive back out of the real bucket.
//
// THE DENOMINATOR RULE, twice over and both ways round:
//   * before asserting that a colleague's PRIVATE note is absent, it asserts
//     that the requester's OWN private note is PRESENT. An export that
//     produced an empty file would satisfy every security assertion here
//     perfectly, and that is not hypothetical — the first cut of the
//     read-as-the-requester mechanism could not run at all (Postgres refuses
//     `SET role` inside a SECURITY DEFINER caller) and every "absent"
//     assertion in the psql suite passed while the engine was dead;
//   * before asserting that a quarantined document's BYTES are absent, it
//     asserts that the clean one's bytes are present and are the bytes that
//     were uploaded.
//
// It reads the archive with a ZIP parser that walks the end-of-central-
// directory record, not with the writer's own bookkeeping.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import type { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

let fx: RlsFixtures;
let pool: Pool;

// Imported lazily, AFTER the environment is set: lib/supabase/storage.ts and
// lib/supabase/service.ts read their keys at call time, but the module graph
// is cheaper to load once the values exist.
let runPendingExportJobs: typeof import("@/lib/export/runner").runPendingExportJobs;
let createStorageClient: typeof import("@/lib/supabase/storage").createStorageClient;

const OWNER_PRIVATE = "RUNNER-OWNER-PRIVATE: the owner's own private note";
const MANAGER_PRIVATE = "RUNNER-MANAGER-PRIVATE: a colleague's private note";
const COMPANY_NOTE = "RUNNER-COMPANY: a note the whole workspace can read";
const DELETED_NOTE = "RUNNER-DELETED: a note that was deleted";
const OTHER_TENANT = "RUNNER-OTHER-TENANT: a note in the other workspace";

// Q167 CHANGED (founder 2026-09-30): four break-glass sessions, two of which
// the account-export requester (the Manager) DECIDED and two of which they did
// not. The reason text is the needle: it is what the account archive now
// carries for the first two, and must still not carry for the last two.
const BG_ACCEPTED = "RUNNER-BREAKGLASS-ACCEPTED: the manager let support in";
const BG_DECLINED = "RUNNER-BREAKGLASS-DECLINED: the manager refused support";
const BG_COLLEAGUE = "RUNNER-BREAKGLASS-COLLEAGUE: the owner decided this one";
const BG_OTHER_TENANT = "RUNNER-BREAKGLASS-OTHER-TENANT: a session in the other workspace";
const IMPERSONATION_PROJECTION = [
  "id",
  "target_organisation_id",
  "superuser_user_id",
  "reason",
  "status",
  "requested_at",
  "admin_accepted_by",
  "accepted_at",
  "declined_by",
  "declined_at",
  "started_at",
  "expires_at",
  "ended_at",
];
const sessionIds: Record<string, string> = {};

const CLEAN_BYTES = Buffer.from("%PDF-1.4 runner fixture, clean\n", "utf8");
const DIRTY_BYTES = Buffer.from("%PDF-1.4 runner fixture, quarantined\n", "utf8");

/** Walks the archive the way an unzip does: from its own directory. */
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

async function fetchArchive(jobId: string): Promise<Map<string, Buffer>> {
  const { rows } = await pool.query<{ storage_key: string; status: string; failure_reason: string | null }>(
    `select storage_key, status, failure_reason from public.export_jobs where id = $1`,
    [jobId],
  );
  expect(rows[0]?.status, `the job failed: ${rows[0]?.failure_reason ?? "?"}`).toBe("succeeded");
  const bucket = createStorageClient().storage.from("exports");
  const { data, error } = await bucket.download(rows[0].storage_key);
  expect(error?.message).toBeUndefined();
  if (!data) throw new Error("no archive bytes");
  return readZip(Buffer.from(await data.arrayBuffer()));
}

function tableOf(entries: Map<string, Buffer>, table: string): Record<string, unknown>[] {
  const raw = entries.get(`tables/${table}.json`);
  expect(raw, `tables/${table}.json is not in the archive`).toBeDefined();
  return JSON.parse(raw!.toString("utf8")) as Record<string, unknown>[];
}

interface Manifest {
  schemaVersion: number;
  kind: string;
  rowCounts: Record<string, number>;
  files: { path: string; bytes: number }[];
  withheld: { what: string; reason: string; detail: string }[];
  notes: string[];
}

function manifestOf(entries: Map<string, Buffer>): Manifest {
  const raw = entries.get("manifest.json");
  expect(raw, "manifest.json is not in the archive").toBeDefined();
  return JSON.parse(raw!.toString("utf8")) as Manifest;
}

let workspaceJobId = "";
let accountJobId = "";
let cleanDocId = "";
let dirtyDocId = "";

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;

  ({ runPendingExportJobs } = await import("@/lib/export/runner"));
  ({ createStorageClient } = await import("@/lib/supabase/storage"));

  fx = await createFixtures();
  pool = fx._pool;

  // ---- the notes: one private each, one shared, one deleted, one foreign --
  await pool.query(
    `insert into public.notes (organisation_id, owner_user_id, body, visibility)
     values ($1,$2,$3,'private'), ($1,$4,$5,'private'), ($1,$4,$6,'company'), ($1,$2,$7,'company')`,
    [
      fx.orgA.id,
      fx.ownerA.userId,
      OWNER_PRIVATE,
      fx.activeByRole.manager.userId,
      MANAGER_PRIVATE,
      COMPANY_NOTE,
      DELETED_NOTE,
    ],
  );
  await pool.query(`update public.notes set deleted_at = now() where body = $1`, [DELETED_NOTE]);
  await pool.query(
    `insert into public.notes (organisation_id, owner_user_id, body, visibility)
     values ($1,$2,$3,'company')`,
    [fx.orgB.id, fx.ownerB.userId, OTHER_TENANT],
  );

  // ---- the documents: one clean with bytes, one quarantined with bytes ---
  // Planted rather than uploaded through the action: this file is about the
  // EXPORT, and the scanner's own behaviour is proved in
  // tests/integration/documents/upload-scan-download.test.ts.
  const bucket = createStorageClient().storage.from("documents");
  for (const [label, bytes, scan] of [
    ["clean", CLEAN_BYTES, "clean"],
    ["dirty", DIRTY_BYTES, "quarantined"],
  ] as const) {
    // The key has to be right AT INSERT: documents_storage_key_shape is a
    // CHECK, not a trigger, so a placeholder is refused -- which is the
    // control lib/crm/storage-keys.ts exists to satisfy, working.
    const { rows } = await pool.query<{ id: string; storage_key: string }>(
      `insert into public.documents
         (id, organisation_id, owner_user_id, filename, storage_key, mime_type, size_bytes, scan_status)
       select v.id, $1::uuid, $2::uuid, $3::text, $1::uuid::text || '/' || v.id::text, 'application/pdf', $4::bigint, 'pending'
         from (select gen_random_uuid() as id) v
       returning id, storage_key`,
      [fx.orgA.id, fx.ownerA.userId, `${label}.pdf`, bytes.length],
    );
    const id = rows[0].id;
    const key = rows[0].storage_key;
    await pool.query(
      `update public.documents set scan_status = $2, scanned_at = now() where id = $1`,
      [id, scan],
    );
    const up = await bucket.upload(key, bytes, { contentType: "application/pdf", upsert: true });
    expect(up.error?.message).toBeUndefined();
    if (label === "clean") cleanDocId = id;
    else dirtyDocId = id;
  }

  // ---- the break-glass sessions (Q167 CHANGED) ----------------------------
  // Planted as postgres: every client transition goes through a SECURITY
  // DEFINER RPC that demands aal2 and an org admin, and this file is about
  // what the EXPORT does with the rows, not about the lifecycle (proved in
  // rls_phase7_impersonation.sql). The status CHECK makes a declined session
  // one that was never accepted, hence one row per decision.
  for (const [label, org, decider, reason, decision] of [
    ["accepted", fx.orgA.id, fx.activeByRole.manager.userId, BG_ACCEPTED, "accepted"],
    ["declined", fx.orgA.id, fx.activeByRole.manager.userId, BG_DECLINED, "declined"],
    ["colleague", fx.orgA.id, fx.ownerA.userId, BG_COLLEAGUE, "accepted"],
    ["other", fx.orgB.id, fx.ownerB.userId, BG_OTHER_TENANT, "declined"],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      decision === "accepted"
        ? `insert into public.impersonation_sessions
             (superuser_user_id, target_organisation_id, reason, status,
              admin_accepted_by, accepted_at, started_at, expires_at, ended_at)
           values ($1, $2, $3, 'ended', $4, now(), now(), now() + interval '1 hour', now())
           returning id`
        : `insert into public.impersonation_sessions
             (superuser_user_id, target_organisation_id, reason, status, declined_by, declined_at)
           values ($1, $2, $3, 'declined', $4, now())
           returning id`,
      [fx.superuser.userId, org, reason, decider],
    );
    sessionIds[label] = rows[0].id;
  }

  // ---- the two jobs, started through the real INSERT path ----------------
  {
    const { data, error } = await fx.ownerA.client
      .from("export_jobs")
      .insert({ kind: "workspace", organisation_id: fx.orgA.id } as never)
      .select("id");
    if (error) throw new Error(`POSITIVE CONTROL FAILED: workspace export insert: ${error.message}`);
    workspaceJobId = ((data ?? []) as { id: string }[])[0].id;
  }
  {
    const { data, error } = await fx.activeByRole.manager.client
      .from("export_jobs")
      .insert({ kind: "account" } as never)
      .select("id");
    if (error) throw new Error(`POSITIVE CONTROL FAILED: account export insert: ${error.message}`);
    accountJobId = ((data ?? []) as { id: string }[])[0].id;
  }

  // ---- and the runner, for real ------------------------------------------
  const outcome = await runPendingExportJobs();
  expect(outcome.outcome).toBe("ok");
  expect(outcome.claimed, "the runner claimed neither job").toBeGreaterThanOrEqual(2);
  expect(outcome.failed, "a job failed").toBe(0);
}, 180_000);

afterAll(async () => {
  if (fx) {
    // Before the fixtures: superuser_user_id / admin_accepted_by / declined_by
    // have no ON DELETE, so a leftover session would block deleting the users.
    await pool
      .query(`delete from public.impersonation_sessions where id = any($1::uuid[])`, [
        Object.values(sessionIds),
      ])
      .catch(() => undefined);
    await pool
      .query(`delete from public.export_jobs where id = any($1::uuid[])`, [
        [workspaceJobId, accountJobId].filter(Boolean),
      ])
      .catch(() => undefined);
    await destroyFixtures(fx);
  }
});

describe("the workspace export, opened", () => {
  it("POSITIVE CONTROL: the Owner's OWN private note is in it, and so is the shared one", async () => {
    const notes = tableOf(await fetchArchive(workspaceJobId), "notes");
    const bodies = notes.map((n) => n.body);
    expect(bodies, "the export contains none of the owner's own notes").toContain(OWNER_PRIVATE);
    expect(bodies).toContain(COMPANY_NOTE);
  });

  it("THE RULE Q54 CLOSED: a colleague's PRIVATE note is NOT in it", async () => {
    const notes = tableOf(await fetchArchive(workspaceJobId), "notes");
    expect(notes.map((n) => n.body)).not.toContain(MANAGER_PRIVATE);
  });

  it("a SOFT-DELETED row is in it, and carries its deleted_at", async () => {
    const notes = tableOf(await fetchArchive(workspaceJobId), "notes");
    const deleted = notes.find((n) => n.body === DELETED_NOTE);
    expect(deleted, "the deleted note is missing — an export of a business must include them").toBeDefined();
    expect(deleted?.deleted_at, "the deleted note is not flagged as deleted").not.toBeNull();
  });

  it("the other tenant's rows are not in it, in any table", async () => {
    const entries = await fetchArchive(workspaceJobId);
    for (const [name, bytes] of entries) {
      if (!name.startsWith("tables/")) continue;
      expect(bytes.toString("utf8"), `${name} carries the other tenant's data`).not.toContain(
        OTHER_TENANT,
      );
      expect(bytes.toString("utf8"), `${name} carries the other tenant's id`).not.toContain(
        fx.orgB.id,
      );
    }
  });

  it("POSITIVE: a CLEAN document's bytes are in it, byte for byte", async () => {
    const entries = await fetchArchive(workspaceJobId);
    const path = [...entries.keys()].find((k) => k.startsWith(`files/documents/${cleanDocId}-`));
    expect(path, "the clean document's bytes are missing").toBeDefined();
    expect(entries.get(path!)!.equals(CLEAN_BYTES)).toBe(true);
  });

  it("...and a QUARANTINED document's bytes are NOT, with the manifest saying so", async () => {
    const entries = await fetchArchive(workspaceJobId);
    expect([...entries.keys()].some((k) => k.startsWith(`files/documents/${dirtyDocId}-`))).toBe(
      false,
    );
    // The bytes are not in the archive under any name either.
    for (const [name, bytes] of entries) {
      if (name === "manifest.json") continue;
      expect(bytes.includes(DIRTY_BYTES), `${name} carries the quarantined bytes`).toBe(false);
    }
    const withheld = manifestOf(entries).withheld;
    const entry = withheld.find((w) => w.what.includes(dirtyDocId));
    expect(entry, "the manifest does not say the quarantined file was withheld").toBeDefined();
    expect(entry?.reason).toBe("document_not_clean");
    expect(entry?.detail).toContain("quarantined");

    // ...and its ROW is still there, with its scan status, so the customer
    // knows the file exists.
    const docs = tableOf(entries, "documents");
    expect(docs.find((d) => d.id === dirtyDocId)?.scan_status).toBe("quarantined");
  });

  it("every EXCUSED table is named in the manifest with its reason", async () => {
    const manifest = manifestOf(await fetchArchive(workspaceJobId));
    const excused = manifest.withheld.filter((w) => w.reason === "table_excused").map((w) => w.what);
    expect(excused).toContain("public.audit_events");
    expect(excused).toContain("public.feedback");
    expect(excused).toContain("public.incident_alerts");
    for (const w of manifest.withheld) expect(w.detail.length).toBeGreaterThan(40);
  });

  it("the manifest's row counts agree with the files beside them", async () => {
    const entries = await fetchArchive(workspaceJobId);
    const manifest = manifestOf(entries);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.kind).toBe("workspace");
    for (const [table, count] of Object.entries(manifest.rowCounts)) {
      expect(tableOf(entries, table).length, `${table}'s manifest count is wrong`).toBe(count);
    }
    expect(Object.keys(manifest.rowCounts).length).toBeGreaterThan(20);
  });

  it("no table file is missing and no file is unaccounted for in the manifest", async () => {
    const entries = await fetchArchive(workspaceJobId);
    const manifest = manifestOf(entries);
    const inArchive = [...entries.keys()].filter((k) => k.startsWith("files/")).sort();
    expect(manifest.files.map((f) => f.path).sort()).toEqual(inArchive);
  });
});

describe("the account export, opened", () => {
  it("contains the person's own profile and memberships, and only theirs", async () => {
    const entries = await fetchArchive(accountJobId);
    const profiles = tableOf(entries, "profiles");
    expect(profiles.length).toBe(1);
    expect(profiles[0].id).toBe(fx.activeByRole.manager.userId);
    const memberships = tableOf(entries, "organisation_memberships");
    expect(memberships.length).toBeGreaterThan(0);
    for (const m of memberships) expect(m.user_id).toBe(fx.activeByRole.manager.userId);
  });

  it("POSITIVE CONTROL: the ELEVATED audit read returns rows -- it is not silently empty", async () => {
    // public.audit_events is superuser-only by policy, so a read under the
    // requester's own RLS would have returned ZERO and every assertion below
    // would still have passed. This is the assertion that would catch that.
    const audit = tableOf(await fetchArchive(accountJobId), "audit_events");
    expect(audit.length, "the account export's audit rows are empty").toBeGreaterThan(0);
    for (const row of audit) expect(row.actor_user_id).toBe(fx.activeByRole.manager.userId);
  });

  it("...and the audit payload is withheld, as the manifest says", async () => {
    const entries = await fetchArchive(accountJobId);
    const audit = tableOf(entries, "audit_events");
    for (const row of audit) {
      expect(Object.keys(row)).not.toContain("before");
      expect(Object.keys(row)).not.toContain("after");
      expect(Object.keys(row)).toContain("action");
    }
    expect(
      manifestOf(entries).withheld.some((w) => w.reason === "audit_payload_withheld"),
    ).toBe(true);
  });

  it("does NOT contain the workspace's records -- not its notes, not its contacts", async () => {
    const entries = await fetchArchive(accountJobId);
    expect(entries.has("tables/notes.json")).toBe(false);
    expect(entries.has("tables/contacts.json")).toBe(false);
    for (const [name, bytes] of entries) {
      if (name === "manifest.json") continue;
      expect(bytes.toString("utf8"), `${name} carries a workspace note`).not.toContain(COMPANY_NOTE);
    }
    // ...and the manifest says why, rather than leaving it a silent absence.
    const manifest = manifestOf(entries);
    expect(manifest.withheld.map((w) => w.what)).toContain("public.notes");
    expect(manifest.notes.join(" ")).toContain("does not contain the records a workspace keeps");
  });

  // Q167 CHANGED (founder 2026-09-30, 20261009000000). POSITIVE FIRST: the
  // two sessions the requester decided are present, WITH the operator's
  // reason and identity -- and only then that the two they did not decide
  // are absent, so an empty file cannot pass the second half.
  it("POSITIVE: every support-access session the person decided is in it, with the operator's reason and identity", async () => {
    const sessions = tableOf(await fetchArchive(accountJobId), "impersonation_sessions");
    const byId = new Map(sessions.map((r) => [r.id as string, r]));
    expect(byId.get(sessionIds.accepted)?.reason).toBe(BG_ACCEPTED);
    expect(byId.get(sessionIds.accepted)?.superuser_user_id).toBe(fx.superuser.userId);
    expect(byId.get(sessionIds.accepted)?.admin_accepted_by).toBe(fx.activeByRole.manager.userId);
    expect(byId.get(sessionIds.declined)?.reason).toBe(BG_DECLINED);
    expect(byId.get(sessionIds.declined)?.superuser_user_id).toBe(fx.superuser.userId);
    expect(byId.get(sessionIds.declined)?.declined_by).toBe(fx.activeByRole.manager.userId);
  });

  it("...and NO session they did not decide: not a colleague's in their own workspace, not another tenant's", async () => {
    const entries = await fetchArchive(accountJobId);
    const sessions = tableOf(entries, "impersonation_sessions");
    // The Manager is a fresh fixture user, so these two are the whole set.
    expect(sessions.map((r) => r.id).sort()).toEqual(
      [sessionIds.accepted, sessionIds.declined].sort(),
    );
    for (const [name, bytes] of entries) {
      const text = bytes.toString("utf8");
      expect(text, `${name} carries a colleague's break-glass reason`).not.toContain(BG_COLLEAGUE);
      expect(text, `${name} carries another tenant's break-glass reason`).not.toContain(BG_OTHER_TENANT);
    }
  });

  it("...and each row carries exactly the projection: the operator's reason and id, nothing else of theirs", async () => {
    const sessions = tableOf(await fetchArchive(accountJobId), "impersonation_sessions");
    expect(sessions.length).toBeGreaterThan(0);
    for (const row of sessions) {
      expect(Object.keys(row).sort()).toEqual([...IMPERSONATION_PROJECTION].sort());
    }
  });

  it("...and the manifest says what the operator id denotes", async () => {
    const manifest = manifestOf(await fetchArchive(accountJobId));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.notes.join(" ")).toContain("superuser_user_id");
    expect(manifest.notes.join(" ")).toContain("platform operator");
  });

  it("the person's own data subject requests are in it", async () => {
    const entries = await fetchArchive(accountJobId);
    const requests = tableOf(entries, "data_subject_requests");
    for (const r of requests) expect(r.user_id).toBe(fx.activeByRole.manager.userId);
  });
});

describe("the register after the run", () => {
  it("both jobs succeeded, with byte and row counts and a read-time expiry", async () => {
    const { rows } = await pool.query<{
      id: string;
      status: string;
      byte_size: string;
      row_count: string;
      table_count: number;
      expires_at: string;
    }>(
      `select id, status, byte_size, row_count, table_count, expires_at
         from public.export_jobs where id = any($1::uuid[])`,
      [[workspaceJobId, accountJobId]],
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe("succeeded");
      expect(Number(row.byte_size)).toBeGreaterThan(0);
      expect(Number(row.row_count)).toBeGreaterThan(0);
      expect(row.table_count).toBeGreaterThan(0);
      expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("neither completion was audited -- there is no actor to attribute one to", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.audit_events
        where action in ('export_job.succeeded','export_job.failed','export_job.completed')`,
    );
    expect(rows[0].n).toBe("0");
  });

  it("starting each one WAS audited, once, with the kind and no content", async () => {
    const { rows } = await pool.query<{ target_id: string; after: { kind: string } }>(
      `select target_id, after from public.audit_events
        where action = 'export_job.requested' and target_id = any($1::uuid[])`,
      [[workspaceJobId, accountJobId]],
    );
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.after.kind).sort()).toEqual(["account", "workspace"]);
  });
});

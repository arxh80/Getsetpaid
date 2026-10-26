import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";
import { getLocalSupabaseStatus } from "../rls/support/env";

// Phase 10 Task 23 (G36). The storage quota is a BEFORE INSERT trigger on
// public.documents; this drives the REAL uploadDocumentAction into it. A
// Starter workspace is filled to exactly 5 GiB with
// planted rows, so the next upload is refused with the quota sentence, and
// the action's orphan clean-up leaves neither a row nor a stored object.
// The positive control is the same upload once one plant is gone.
// Upload-budget counters are this user's own and cleared afterwards.

const current = vi.hoisted(() => ({
  userId: "",
  client: null as unknown,
  orgs: new Map<
    string,
    { id: string; name: string; slug: string; role: string; isSuspended: boolean }
  >(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => (current.userId ? { id: current.userId } : null),
  getCurrentOrg: async (slug: string) => current.orgs.get(slug) ?? null,
}));
vi.mock("@/lib/crm/write-access", () => ({
  getCrmWriteAccess: async () => ({ canWrite: true, explanation: "" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => current.client,
}));

import { uploadDocumentAction } from "@/lib/crm/documents";
import { STORAGE_QUOTA_MESSAGE } from "@/lib/security/upload-limits";

const CLEAN_PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");
const FIVE_GIB = 5 * 1024 ** 3;
const MAX_DOC = 26214400;

let fx: RlsFixtures;
let pool: Pool;

async function upload(name: string) {
  const fd = new FormData();
  fd.append("file", new File([CLEAN_PDF as unknown as BlobPart], name, { type: "application/pdf" }));
  return uploadDocumentAction(fx.orgA.slug, fd);
}

async function count(sql: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, [fx.orgA.id]);
  return Number(rows[0]?.n ?? 0);
}
const rowsNamed = (name: string) =>
  pool
    .query<{ n: string }>(
      `select count(*)::text as n from public.documents where organisation_id = $1 and filename = $2`,
      [fx.orgA.id, name],
    )
    .then((r) => Number(r.rows[0]?.n ?? 0));
const objects = () =>
  count(`select count(*)::text as n from storage.objects where bucket_id = 'documents' and name like $1 || '/%'`);
const usedBytes = () =>
  count(`select coalesce(sum(size_bytes), 0)::text as n from public.documents
          where organisation_id = $1 and bytes_purged_at is null`);

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;

  fx = await createFixtures();
  pool = fx._pool;
  current.orgs.set(fx.orgA.slug, {
    id: fx.orgA.id,
    name: fx.orgA.slug,
    slug: fx.orgA.slug,
    role: "manager",
    isSuspended: false,
  });
  current.userId = fx.activeByRole.manager.userId;
  current.client = fx.activeByRole.manager.client;

  // The fixtures put this workspace on Pro; the quota under test is Starter's.
  await pool.query(
    `update public.organisation_subscriptions set plan_id = 'starter' where organisation_id = $1`,
    [fx.orgA.id],
  );
  // Fill to exactly 5 GiB: rows only, no bytes behind them (the quota counts
  // size_bytes, which is what a real upload records).
  const full = Math.floor(FIVE_GIB / MAX_DOC);
  await pool.query(
    `insert into public.documents
       (organisation_id, filename, storage_key, mime_type, size_bytes, scan_status, scanned_at)
     select $1::uuid, 'quota-fill.pdf', $1::text || '/quota-fill-' || g, 'application/pdf', $2, 'clean', now()
       from generate_series(1, $3) g`,
    [fx.orgA.id, MAX_DOC, full],
  );
  await pool.query(
    `insert into public.documents
       (organisation_id, filename, storage_key, mime_type, size_bytes, scan_status, scanned_at)
     values ($1::uuid, 'quota-rest.pdf', $1::text || '/quota-rest', 'application/pdf', $2, 'clean', now())`,
    [fx.orgA.id, FIVE_GIB - full * MAX_DOC],
  );
}, 120_000);

afterAll(async () => {
  if (pool && fx) {
    const { rows } = await pool.query<{ name: string }>(
      `select name from storage.objects where bucket_id = 'documents' and name like $1 || '/%'`,
      [fx.orgA.id],
    );
    if (rows.length > 0) {
      const status = getLocalSupabaseStatus();
      const admin = createSupabaseClient(status.apiUrl, status.serviceRoleKey, {
        auth: { persistSession: false },
      });
      await admin.storage.from("documents").remove(rows.map((r) => r.name));
    }
    await pool.query(
      `delete from public.rate_limit_counters where category = 'uploads' and subject_id = $1`,
      [fx.activeByRole.manager.userId],
    );
  }
  if (fx) await destroyFixtures(fx);
});

describe("an upload past the plan's storage is refused (G36)", () => {
  it("DENOMINATOR: the workspace is on Starter and holds exactly 5 GiB, with no stored objects", async () => {
    const { rows } = await pool.query<{ gb: number }>(
      `select storage_limit_gb as gb from private.effective_organisation_plan($1)`,
      [fx.orgA.id],
    );
    expect(rows[0]?.gb).toBe(5);
    expect(await usedBytes()).toBe(FIVE_GIB);
    expect(await objects()).toBe(0);
  });

  it("the upload is refused with the quota sentence, and leaves no row and no object", async () => {
    const result = await upload("over-quota.pdf");
    expect(result.error).toBe(STORAGE_QUOTA_MESSAGE);
    expect(await rowsNamed("over-quota.pdf")).toBe(0);
    expect(await objects()).toBe(0);
    expect(await usedBytes()).toBe(FIVE_GIB);
  }, 60_000);

  it("POSITIVE CONTROL: with one plant gone, the same upload lands", async () => {
    await pool.query(
      `delete from public.documents where organisation_id = $1::uuid and storage_key = $1::text || '/quota-fill-1'`,
      [fx.orgA.id],
    );
    const result = await upload("under-quota.pdf");
    expect(result.error).toBeUndefined();
    expect(await rowsNamed("under-quota.pdf")).toBe(1);
    expect(await objects()).toBe(1);
  }, 60_000);
});

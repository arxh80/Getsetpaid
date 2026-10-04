// Q113 (founder 2026-09-30): document uploads are limited to 10 per hour PER
// USER, enforced AT THE WRITE -- the 11th is refused BEFORE ANY BYTE REACHES
// STORAGE.
//
// Drives the real `uploadDocumentAction` against the real local stack (the
// same harness as upload-scan-download.test.ts: only the Next request-context
// seams are mocked; the database, the limiter RPC and Storage are real). Ten
// clean uploads by one fresh Manager land; the eleventh is refused with the
// house "Try again in …" sentence, and NOTHING of it was stored -- counted in
// three places, each with a denominator from the ten that did land:
//   * `public.documents` rows for this user (10, not 11),
//   * `storage.objects` in the `documents` bucket under this org (10, not 11),
//   * no row and no object carrying the eleventh's filename.
// The limiter's own counter is read too (11: a refused request is counted,
// 20260909020000's header), which proves the eleventh reached the meter rather
// than being refused by something earlier.
//
// SWITCHING WORKSPACE DOES NOT RESET THE BUDGET (Task 9a fix round 1, review
// m5): the same Manager is also an active member of org B, and a twelfth
// upload into org B -- after ten in org A and the refused eleventh -- is
// refused just the same, with nothing stored under org B either. The meter
// is keyed to auth.uid(), not to the workspace the upload names. The
// denominator is the active org-B membership and an empty org B; the refusal
// is matched on the limiter's own sentence, so a permission refusal (a
// different sentence) cannot pass for it.
//
// MUTATIONS (task-9a-report.md, job 4): removing the consume, or moving it
// after the storage write, turns this file red -- the second only on the
// storage and row counts, which is why they are asserted separately from the
// message.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";
import { getLocalSupabaseStatus } from "../rls/support/env";

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

const CLEAN_PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");
const ELEVENTH = "eleventh-upload.pdf";

let fx: RlsFixtures;
let pool: Pool;

async function upload(name: string, slug: string = fx.orgA.slug) {
  const fd = new FormData();
  fd.append("file", new File([CLEAN_PDF as unknown as BlobPart], name, { type: "application/pdf" }));
  return uploadDocumentAction(slug, fd);
}

async function rowsForUser(): Promise<string[]> {
  const { rows } = await pool.query<{ filename: string }>(
    `select filename from public.documents
      where organisation_id = $1 and owner_user_id = $2 order by filename`,
    [fx.orgA.id, current.userId],
  );
  return rows.map((r) => r.filename);
}

async function objectsUnderOrg(orgId: string = fx.orgA.id): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from storage.objects
      where bucket_id = 'documents' and name like $1 || '/%'`,
    [orgId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function uploadCounter(): Promise<number> {
  const { rows } = await pool.query<{ n: string | null }>(
    `select sum(request_count)::text as n from public.rate_limit_counters
      where category = 'uploads' and subject_id = $1`,
    [current.userId],
  );
  return Number(rows[0]?.n ?? 0);
}

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

  // The same Manager, also an active member of org B (review m5). Removed
  // with org B by destroyFixtures (the membership cascades).
  await pool.query(
    `insert into public.organisation_memberships
       (organisation_id, user_id, role, status, joined_at)
     values ($1, $2, 'manager', 'active', now())`,
    [fx.orgB.id, current.userId],
  );
  current.orgs.set(fx.orgB.slug, {
    id: fx.orgB.id,
    name: fx.orgB.slug,
    slug: fx.orgB.slug,
    role: "manager",
    isSuspended: false,
  });
}, 120_000);

afterAll(async () => {
  if (pool && fx) {
    // The stored objects are this run's own; remove them so the bucket is
    // not left with test bytes the retention sweep would have to find.
    const { rows } = await pool.query<{ name: string }>(
      `select name from storage.objects where bucket_id = 'documents'
          and (name like $1 || '/%' or name like $2 || '/%')`,
      [fx.orgA.id, fx.orgB.id],
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

describe("document uploads are limited to 10 per hour per user (Q113)", () => {
  it("DENOMINATOR: the limit really is 10 an hour per user, and this user starts at zero", async () => {
    const { rows } = await pool.query<{ v: string }>(
      `select max_requests || '/' || window_seconds || '/' || subject_scope as v
         from public.rate_limit_policies where category = 'uploads'`,
    );
    expect(rows[0]?.v).toBe("10/3600/user");
    expect(await rowsForUser()).toEqual([]);
    expect(await objectsUnderOrg()).toBe(0);
    expect(await uploadCounter()).toBe(0);
  });

  it("ten uploads land, each a row AND a stored object", async () => {
    for (let i = 1; i <= 10; i++) {
      const name = `upload-${String(i).padStart(2, "0")}.pdf`;
      const result = await upload(name);
      expect(result.error, `upload ${i}`).toBeUndefined();
      expect(result.message, `upload ${i}`).toBe("Uploaded.");
    }
    expect(await rowsForUser()).toHaveLength(10);
    expect(await objectsUnderOrg()).toBe(10);
    expect(await uploadCounter()).toBe(10);
  }, 120_000);

  it("the ELEVENTH is refused in words, and nothing of it was stored", async () => {
    const result = await upload(ELEVENTH);
    expect(result.message).toBeUndefined();
    expect(result.error).toMatch(
      /^You’ve reached the upload limit for now — nothing is wrong\. Try again in \d+ (minutes|seconds)\.$/,
    );
    // It reached the meter (counted, though refused) ...
    expect(await uploadCounter()).toBe(11);
    // ... and stopped there: no row, no object.
    const names = await rowsForUser();
    expect(names).toHaveLength(10);
    expect(names).not.toContain(ELEVENTH);
    expect(await objectsUnderOrg()).toBe(10);
  });

  it("a TWELFTH upload, into the user's OTHER workspace, is refused too -- switching org does not reset the budget", async () => {
    // DENOMINATOR: the user really is an active member of org B, and org B
    // holds nothing yet -- so a refusal below is the meter, not a missing
    // membership or a pre-existing object.
    const { rows } = await pool.query<{ v: string }>(
      `select role || '/' || status as v from public.organisation_memberships
        where organisation_id = $1 and user_id = $2`,
      [fx.orgB.id, current.userId],
    );
    expect(rows[0]?.v).toBe("manager/active");
    expect(await objectsUnderOrg(fx.orgB.id)).toBe(0);

    const result = await upload("twelfth-in-org-b.pdf", fx.orgB.slug);
    expect(result.message).toBeUndefined();
    expect(result.error).toMatch(
      /^You’ve reached the upload limit for now — nothing is wrong\. Try again in \d+ (minutes|seconds)\.$/,
    );
    expect(await uploadCounter()).toBe(12);
    expect(await objectsUnderOrg(fx.orgB.id)).toBe(0);
    const { rows: inB } = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.documents where organisation_id = $1`,
      [fx.orgB.id],
    );
    expect(inB[0]?.n).toBe("0");
  });
});

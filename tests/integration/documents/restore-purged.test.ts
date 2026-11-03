// Q185 (founder 2026-09-30): a document whose file the retention job purged
// CANNOT BE RESTORED -- refused by the SERVER, not merely hidden on the page.
//
// Drives the real `restoreDocumentAction` against the real local stack as a
// real Manager session (the same harness as upload-scan-download.test.ts:
// only the Next request-context seams are mocked). Two rows, both planted as
// `postgres` because no client role can stamp `bytes_purged_at` (RK7/RK18 --
// it is the sweep's column):
//   * PURGED  -- deleted three years ago, bytes purged: the restore must refuse
//                IN WORDS that name the retention policy and the UK date, and
//                the row must be unchanged;
//   * CONTROL -- deleted, NOT purged: the same action restores it. Without
//                this, an action that refused everything would pass.
//
// THE LAYERS (mutation-tested; task-9a-report.md, job 4): the action's own
// purge read gives the sentence asserted below; behind it the update's
// `bytes_purged_at is null` filter and the database's
// `documents_purged_implies_deleted` CHECK keep the row unchanged even when
// the read is removed -- which is why the row assertions are separate from the
// message assertion.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
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

import { restoreDocumentAction } from "@/lib/crm/documents";
import { formatDate } from "@/lib/format/date";

let fx: RlsFixtures;
let pool: Pool;
const purgedId = crypto.randomUUID();
const controlId = crypto.randomUUID();
// A fixed instant, so the UK date in the sentence is known: 23:30 UTC on
// 14 June is 00:30 on the 15th in London (BST). A formatter that rendered the
// UTC day would say 14 Jun and fail.
const PURGED_AT = "2026-06-14T23:30:00Z";

async function rowState(id: string): Promise<string> {
  const { rows } = await pool.query<{ s: string }>(
    `select (deleted_at is not null)::text || '/' || (bytes_purged_at is not null)::text as s
       from public.documents where id = $1`,
    [id],
  );
  return rows[0]?.s ?? "missing";
}

function restoreForm(documentId: string): FormData {
  const fd = new FormData();
  fd.append("orgSlug", fx.orgA.slug);
  fd.append("documentId", documentId);
  return fd;
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

  const owner = fx.activeByRole.manager.userId;
  await pool.query(
    `insert into public.documents
       (id, organisation_id, owner_user_id, filename, storage_key, mime_type,
        size_bytes, scan_status, scanned_at, deleted_at, bytes_purged_at)
     values ($1::uuid, $3::uuid, $4::uuid, 'purged.pdf', $5, 'application/pdf', 10,
             'clean', now(), now() - interval '3 years', $7::timestamptz),
            ($2::uuid, $3::uuid, $4::uuid, 'control.pdf', $6, 'application/pdf', 10,
             'clean', now(), now() - interval '1 day', null)`,
    [
      purgedId,
      controlId,
      fx.orgA.id,
      owner,
      `${fx.orgA.id}/${purgedId}`,
      `${fx.orgA.id}/${controlId}`,
      PURGED_AT,
    ],
  );
}, 120_000);

afterAll(async () => {
  if (pool) {
    await pool.query(`delete from public.documents where id = any($1::uuid[])`, [
      [purgedId, controlId],
    ]);
  }
  if (fx) await destroyFixtures(fx);
});

describe("restoreDocumentAction refuses a document the retention policy purged (Q185)", () => {
  it("DENOMINATOR: both rows are deleted, exactly one purged, and the Manager can see both", async () => {
    expect(await rowState(purgedId)).toBe("true/true");
    expect(await rowState(controlId)).toBe("true/false");
    const { data, error } = await fx.activeByRole.manager.client
      .from("documents")
      .select("id")
      .in("id", [purgedId, controlId]);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(2);
  });

  it("refuses the purged one in words naming the policy and the UK date, and changes nothing", async () => {
    const state = await restoreDocumentAction({}, restoreForm(purgedId));
    expect(state.message).toBeUndefined();
    expect(formatDate(PURGED_AT)).toBe("15 Jun 2026");
    expect(state.error).toBe(
      "This file was deleted under the retention policy on 15 Jun 2026, so it can’t be restored.",
    );
    expect(await rowState(purgedId)).toBe("true/true");
  });

  it("CONTROL: the same action restores a deleted document that was NOT purged", async () => {
    const state = await restoreDocumentAction({}, restoreForm(controlId));
    expect(state.error).toBeUndefined();
    expect(state.message).toBe("Restored. It is back in the documents list.");
    expect(await rowState(controlId)).toBe("false/false");
  });
});

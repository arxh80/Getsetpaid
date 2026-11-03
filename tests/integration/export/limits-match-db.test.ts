// The export bounds live in ONE declared place — private.export_limits() —
// and lib/export/contract.ts mirrors them so the two pages can say how long
// an archive is kept without a round trip.
//
// A MIRROR IS A DRIFT WAITING TO HAPPEN, so this binds them. Note which
// direction the drift would hurt: the RUNNER asks the database
// (public.export_limits_for_runner), so a stale constant changes what a page
// SAYS and never what a job DOES. That is why there is a binding test rather
// than a second enforcement point.

import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { EXPORT_BUCKET, EXPORT_LIMITS, exportStorageKey } from "@/lib/export/contract";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl, max: 2 });

afterAll(async () => {
  await pool.end();
});

describe("the export limits agree with the database", () => {
  it("every number in lib/export/contract.ts is private.export_limits()'s", async () => {
    const { rows } = await pool.query<{
      page_size: number;
      max_rows_per_table: string;
      max_total_rows: string;
      max_archive_bytes: string;
      archive_days: number;
    }>("select * from private.export_limits()");
    const row = rows[0];
    expect(row, "private.export_limits() returned no row").toBeDefined();
    expect(row.page_size).toBe(EXPORT_LIMITS.pageSize);
    expect(Number(row.max_rows_per_table)).toBe(EXPORT_LIMITS.maxRowsPerTable);
    expect(Number(row.max_total_rows)).toBe(EXPORT_LIMITS.maxTotalRows);
    expect(Number(row.max_archive_bytes)).toBe(EXPORT_LIMITS.maxArchiveBytes);
    expect(row.archive_days).toBe(EXPORT_LIMITS.archiveDays);
  });

  it("the archive ceiling is BELOW the bucket's own file size limit", async () => {
    // So an over-large job fails with its own recorded reason rather than
    // with a storage refusal nobody can read.
    const { rows } = await pool.query<{ file_size_limit: string; public: boolean }>(
      "select file_size_limit, public from storage.buckets where id = $1",
      [EXPORT_BUCKET],
    );
    expect(rows[0], "the exports bucket does not exist").toBeDefined();
    expect(rows[0].public, "the exports bucket is PUBLIC").toBe(false);
    expect(EXPORT_LIMITS.maxArchiveBytes).toBeLessThan(Number(rows[0].file_size_limit));
  });

  it("the key TypeScript builds is the shape the CHECK constraint enforces", async () => {
    const jobId = "11111111-2222-3333-4444-555555555555";
    const key = exportStorageKey(jobId);
    const { rows } = await pool.query<{ ok: boolean }>(
      // The CHECK's own expression, asked directly rather than inferred from
      // an insert that a trigger might have rewritten.
      "select ($1 = 'exports/' || $2::uuid::text || '.zip') as ok",
      [key, jobId],
    );
    expect(rows[0]?.ok).toBe(true);
  });

  it("the four deny-all client fences name the exports bucket", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n
         from pg_policy p join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'storage' and c.relname = 'objects'
          and p.polpermissive = false
          and p.polname like 'exports_deny_client_%'`,
    );
    expect(rows[0]?.n).toBe("4");
  });
});

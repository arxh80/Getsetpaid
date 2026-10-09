// THE PAGE'S "WHAT IT LEAVES OUT" SENTENCE AND THE MANIFEST'S ARE ONE LIST.
//
// ===========================================================================
// WHY THIS EXISTS (Phase 8 Task 4 review, finding M8)
// ===========================================================================
// `private.export_catalogue()` excuses FIVE tables from the workspace export,
// and every one of them is named in the archive's own `manifest.json` with
// its full reason — the runner reads the excused rows straight out of
// `public.export_plan()`. The PAGE's sentence was written by hand and named
// three: the audit log, operational alerts and feedback. `export_jobs` and
// `data_subject_requests` were in the file and not on the page.
//
// So the archive was honest and the page was short, which is the quieter half
// of the same failure: a customer answering a data subject request routed to
// their workspace reads the page, not the manifest of an archive they have
// not built yet.
//
// `WORKSPACE_EXCLUDED_TABLES` is now the one roll the sentence is built from,
// and this binds it to the database. The binding is on the TABLE NAMES: the
// catalogue's reasons are written for an engineer reading a census and the
// page's phrases are the product's own voice, and forcing those to be the
// same string would make one of them worse.

import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { WORKSPACE_EXCLUDED_TABLES, WORKSPACE_EXPORT_EXCLUDES } from "@/lib/export/contract";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl, max: 2 });

afterAll(async () => {
  await pool.end();
});

async function excusedWorkspaceTables(): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    "select table_name from private.export_catalogue() where export_kind = 'workspace' and disposition = 'excused' order by table_name",
  );
  return rows.map((r) => r.table_name);
}

describe("the workspace page names every table the archive excuses", () => {
  it("the page's roll is exactly the catalogue's excused rows", async () => {
    const excused = await excusedWorkspaceTables();
    expect(excused.length, "the catalogue excuses nothing — this test would be vacuous").toBeGreaterThan(0);
    expect(
      [...WORKSPACE_EXCLUDED_TABLES.map((t) => t.table)].sort(),
      "the workspace export page's 'what it leaves out' sentence and private.export_catalogue() disagree. Every excused table is named in manifest.json with its reason; a table named there and not on the page is an archive that is honest and a page that is short.",
    ).toEqual(excused);
  });

  it("every phrase on the page is real English, and all of them are in the sentence", () => {
    for (const { table, plainEnglish } of WORKSPACE_EXCLUDED_TABLES) {
      expect(plainEnglish.length, `${table} has no plain-English phrase`).toBeGreaterThan(8);
      expect(
        WORKSPACE_EXPORT_EXCLUDES,
        `${table}'s phrase is declared and does not reach the rendered sentence`,
      ).toContain(plainEnglish);
    }
    // And the sentence still reads as one sentence rather than a list with a
    // dangling comma — the join is the only mechanical part of it, so the
    // last phrase is preceded by "and" and the whole thing ends in a stop.
    // (The final phrase may itself contain a comma; the last one does.)
    expect(WORKSPACE_EXPORT_EXCLUDES).toMatch(/\.$/);
    expect(WORKSPACE_EXPORT_EXCLUDES).toContain(
      ` and ${WORKSPACE_EXCLUDED_TABLES[WORKSPACE_EXCLUDED_TABLES.length - 1].plainEnglish}.`,
    );
    expect(WORKSPACE_EXPORT_EXCLUDES).not.toMatch(/,\s*\.$/);
  });

  it("the two the page used to be missing are the two that matter most", async () => {
    // Named rather than left to the roll comparison, because these two are
    // the finding: one is the register of exports (a customer asking "where
    // is the record of my last export" finds the answer on the page, live),
    // and the other is somebody else's statutory request, which is the one of
    // the five the reader is most likely to go looking for in the archive.
    const excused = await excusedWorkspaceTables();
    expect(excused).toContain("export_jobs");
    expect(excused).toContain("data_subject_requests");
    expect(WORKSPACE_EXCLUDED_TABLES.map((t) => t.table)).toContain("export_jobs");
    expect(WORKSPACE_EXCLUDED_TABLES.map((t) => t.table)).toContain("data_subject_requests");
    expect(WORKSPACE_EXPORT_EXCLUDES).toContain("data protection requests");
  });
});

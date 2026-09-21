import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateDraft } from "@/lib/legal/draft-validation";

// /legal/data-retention VERSION 6 -- THE HALF OF ITS CHECK THAT RUNS IN CI.
//
// Phase 8 Task 6's review (I3) found that version 5 had deleted "Automated
// deletion is still being built" and thereby turned two surviving sentences
// into live overclaims on a published, world-readable page: "Inactive account
// data: 2 years" (nothing sweeps it) and "When a period ends, the data is
// permanently deleted or anonymised" (false for every table the roll calls
// `retained_with_workspace`). Version 6 says plainly what is NOT deleted
// (Q183, recommended default, taken).
//
// The binding of the page's NUMBERS to `private.retention_periods()` needs a
// database and lives in supabase/tests/rls_phase8_retention.sql § RL. What can
// be asked of the migration FILE is asked here, because CI runs no stack and a
// page nobody can save is a page counsel cannot correct:
//
//   * the body passes the editor's own save-time validation;
//   * the sentences version 5 overclaimed with are gone, and the three plain
//     statements that replace them are present;
//   * every period the job applies is stated -- including the 90 days for a
//     FAILED account deletion, which the review named as missing;
//   * the migration publishes THE VERSION IT CREATED, by id (m4), and refuses
//     to run against any published version but the one it was written for.

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
const CR = String.fromCharCode(13);
const sql = readFileSync(
  `${MIGRATIONS}20261004006000_legal_retention_says_what_is_not_deleted.sql`,
  "utf8",
)
  .split(CR)
  .join("");

function body(): string {
  const match = /v_body\s+text := \$t\$([\s\S]*?)\$t\$;/.exec(sql);
  if (!match) throw new Error("20261004006000: no body found between $t$ markers");
  return match[1];
}

describe("/legal/data-retention version 6", () => {
  it("finds a body at all, so nothing below passes vacuously", () => {
    expect(body().length).toBeGreaterThan(3000);
    expect(body()).toContain("## What is not deleted automatically");
  });

  it("passes the editor's own save-time validation", () => {
    const result = validateDraft("data-retention", {
      title: "Data Retention Policy",
      body: body(),
      effectiveDate: "2026-10-04",
    });
    expect(result.ok ? {} : result.fieldErrors).toEqual({});
  });

  it("no longer promises that every period ends in deletion, or that the job is unbuilt", () => {
    expect(body()).not.toContain("When a period ends, the data is permanently deleted or anonymised");
    expect(body()).not.toContain("still being built");
    // The bare list item version 5 carried, which read as a deletion promise.
    expect(body()).not.toMatch(/^- \*\*Inactive account data:\*\* 2 years from last use\.$/m);
    expect(body()).not.toMatch(/^- \*\*Financial records\*\* \(event budgets and actuals\): 7 years\.$/m);
  });

  it("says plainly what is NOT deleted automatically", () => {
    const section = body().split("## What is not deleted automatically")[1].split("## A deleted account")[0];
    expect(section).toContain("**No period removes it after that.**");
    expect(section).toContain("**Nothing deletes them when the 7 years end.**");
    expect(section).toContain("**No automated process applies it today:**");
    // The inactive-account and financial-record lines live HERE now, not in
    // the list of what is deleted.
    expect(section).toContain("**Inactive account data:**");
    expect(section).toContain("**Financial records**");
  });

  it("states every period the job applies, including the ones version 5 left out", () => {
    const section = body().split("## What is deleted automatically, and when")[1].split("## What is not deleted automatically")[0];
    for (const fragment of [
      "2 years after the document was deleted",
      "or 7 years if the document is attached to an event that carries financial entries",
      "2 years from submission",
      "searchable by our operator for 30 days",
      "kept for up to 1 year in total",
      "60 days from suspension or closure",
      "7 days from when the file is ready",
      "1 year after the alert was resolved",
      // The review named this omission: a row that names a person and says
      // why their statutory deletion did not happen.
      "90 days after it failed",
      "7 days after that window closed",
      "did not complete): 1 day.",
      "for more than 1 hour is marked as failed",
    ]) {
      expect(section, fragment).toContain(fragment);
    }
  });

  it("says the job deletes NOTHING when it cannot safely run (review finding C2, now true)", () => {
    expect(body()).toContain("**If the job cannot safely run, it deletes nothing.**");
    expect(body()).toContain("our operator is alerted");
  });

  it("m4: publishes the version it created BY ID, never every draft of the slug", () => {
    expect(sql).toMatch(/set status = 'published', published_at = now\(\)\s+where d\.id = v_new_id;/);
    expect(sql).not.toMatch(/where d\.status = 'draft'/);
    // ...and refuses to run against a page that has moved on.
    expect(sql).toMatch(/if v_current\.version <> 5 then\s+raise exception/);
  });

  it("commits no email address and records no counsel review", () => {
    expect(sql).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(sql).not.toMatch(/set\s+counsel_review|counsel_reviewer\s*=|counsel_review_recorded_by\s*=/);
  });
});

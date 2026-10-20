import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docs/threat-model.md (G19, Phase 10 Task 2) names, per threat, the test that
// proves its control. A threat model that cites a deleted or renamed test is
// worse than none: it reads as covered. So every cited test path must exist,
// and every flow PRD § 10.8 names must keep its section.

const ROOT = new URL("../../../", import.meta.url);
const doc = readFileSync(fileURLToPath(new URL("docs/threat-model.md", ROOT)), "utf8");

const FLOWS = [
  "Authentication",
  "Multi-tenancy",
  "Network sharing",
  "Files",
  "Exports",
  "Finance",
  "Email",
  "Admin",
];

/** Every backticked path under tests/ or supabase/tests/. */
function citedTestPaths(markdown: string): string[] {
  return [...markdown.matchAll(/`((?:supabase\/)?tests\/[^`\s]+)`/g)].map((m) => m[1]);
}

describe("docs/threat-model.md", () => {
  it.each(FLOWS.map((flow, i) => [i + 1, flow] as const))(
    "has section %i, %s, with a STRIDE table",
    (n, flow) => {
      const start = doc.indexOf(`\n## ${n}. ${flow}\n`);
      expect(start, `no "## ${n}. ${flow}" heading`).toBeGreaterThanOrEqual(0);
      const next = doc.indexOf("\n## ", start + 1);
      const section = doc.slice(start, next === -1 ? undefined : next);
      expect(section).toContain("| STRIDE | Threat | Control | Proved by | Residual |");
    },
  );

  it("cites tests (non-vacuity: the extractor finds them)", () => {
    expect(citedTestPaths(doc).length).toBeGreaterThanOrEqual(60);
    expect(citedTestPaths("see `tests/unit/x.test.ts` and `supabase/tests/y.sql`")).toEqual([
      "tests/unit/x.test.ts",
      "supabase/tests/y.sql",
    ]);
  });

  it("every cited test exists on disk", () => {
    const missing = [...new Set(citedTestPaths(doc))].filter(
      (p) => !existsSync(fileURLToPath(new URL(p, ROOT))),
    );
    expect(missing).toEqual([]);
  });
});

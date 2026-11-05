import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ===========================================================================
// THE CI WORKFLOW RUNS EVERY GATE (Phase 10 Task 9: G1, G23, G24)
// ===========================================================================
// SECURITY.md § 11 rule 5: "A policy is verified by a test that runs in CI,
// every time." This pins that ci.yml still runs the three heavy suites, the
// licence scan and SAST, on pull requests and pushes to main, with every
// action pinned to a commit SHA. Read line by line (no YAML dependency): the
// workflow's shape is simple and this file is its only parser.
// ===========================================================================

const src = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");
const lines = src.split("\n");

/** Each top-level job's own lines, keyed by job id. */
function jobs(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const start = lines.findIndex((l) => l === "jobs:");
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    const id = line.match(/^ {2}([a-z][a-z0-9_-]*):\s*$/)?.[1];
    if (id) out[(current = id)] = [];
    else if (/^\S/.test(line)) break;
    else if (current) out[current].push(line);
  }
  return out;
}

const runs = (job: string[]) =>
  job.join("\n").match(/run: [|>]?[^\n]*(?:\n {10,}[^\n]*)*/g)?.join("\n") ?? "";

describe(".github/workflows/ci.yml", () => {
  const all = jobs();

  it("has the five jobs (gates, scan and the three stack suites)", () => {
    expect(Object.keys(all).sort()).toEqual(["e2e", "gates", "integration", "psql", "scan"]);
  });

  it("runs on pull requests and on pushes to main", () => {
    const on = src.slice(src.indexOf("\non:\n"), src.indexOf("\njobs:\n"));
    expect(on).toMatch(/\n {2}pull_request:/);
    expect(on).toMatch(/\n {2}push:\n {4}branches: \[main\]/);
  });

  it("the heavy three run the psql runner, the integration suite and Playwright", () => {
    expect(runs(all.psql)).toContain("bash supabase/tests/run-rls-tests.sh");
    expect(runs(all.integration)).toContain("pnpm exec vitest run tests/integration");
    expect(runs(all.e2e)).toMatch(/pnpm test:e2e|npx playwright test/);
  });

  it("the scan job runs the licence check and Semgrep, version-pinned", () => {
    const scan = runs(all.scan);
    expect(scan).toContain("pnpm licenses list --prod --json | node scripts/check-licenses.mjs");
    expect(scan).toMatch(/pip install --quiet semgrep==\d+\.\d+\.\d+/);
    expect(scan).toMatch(/semgrep scan --error/);
  });

  it("every `uses:` is pinned to a 40-hex commit SHA with a version trailer", () => {
    const uses = lines.filter((l) => /^\s*(- )?uses: /.test(l));
    expect(uses.length).toBeGreaterThan(10);
    for (const l of uses) expect(l, l.trim()).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_UP_PURPOSES } from "@/lib/auth/step-up-purposes";

// ===========================================================================
// EVERY checkStepUp() CALLER MINTS THE DATABASE'S TOKEN (Phase 10 Task 6, G13)
// ===========================================================================
// Step-up is enforced in the database now: every gated RPC and the
// export_jobs / erasure_jobs inserts consume a single-use token that only the
// server can mint (20261108001000). A server action that checks step-up but
// forgets to mint is refused by the database on every press -- and an action
// that MINTS without checking step-up is a bypass. So every checkStepUp() call
// in the app must be written as one expression with the mint, with a purpose
// from the closed list:
//
//   !(await checkStepUp()) || !(await mintStepUpToken("override"))
//   (await checkStepUp()) && (await mintStepUpToken("retention_settings"))
//
// A call without the mint is red unless it is declared below with its reason.
// ===========================================================================

const ROOT = process.cwd();
const SCANNED = ["lib", "app", "components"];
const DEFINITION = "lib/auth/step-up-gate.ts";

/** checkStepUp() calls that are NOT a gated write, each with why. */
const UNMINTED: Record<string, { readonly count: number; readonly why: string }> = {
  "components/auth/step-up-gate.tsx": {
    count: 1,
    why: "decides whether to RENDER the re-auth prompt; writes nothing",
  },
  "lib/admin/retention-actions.ts": {
    count: 1,
    why: "previewRetentionRunAction's dry run: its only write is the runner's own service-role call, with no PostgREST path to gate",
  },
};

const PAIRED =
  /checkStepUp\([^)]*\)\)\s*(?:\|\|\s*!|&&\s*)\(await mintStepUpToken\("([a-z_]+)"\)\)/g;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The census of one file's source. */
function census(src: string) {
  const code = stripComments(src);
  const calls = (code.match(/\bcheckStepUp\([^)]*\)/g) ?? []).length;
  // A raw .rpc("mint_step_up_token") outside the helper is a mint too, and never pairs.
  const mints = (code.match(/\bmintStepUpToken\(|\bmint_step_up_token\b/g) ?? []).length;
  const purposes = [...code.matchAll(PAIRED)].map((m) => m[1]);
  return { calls, mints, purposes };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = SCANNED.flatMap((d) => sourceFiles(join(ROOT, d)))
  .map((p) => relative(ROOT, p).replace(/\\/g, "/"))
  .filter((p) => p !== DEFINITION)
  .map((p) => ({ path: p, ...census(readFileSync(join(ROOT, p), "utf8")) }))
  .filter((f) => f.calls > 0 || f.mints > 0);

describe("step-up token callers", () => {
  it("finds the gated actions at all (non-vacuity)", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)("$path: every checkStepUp() mints, unless declared", (f) => {
    expect(f.calls - f.purposes.length).toBe(UNMINTED[f.path]?.count ?? 0);
  });

  it.each(files)("$path: every mint is paired with checkStepUp(), and names a listed purpose", (f) => {
    expect(f.mints).toBe(f.purposes.length);
    for (const p of f.purposes) expect(STEP_UP_PURPOSES).toContain(p);
  });

  it("every declared exemption still exists (a stale entry hides nothing)", () => {
    for (const [path, { count }] of Object.entries(UNMINTED)) {
      const f = files.find((x) => x.path === path);
      expect(f && f.calls - f.purposes.length, path).toBe(count);
    }
  });

  it("every purpose is minted by some action (none is dead)", () => {
    const minted = new Set(files.flatMap((f) => f.purposes));
    expect([...minted].sort()).toEqual([...STEP_UP_PURPOSES].sort());
  });

  it("the TypeScript list is the migration's CHECK, exactly", () => {
    const sql = readFileSync(
      join(ROOT, "supabase/migrations/20261108001000_step_up_tokens.sql"),
      "utf8",
    );
    const check = sql.match(/check \(purpose in \(([^)]*)\)\)/);
    expect(check).not.toBeNull();
    const listed = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...STEP_UP_PURPOSES].sort());
  });

  it("the census sees a forgotten mint and a bare mint (its own denominator)", () => {
    expect(census(`if (!(await checkStepUp())) return refuse();`)).toEqual({
      calls: 1,
      mints: 0,
      purposes: [],
    });
    expect(census(`await mintStepUpToken("override"); await rpc();`)).toEqual({
      calls: 0,
      mints: 1,
      purposes: [],
    });
    expect(
      census(`if (!(await checkStepUp()) || !(await mintStepUpToken("override"))) {}`),
    ).toEqual({ calls: 1, mints: 1, purposes: ["override"] });
    expect(census(`await supabase.rpc("mint_step_up_token", { p_purpose: "override" });`)).toEqual({
      calls: 0,
      mints: 1,
      purposes: [],
    });
    expect(
      census(`if (!(await checkStepUp(claims)) || !(await mintStepUpToken("override"))) {}`),
    ).toEqual({ calls: 1, mints: 1, purposes: ["override"] });
    expect(census(`if (!(await checkStepUp(claims))) return refuse();`)).toEqual({
      calls: 1,
      mints: 0,
      purposes: [],
    });
  });
});

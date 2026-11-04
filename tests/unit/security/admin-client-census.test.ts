import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  appSourceFiles,
  moduleReferences,
  namesModule,
  parse,
  parseProblems,
  REPO_ROOT,
  relPath,
  resolveSpecifier,
} from "../support/app-source";

// ===========================================================================
// PHASE 10 TASK 13 (G27) -- THE GOTRUE ADMIN CLIENT'S IMPORTERS
// ===========================================================================
// lib/supabase/admin.ts is the third service-role client: the GoTrue Admin
// API (create, invite, update and delete users). Its siblings each have a
// census (tests/unit/email/service-client-census.test.ts for service.ts,
// storage-client-census.test.ts for storage.ts); this is its own, the same
// detector over the same walk. A new importer is a new place that can change
// any user's account, so it lands red until it is named here with a reason.
//
// Its header also promises the client is used for `.auth.admin.*` only and
// never grows a `.from(...)` call; the second test holds the file to that.

const ADMIN_CLIENT = "lib/supabase/admin.ts";

const ALLOWED = new Map([
  ["lib/org/actions.ts", "Phase 2: inviting a member creates or invites the auth user (adminAuthFetch, hard-scoped to /auth/v1)"],
  ["lib/auth/first-proof.ts", "Phase 10 Task 20: the auth callback settles an address's first proof (updateUserById)"],
]);

/** Whether `file`'s source imports the admin client, by any route moduleReferences() follows. */
export function importsAdminClient(file: string, text: string): boolean {
  return moduleReferences(parse(file, text)).some((r) =>
    namesModule(r.specifier === null ? null : resolveSpecifier(file, r.specifier), ADMIN_CLIENT),
  );
}

/** Lines of every `<expr>.from(...)` call in the source (comments and strings are not calls). */
export function fromCalls(file: string, text: string): number[] {
  const sf = parse(file, text);
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "from") {
      lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

describe("lib/supabase/admin.ts has exactly the importers this census names (G27)", () => {
  const scanned = appSourceFiles().map((full) => {
    const file = relPath(full);
    const text = readFileSync(full, "utf8");
    return { file, problems: parseProblems(parse(file, text)), imports: importsAdminClient(file, text) };
  });
  const importers = scanned.filter((s) => s.imports && s.file !== ADMIN_CLIENT).map((s) => s.file).sort();

  it("DENOMINATOR: the walk is the whole repository and every file parsed", () => {
    expect(scanned.length).toBeGreaterThan(400);
    expect(scanned.filter((s) => s.problems.length > 0).map((s) => s.file)).toEqual([]);
    expect(scanned.map((s) => s.file)).toContain(ADMIN_CLIENT);
  });

  it("the importers are exactly the named ones", () => {
    expect(
      importers,
      "a file imports the GoTrue Admin client, which can create, change and delete any user. " +
        "Name it in ALLOWED with the reason, or do the work through an existing path.",
    ).toEqual([...ALLOWED.keys()].sort());
  });

  it("and admin.ts itself makes no `.from(...)` call", () => {
    expect(fromCalls(ADMIN_CLIENT, readFileSync(`${REPO_ROOT}/${ADMIN_CLIENT}`, "utf8"))).toEqual([]);
  });
});

describe("the admin-client detector", () => {
  it("catches a planted importer, by alias, relative path and dynamic import", () => {
    expect(importsAdminClient("lib/x/a.ts", `import { createAdminClient } from "@/lib/supabase/admin";`)).toBe(true);
    expect(importsAdminClient("lib/supabase/b.ts", `import { createAdminClient } from "./admin";`)).toBe(true);
    expect(importsAdminClient("app/x/page.tsx", `const m = await import("@/lib/supabase/admin");`)).toBe(true);
  });

  it("and not a comment, or a module that shares the name", () => {
    expect(importsAdminClient("lib/x/a.ts", `// import { createAdminClient } from "@/lib/supabase/admin";`)).toBe(false);
    expect(importsAdminClient("lib/x/a.ts", `import x from "@/lib/admin";`)).toBe(false);
  });

  it("sees a `.from(` call but not one in a comment", () => {
    expect(fromCalls("lib/x/a.ts", `createAdminClient().from("profiles").select()`)).toEqual([1]);
    expect(fromCalls("lib/x/a.ts", `// never .from("profiles")`)).toEqual([]);
  });
});

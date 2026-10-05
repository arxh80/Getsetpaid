import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appSourceFiles,
  existingEntryPoints,
  moduleReferences,
  namesModule,
  parse,
  parseProblems,
  relPath,
  resolveSpecifier,
} from "../support/app-source";

// lib/supabase/service.ts is the service-role TABLE client, bounded by the
// column-narrow grants Task 5, Task 6 and Task 6c gave service_role. Its
// header promises ONE importer: lib/email/*. This is the source census that
// keeps a second importer from turning it into a general RLS bypass by drift.
//
// THREE SENDERS since Task 6c. lib/email/lockout-notification.ts (founder
// ruling Q114) reads public.pending_lockout_notifications() -- a SECURITY
// DEFINER function granted to service_role ALONE -- and stamps
// incident_alerts.account_notified_at, a second column-narrow grant. It was
// added here deliberately, after this census failed on it, which is the census
// working: the alternative it rejected was reaching for
// `auth.admin.getUserById()` to resolve the recipient's address, which would
// have widened the client to the whole GoTrue Admin API for one email field.

// CENSUS AUDIT (finding 5). The subject set was four hardcoded paths --
// `const SCAN = ["app", "components", "lib", "proxy.ts"]` -- and the match was
// a raw-text regex over the whole file. Four evasions, all measured below and
// all GREEN before this change, because the non-vacuity control still found
// the four legitimate importers:
//   * an importer in `middleware.ts`, `instrumentation.ts`, `next.config.ts`
//     or any new top-level directory: outside SCAN, never read;
//   * `from "@/lib/supabase/service.ts"` (the extension is legal under the
//     bundler resolver): the specifier regex is exact-string;
//   * `require("@/lib/supabase/service")`;
//   * an import whose specifier is a `const` declared in the same file.
// This matters out of proportion to its size: the subject is the key that
// BYPASSES RLS, and phase7-permission-matrix.test.ts:70-74 cites this census
// by name as the reason fifteen untested operator Server Actions are safe.
//
// The set is now `appSourceFiles()` (whole repo minus a NAMED exclusion list,
// so it grows by default) and the match is `moduleReferences()` +
// `namesModule()` -- the AST route, which follows a re-export, a dynamic
// `import()`, a `require()` and a constant specifier, and resolves `./`,
// `../` and `@/` the way the bundler does.

const SERVICE_CLIENT = "lib/supabase/service.ts";
const ALLOWED = new Set([
  "lib/email/feedback-notification.ts",
  "lib/email/incident-alerts.ts",
  "lib/email/lockout-notification.ts",
  // Phase 8 Task 9b job 2 (founder 2026-09-30, Q157(3)/Q174/Q45). The DSR,
  // export-ready and erasure-failure notices: two service_role-only resolver
  // RPCs, one service_role-only stamp RPC, `select id` on erasure_jobs and
  // the column-narrow stamp grants in 20261015000000 -- nothing wider.
  "lib/email/requester-notifications.ts",
  // Phase 8 Task 9b job 3 (same ruling). The connection-request and
  // task-reminder notices: two service_role-only resolver RPCs and one
  // service_role-only stamp RPC (20261016000000) -- no table at all.
  "lib/email/network-notifications.ts",
  "lib/email/task-reminder-notifications.ts",
  // Phase 8 Task 9c job 2b (founder 2026-09-30, Q176/Q178). The workspace-
  // closure and decision notices: two service_role-only resolver RPCs and the
  // same two ledger RPCs (20261022001000) -- no table at all.
  "lib/email/workspace-closure-notifications.ts",
  // Phase 8 Task 4. The export runner is the second kind of sessionless
  // caller this client exists for: it has no user, so no RLS policy can name
  // it, and its whole reach is the column-narrow grants in 20260927001000 § 7
  // and 20260927003000 § 1 plus four RPCs granted to service_role alone.
  "lib/export/runner.ts",
  // Phase 8 Task 5. The erasure runner, the third sessionless caller: it has
  // no user, so no RLS policy can name it, and its whole reach is the
  // column-narrow grants in 20260930001000 § 7 plus four RPCs granted to
  // service_role alone.
  "lib/erasure/runner.ts",
  // Phase 8 Task 6. The retention runner, the FOURTH sessionless caller and
  // the first that is not answering anybody's request: it has no user, so no
  // RLS policy can name it, and its whole reach is three RPCs granted to
  // service_role alone (start_retention_run, run_retention_sweep,
  // fail_retention_run) plus the object manifest. It writes no table
  // directly.
  "lib/retention/runner.ts",
]);

interface Scanned {
  file: string;
  problems: string[];
  imports: boolean;
}

export function analyse(file: string, text: string): Scanned {
  const sf = parse(file, text);
  const imports = moduleReferences(sf).some((r) =>
    namesModule(r.specifier === null ? null : resolveSpecifier(file, r.specifier), SERVICE_CLIENT),
  );
  return { file, problems: parseProblems(sf), imports };
}

describe("lib/supabase/service.ts has exactly the importers its header names", () => {
  const scanned = appSourceFiles().map((full) => analyse(relPath(full), readFileSync(full, "utf8")));
  const importers = scanned.filter((s) => s.imports && s.file !== SERVICE_CLIENT).map((s) => s.file);

  it("DENOMINATOR: the walk is the whole repository and every file parsed", () => {
    expect(scanned.length, "the app-source walk stopped seeing the repository").toBeGreaterThan(400);
    // What the walk THREW AWAY is asserted too: a file the parser recovered
    // from is scanned, found to import nothing, and counted.
    const broken = scanned.filter((s) => s.problems.length > 0).map((s) => `${s.file}: ${s.problems[0]}`);
    expect(broken, "these files were scanned for the import with syntax errors recovered from").toEqual([]);
    // The service client itself is in the set -- so the walk reaches the
    // module it is about -- and so are the root entry points SCAN never read.
    expect(scanned.map((s) => s.file)).toContain(SERVICE_CLIENT);
    for (const entry of existingEntryPoints()) expect(scanned.map((s) => s.file)).toContain(entry);
  });

  it("the census sees the known importers (non-vacuity)", () => {
    for (const allowed of ALLOWED) expect(importers).toContain(allowed);
  });

  it("and nothing else", () => {
    const extra = importers.filter((f) => !ALLOWED.has(f));
    expect(
      extra,
      `${extra.join(", ")} import the service-role table client -- only the senders and the four sessionless runners named above may; a new privileged table need is a SECURITY DEFINER function in a migration (lib/supabase/admin.ts's rule)`,
    ).toEqual([]);
  });
});

// ===========================================================================
// THE DETECTOR'S OWN CONTROLS -- the four measured evasions of the regex
// census this replaced. Each was green there and is red here.
// ===========================================================================
describe("the service-client detector", () => {
  const cases: [string, string, string][] = [
    ["a plain @/ import", "lib/x/a.ts", `import { serviceClient } from "@/lib/supabase/service";`],
    ["the same specifier with its extension", "lib/x/a.ts", `import { serviceClient } from "@/lib/supabase/service.ts";`],
    ["a require()", "lib/x/a.ts", `const { serviceClient } = require("@/lib/supabase/service");`],
    ["a dynamic import", "lib/x/a.ts", `const m = await import("@/lib/supabase/service");`],
    ["a re-export", "lib/x/index.ts", `export { serviceClient } from "../supabase/service";`],
    ["a relative import from a sibling", "lib/supabase/other.ts", `import x from "./service";`],
    ["a constant specifier", "lib/x/a.ts", `const P = "@/lib/supabase/service";
const m = await import(P);`],
    ["an importer at the repository root", "instrumentation.ts", `import { serviceClient } from "@/lib/supabase/service";`],
  ];

  it.each(cases)("catches %s", (_label, file, text) => {
    expect(analyse(file, text).imports).toBe(true);
  });

  it("and does not flag a module that merely shares the name", () => {
    expect(analyse("lib/sms/a.ts", `import x from "./service";`).imports).toBe(false);
    expect(analyse("lib/x/a.ts", `import x from "@/lib/supabase/server";`).imports).toBe(false);
    expect(analyse("lib/x/a.ts", `// import x from "@/lib/supabase/service";`).imports).toBe(false);
  });
});

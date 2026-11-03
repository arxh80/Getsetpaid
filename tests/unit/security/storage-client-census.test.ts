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

// ===========================================================================
// Q126 -- THE STORAGE-CLIENT CENSUS. OWED SINCE PHASE 7 AND BUILT HERE.
// ===========================================================================
//
// lib/supabase/storage.ts is the SERVICE-ROLE STORAGE CLIENT. Its own header
// says why it exists and what the envelope is -- `storage.objects` carries a
// restrictive deny-all fence for `authenticated` and `anon`, so the only
// principal that can touch a private bucket is `service_role`, which bypasses
// RLS -- and it promises that the client is used for `.storage` only, never
// for `.from(...)` table access.
//
// phase-8-inventory.md, "Test censuses Phase 8 will trip": "Q126:
// lib/supabase/storage.ts has NO service-client census; add one in the phase
// that next touches it (the GC job will)." Five importers accumulated in the
// meantime and each was a judgement call nothing checked. THIS TASK IS THE
// SIXTH, and the first whose reach includes DELETION ACROSS EVERY BUCKET --
// which is precisely the importer that should not have been able to arrive
// without a list saying so.
//
// It is lib/supabase/service.ts's census (tests/unit/email/
// service-client-census.test.ts), pointed at the sibling client, for the same
// reasons and with the same detector: the AST route through
// moduleReferences() + namesModule(), which follows a re-export, a dynamic
// import(), a require() and a constant specifier, over appSourceFiles() --
// the whole repository minus a named exclusion list, so the subject set grows
// by default rather than by remembering.
//
// ===========================================================================
// AND ONE CHECK THE SERVICE-CLIENT CENSUS DOES NOT MAKE
// ===========================================================================
// The storage client's header carries a promise its sibling's does not: "this
// client is used for `.storage` ONLY -- never `.from(...)` table access".
// `service_role` holds zero table privileges in this schema, so a `.from()`
// on this client would fail rather than escalate -- but it would fail at
// runtime, in a scheduled job nobody is watching, and the honest place to
// catch it is here. So every importer is also read for
// `createStorageClient().from(` and its two-step form.
//
// WHAT THIS CENSUS CANNOT SEE, stated rather than implied: a client
// constructed by calling createClient() with the service key directly,
// somewhere else. That is lib/supabase/env.ts's `supabaseSecretKey()`, and
// the file that would have to import it -- which is a different census and
// not this one. This one is about the shared factory not growing importers
// by drift.

const STORAGE_CLIENT = "lib/supabase/storage.ts";

const ALLOWED = new Set([
  // Phase 4. The documents pipeline: the server-mediated upload, and the
  // signed-URL download that is authorised and audited before a URL exists.
  "lib/crm/documents.ts",
  // Phase 7 Task 6. The feedback screenshot: the same pipeline pointed at a
  // second private bucket. TWO files, and the split is worth stating because
  // a reader expects one -- lib/feedback/actions.ts uploads the image inside
  // the submission, and lib/feedback/screenshot.ts signs the 60-second URL
  // for the audited superuser view of it.
  "lib/feedback/actions.ts",
  "lib/feedback/screenshot.ts",
  // Phase 8 Task 4. The export runner writes the archive; the download route
  // signs a URL for it after the audit row is written.
  "lib/export/runner.ts",
  "lib/export/download.ts",
  // Phase 8 Task 5. The erasure runner deletes a subject's stored objects
  // BEFORE the database transaction, because the database refuses to delete
  // the rows while any byte remains.
  "lib/erasure/runner.ts",
  // Phase 8 Task 6. THE SIXTH, and the first whose reach is deletion across
  // every bucket rather than one subject's keys. What bounds it is not this
  // file: public.retention_object_manifest() derives every key in the
  // database, so the runner deletes what Postgres named and can name nothing
  // itself.
  "lib/retention/runner.ts",
]);

interface Scanned {
  file: string;
  problems: string[];
  imports: boolean;
  tableAccess: boolean;
}

/** `createStorageClient().from(` and the two-step `const c = createStorageClient(); c.from(`.
 *  Deliberately a narrow, readable pair rather than a general alias analysis:
 *  the point is to catch the mistake, and a reviewer who can defeat this
 *  pattern has written something a census was never going to stop. */
//
// THE LOOKBEHIND IS LOAD-BEARING AND IT WAS MISSING ON THE FIRST RUN. Without
// `(?<![.\w])` the backreference matched the SECOND half of the legitimate
// `storage.storage.from("documents")` — which is the whole product's real
// usage — and this census reported lib/crm/documents.ts and
// lib/feedback/actions.ts as offenders on its very first execution. A
// detector that flags the correct code is as useless as one that flags
// nothing; the fixtures at the bottom pin both directions, so the next edit
// cannot re-break either.
const TABLE_ACCESS = [
  /createStorageClient\s*\(\s*\)\s*\.\s*from\s*\(/,
  /\bconst\s+(\w+)\s*=\s*createStorageClient\s*\(\s*\)\s*;[\s\S]*?(?<![.\w])\1\s*\.\s*from\s*\(/,
];

export function analyse(file: string, text: string): Scanned {
  const sf = parse(file, text);
  const imports = moduleReferences(sf).some((r) =>
    namesModule(r.specifier === null ? null : resolveSpecifier(file, r.specifier), STORAGE_CLIENT),
  );
  return {
    file,
    problems: parseProblems(sf),
    imports,
    tableAccess: TABLE_ACCESS.some((re) => re.test(text)),
  };
}

describe("lib/supabase/storage.ts has exactly the importers this census names (Q126)", () => {
  const scanned = appSourceFiles().map((full) => analyse(relPath(full), readFileSync(full, "utf8")));
  const importers = scanned.filter((s) => s.imports && s.file !== STORAGE_CLIENT).map((s) => s.file);

  it("DENOMINATOR: the walk is the whole repository and every file parsed", () => {
    expect(scanned.length, "the app-source walk stopped seeing the repository").toBeGreaterThan(400);
    const broken = scanned
      .filter((s) => s.problems.length > 0)
      .map((s) => `${s.file}: ${s.problems[0]}`);
    expect(broken, "these files were scanned with syntax errors recovered from").toEqual([]);
    expect(scanned.map((s) => s.file)).toContain(STORAGE_CLIENT);
    for (const entry of existingEntryPoints()) expect(scanned.map((s) => s.file)).toContain(entry);
  });

  it("the census sees every known importer (non-vacuity)", () => {
    // Without this the two assertions below would both pass on a census that
    // found NOTHING -- the invisible denominator this phase keeps measuring.
    for (const allowed of ALLOWED) expect(importers).toContain(allowed);
    expect(importers.length).toBeGreaterThanOrEqual(ALLOWED.size);
  });

  it("and nothing else", () => {
    const extra = importers.filter((f) => !ALLOWED.has(f));
    expect(
      extra,
      `${extra.join(", ")} import the service-role STORAGE client. It bypasses the restrictive deny-all fence on storage.objects, so a new importer is a new way to read or delete a private bucket: add it here with the reason, or reach the bucket through an existing pipeline`,
    ).toEqual([]);
  });

  it("and no importer uses it for table access, which its header forbids", () => {
    const offenders = scanned.filter((s) => s.tableAccess).map((s) => s.file);
    expect(
      offenders,
      `${offenders.join(", ")} call .from() on the storage client. service_role holds zero table privileges in this schema, so this fails at RUNTIME -- in a scheduled job nobody is watching. Privileged table work is a SECURITY DEFINER function in a migration`,
    ).toEqual([]);
  });
});

// ===========================================================================
// THE DETECTOR'S OWN CONTROLS. A census that cannot see its own subject is
// this phase's recurring bug, so both halves are exercised on fixtures.
// ===========================================================================
describe("the storage-client detector", () => {
  const importCases: [string, string, string][] = [
    ["a plain @/ import", "lib/x/a.ts", `import { createStorageClient } from "@/lib/supabase/storage";`],
    ["the same specifier with its extension", "lib/x/a.ts", `import { createStorageClient } from "@/lib/supabase/storage.ts";`],
    ["a require()", "lib/x/a.ts", `const { createStorageClient } = require("@/lib/supabase/storage");`],
    ["a dynamic import", "lib/x/a.ts", `const m = await import("@/lib/supabase/storage");`],
    ["a re-export", "lib/x/index.ts", `export { createStorageClient } from "../supabase/storage";`],
    ["a relative import from a sibling", "lib/supabase/other.ts", `import x from "./storage";`],
    [
      "a constant specifier",
      "lib/x/a.ts",
      `const P = "@/lib/supabase/storage";\nconst m = await import(P);`,
    ],
    ["an importer at the repository root", "instrumentation.ts", `import { createStorageClient } from "@/lib/supabase/storage";`],
  ];

  it.each(importCases)("catches %s", (_label, file, text) => {
    expect(analyse(file, text).imports).toBe(true);
  });

  it("and does not flag a module that merely shares the name", () => {
    expect(analyse("lib/files/a.ts", `import x from "./storage";`).imports).toBe(false);
    expect(analyse("lib/x/a.ts", `import x from "@/lib/supabase/server";`).imports).toBe(false);
    expect(analyse("lib/x/a.ts", `import x from "@/lib/supabase/service";`).imports).toBe(false);
    expect(analyse("lib/x/a.ts", `// import x from "@/lib/supabase/storage";`).imports).toBe(false);
  });

  it("catches table access in both shapes, and neither in the legitimate one", () => {
    expect(analyse("lib/x/a.ts", `createStorageClient().from("documents")`).tableAccess).toBe(true);
    expect(
      analyse("lib/x/a.ts", `const c = createStorageClient();\nawait c.from("documents").select()`)
        .tableAccess,
    ).toBe(true);
    expect(
      analyse("lib/x/a.ts", `createStorageClient().storage.from("documents").remove([k])`)
        .tableAccess,
    ).toBe(false);
  });
});

// THE REGRESSION FIXTURE for the lookbehind above: the product's real shape,
// which the first cut of this census called an offence.
describe("the table-access detector does not flag `.storage.from(...)`", () => {
  it("through the two-step form the whole product uses", () => {
    const real = `const storage = createStorageClient();
await storage.storage.from("documents").upload(key, bytes);`;
    expect(analyse("lib/crm/documents.ts", real).tableAccess).toBe(false);
  });
});

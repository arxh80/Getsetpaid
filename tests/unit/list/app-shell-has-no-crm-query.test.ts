import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

// THE MFA READ GATE'S UNSTATED PRECONDITION, made into an assertion.
//
// Routed here by FOLLOW-UPS.md § "Opened by Task 2":
//
//   "Task 3: no CRM query may appear above MfaEnrollGate. The MFA read gate is
//    safe only because app/(app)/layout.tsx reaches profiles, organisations and
//    organisation_memberships and nothing else -- verified end to end with a
//    real TOTP enrolment. The moment a CRM read appears in the app shell, the
//    MFA gate components or lib/auth, an un-enrolled privileged user can no
//    longer reach the enrolment screen. Worth a guard test in the shape of
//    rls_phase2_crm.sql H12/H13."
//
// WHY THIS IS A LOCKOUT AND NOT A GLITCH. Task 2 moved CRM READS behind
// `has_permission`, which returns false for Owner/Admin/Finance on a session
// that has not reached aal2. The app shell renders on every signed-in page,
// INCLUDING the enrolment screen. So a CRM read in the shell would return zero
// rows or an error for exactly the users who need the enrolment screen to
// render -- and there is no other route to enrol. The organisation's Owner
// would be locked out of their own product with no self-service fix.
//
// Task 3 is the first task to add a CRM query to the application at all, which
// is why the guard lands now. It is a SOURCE-LEVEL check, deliberately: the
// property is "this file never reaches that table", and that is a statement
// about the module graph, not about any one request.
//
// It walks real imports rather than grepping the whole repo, so it stays true
// as files move -- and so that a CRM query added to lib/auth or to an MFA gate
// component (both reachable from the shell, neither obviously "the layout")
// fails it too.

const ROOT = resolve(__dirname, "../../..");

/** The twelve Phase 2 CRM tables (20260828121000). */
const CRM_TABLES = [
  "companies",
  "contacts",
  "contact_companies",
  "agencies",
  "artists",
  "artist_representations",
  "artist_fee_history",
  "venues",
  "venue_rooms",
  "custom_field_definitions",
  "custom_field_values",
  "merges",
];

const EXTENSIONS = [".ts", ".tsx"];

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // a package, not our source

  for (const candidate of [
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => join(base, "index" + e)),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/** Every one of our own modules reachable from `entry`, including itself. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    // Import specifiers only. Deliberately not a real parser: a false positive
    // here costs a resolveImport() miss, and a false negative would need an
    // import written in a way nothing in this codebase uses.
    for (const m of source.matchAll(
      /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g,
    )) {
      const resolved = resolveImport(file, m[1]);
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen];
}

/**
 * Ways a file can reach a CRM table.
 *
 * THE SECOND AND THIRD FORMS ARE HERE BECAUSE THE POSITIVE CONTROL BELOW
 * FAILED WITHOUT THEM. The first version of this detector looked only for
 * `.from("contacts")`, which is how every query in the codebase was written
 * until this task -- and lib/list/query.ts takes the table name as a
 * PARAMETER, so it calls `supabase.from(table)` and the literal lives at the
 * call site as `table: "contacts"`. The detector therefore could not see the
 * only CRM query in the application, and would have passed just as happily on
 * an app shell that reached contacts through the same helper.
 *
 * That is the exact failure mode Task 2's fix round 3 named: a guard that has
 * never been made to fail is a guard that has not been tested. The positive
 * control at the bottom of this file is what made it fail.
 *
 * Task 4 makes this worse, not better -- four more entities routed through one
 * generic helper -- so the third form (importing the helper at all) is the one
 * that will still be true when the literals move again.
 */
function crmReferences(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const hits: string[] = [];

  for (const table of CRM_TABLES) {
    // Comments name these tables constantly (this file included), so every
    // pattern matches a CALL or a PROPERTY, never the bare word.
    const direct = new RegExp(`\\.(?:from|rpc)\\s*\\(\\s*["'\`]${table}["'\`]`);
    const viaSpec = new RegExp(`\\btable\\s*:\\s*["'\`]${table}["'\`]`);
    if (direct.test(source)) hits.push(table);
    else if (viaSpec.test(source)) hits.push(`${table} (via a list spec)`);
  }

  // The generic path. lib/list/query.ts can query ANY table it is handed, so
  // importing it into the shell is enough to break the property even if no
  // table name appears in the shell at all.
  if (/from\s+["'](?:@\/lib\/list\/query|.*\/lib\/list\/query)["']/.test(source)) {
    hits.push("lib/list/query (can reach any table)");
  }

  return hits;
}

describe("no CRM query is reachable from the signed-in app shell", () => {
  // Every entry point that renders BEFORE or ALONGSIDE the MFA gate.
  const entries = [
    "app/(app)/layout.tsx",
    "components/auth/mfa-enroll-gate.tsx",
    "components/auth/mfa-challenge-gate.tsx",
    "lib/auth/mfa-gate.ts",
    "lib/auth/index.ts",
  ].map((p) => join(ROOT, p));

  it("the entry points exist (so a rename cannot silently empty this test)", () => {
    for (const entry of entries) {
      expect(statSync(entry).isFile(), entry).toBe(true);
    }
  });

  it.each(entries)("%s reaches no CRM table", (entry) => {
    const graph = moduleGraph(entry);
    // The graph must be non-trivial, or a broken resolver would make this
    // pass by reaching nothing at all.
    expect(graph.length).toBeGreaterThan(1);

    const offenders = graph
      .map((file) => ({ file: file.slice(ROOT.length + 1), tables: crmReferences(file) }))
      .filter((r) => r.tables.length > 0);

    expect(
      offenders,
      offenders
        .map((o) => `${o.file} queries ${o.tables.join(", ")}`)
        .join("; ") +
        " -- a CRM read in the app shell locks un-enrolled Owners/Admins out " +
        "of the MFA enrolment screen. See FOLLOW-UPS.md.",
    ).toEqual([]);
  });

  it("the detector works: the contacts page DOES reach a CRM table", () => {
    // THE POSITIVE CONTROL, and it did its job on the first run: it failed,
    // because the detector was only looking for `.from("contacts")` and this
    // task queries through a helper that takes the table as a parameter. See
    // crmReferences() for what that meant.
    const graph = moduleGraph(join(ROOT, "app/(app)/[orgSlug]/contacts/page.tsx"));
    const found = graph.flatMap((f) => crmReferences(f));
    expect(found.some((f) => f.startsWith("contacts"))).toBe(true);
    expect(found).toContain("lib/list/query (can reach any table)");
  });
});

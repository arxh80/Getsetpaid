// A "use server" MODULE MAY EXPORT NOTHING BUT ASYNC FUNCTIONS, AND NOTHING
// IN THIS REPOSITORY SAID SO UNTIL A PAGE STOPPED COMPILING.
//
// Phase 8 Task 3's fix round added two string constants beside the operator's
// Server Actions in `lib/dsr/admin-actions.ts`, a file whose first line is
// `"use server"`. That is not a warning in Next.js: the compiler drops EVERY
// export from such a module for the client and SSR graphs, so
// `/super/data-requests` -- the whole operator queue -- failed at request time
// with "The module has no exports at all". It survived `pnpm lint`, `tsc
// --noEmit` and 2944 unit tests, because Vitest imports the module directly,
// where the constants are ordinary exports; the first Playwright run after the
// change found it in seconds.
//
// So this is the census that would have caught it: every `"use server"` file
// in the repository, every name it exports, and the rule that each one is an
// async function. The parse is deliberately syntactic -- importing the modules
// would drag in `server-only`, a Supabase client and a request store, and
// would ALSO pass, since that is exactly the seam that hid the bug.
//
// FIX ROUND 2 (R2). The first cut of this census could not see its own
// subject. It matched the directive as `/^["']use server["'];/` -- WITH the
// semicolon -- so dropping the semicolon (valid TypeScript, and what Next.js
// itself accepts; no Prettier or formatting check runs in any of the five
// gates) took the file out of the census entirely: the re-reviewer removed the
// semicolon from `lib/admin/health-actions.ts`, appended
// `export const PLANTED = 1;`, and got `33 passed (33)` -- GREEN WITH THE BUG
// PRESENT. It also missed an INDENTED top-level export, and the only
// denominator was `files.length > 20`, so the suite silently went 34 tests to
// 33 and nothing noticed a file LEAVING the census.
//
// Three changes, all of them the point of a census rather than a nicety:
//   1. the directive matcher tolerates the optional semicolon,
//   2. export lines are matched with leading whitespace allowed, and
//   3. MEMBERSHIP IS PINNED, not merely sized: the sorted file list is
//      asserted against the literal below, so a file leaving the census --
//      by a dropped semicolon, a rename, a moved directory -- is RED, and a
//      new server-action module is red until it is added here deliberately.
// That last one is the property that makes a census a census; the permission
// matrix's catalogue censuses already have it.
//
// CENSUS AUDIT (finding 6). R2 pinned MEMBERSHIP, which is the right property,
// and the subject set was still three hardcoded top-level directories:
// `const ROOTS = ["lib", "components", "app"]`. A `"use server"` module
// anywhere else -- a new root `server/`, `hooks/` or `actions/`, or a
// root-level `actions.ts` -- was in NEITHER side of the DENOMINATOR equality,
// so the equality passed and the module's exports were never checked. MEASURED
// before this change, with `server/planted.ts` carrying the directive and
// `export const PLANTED = 1`: DENOMINATOR passes, offenders [], suite green
// with the bug present.
//
// The set is now `appSourceFiles()` -- the whole repository minus a NAMED
// exclusion list -- the helper the storage and marketing-sender censuses
// already use, and which GROWS BY DEFAULT. The directive is read from the
// PARSED file rather than matched with a regex over a hand-stripped head, and
// every file's recovered parse errors are asserted empty: `ts.createSourceFile`
// never throws, so a badly broken file would otherwise be scanned, found to
// carry no directive, and counted as clean.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { appSourceFiles, isServerActionModule, parse, parseProblems, relPath } from "../support/app-source";

/**
 * Every top-level `export` in a file, as {name, kind}. Syntactic and
 * deliberately strict: anything it cannot classify is reported as its literal
 * text, so an unrecognised export shape fails loudly rather than silently
 * passing.
 */
function topLevelExports(source: string): { name: string; kind: string }[] {
  const out: { name: string; kind: string }[] = [];
  for (const raw of source.split("\n")) {
    // Leading whitespace is allowed: an INDENTED top-level export is still an
    // export, and matching `line.startsWith("export")` missed it (R2).
    if (!/^\s*export\b/.test(raw)) continue;
    const line = raw.trim();
    if (/^export\s+type\s/.test(line)) continue; // erased at compile time
    if (/^export\s+interface\s/.test(line)) continue;
    let m = /^export\s+async\s+function\s+([A-Za-z0-9_$]+)/.exec(line);
    if (m) {
      out.push({ name: m[1]!, kind: "async function" });
      continue;
    }
    m = /^export\s+function\s+([A-Za-z0-9_$]+)/.exec(line);
    if (m) {
      out.push({ name: m[1]!, kind: "SYNC function" });
      continue;
    }
    m = /^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/.exec(line);
    if (m) {
      out.push({ name: m[1]!, kind: "const" });
      continue;
    }
    out.push({ name: line, kind: "UNCLASSIFIED" });
  }
  return out;
}

/**
 * THE CENSUS ROLL. Every `"use server"` module in the repository, pinned by
 * name. Adding a server-action module means adding a line here -- that is the
 * cost of the guarantee, and it is the whole guarantee: without it a file that
 * falls OUT of the census (dropped semicolon, rename, move) just stops being
 * tested and the suite stays green one test shorter.
 */
const SERVER_ACTION_MODULES = [
  // Phase 8 Task 9c job 3a: the closed-workspace decisions.
  "lib/admin/closures.ts",
  "lib/admin/health-actions.ts",
  "lib/admin/impersonation.ts",
  "lib/admin/lifecycle.ts",
  "lib/admin/overrides.ts",
  // Phase 8 Task 6: the retention kill switch and the dry-run preview.
  "lib/admin/retention-actions.ts",
  "lib/auth/actions.ts",
  "lib/auth/mfa-actions.ts",
  "lib/auth/step-up-actions.ts",
  "lib/consent/actions.ts",
  "lib/crm/agencies.ts",
  "lib/crm/artists.ts",
  "lib/crm/companies.ts",
  "lib/crm/contacts.ts",
  "lib/crm/custom-field-actions.ts",
  "lib/crm/documents.ts",
  "lib/crm/events.ts",
  "lib/crm/finance.ts",
  "lib/crm/link-actions.ts",
  "lib/crm/merge.ts",
  "lib/crm/notes.ts",
  "lib/crm/tasks.ts",
  "lib/crm/venues.ts",
  "lib/dsr/actions.ts",
  "lib/dsr/admin-actions.ts",
  "lib/erasure/actions.ts",
  "lib/export/actions.ts",
  "lib/feedback/actions.ts",
  "lib/feedback/admin-actions.ts",
  "lib/invoices/actions.ts",
  "lib/invoices/settings-actions.ts",
  "lib/legal/admin-actions.ts",
  "lib/network/connections.ts",
  "lib/network/link-search.ts",
  "lib/network/links.ts",
  "lib/network/profiles.ts",
  "lib/org/actions.ts",
  "lib/org/closure-actions.ts",
  "lib/org/workspace-actions.ts",
  "lib/palette/search.ts",
];

const scanned = appSourceFiles().map((full) => {
  const source = readFileSync(full, "utf8");
  const sf = parse(full, source);
  return { path: relPath(full), source, problems: parseProblems(sf), isAction: isServerActionModule(sf) };
});
const files = scanned.filter((f) => f.isAction);

describe('every "use server" module exports only async functions', () => {
  it("DENOMINATOR: the walk is the whole repository and every file parsed", () => {
    // The floor is on the DENOMINATOR, not the numerator: the roll below pins
    // what the filter KEPT, and this pins that the filter had something to
    // keep from. 400 is the same floor the storage census uses.
    expect(scanned.length, "the app-source walk stopped seeing the repository").toBeGreaterThan(400);
    // What the filter THREW AWAY is a set too, and a file that cannot be
    // parsed is thrown away silently -- so it is asserted, not assumed.
    const broken = scanned.filter((f) => f.problems.length > 0).map((f) => `${f.path}: ${f.problems[0]}`);
    expect(broken, "these files were scanned for the directive with syntax errors recovered from").toEqual([]);
    // And the walk reaches OUTSIDE the three directories the old ROOTS list
    // held, which is the hole this replaced.
    expect(scanned.map((f) => f.path)).toContain("next.config.ts");
    expect(scanned.some((f) => !/^(lib|components|app)\//.test(f.path))).toBe(true);
  });

  it("DENOMINATOR: the census roll is exactly the modules on disk", () => {
    // Not vacuous, and not merely non-empty. If the directive detection broke
    // -- or one file's directive lost its semicolon -- every assertion below
    // would pass over a SHORTER list, silently. This is the assertion that
    // makes that red.
    const found = files.map((f) => f.path).sort();
    expect(
      found,
      'the set of `"use server"` modules on disk has changed. If you ADDED a ' +
        "server-action module, add its path to SERVER_ACTION_MODULES above. If a " +
        "path DISAPPEARED without being deleted, its directive is no longer being " +
        'recognised (a `"use server"` that is not the first statement, or a typo) ' +
        "and its exports are no longer being checked at all",
    ).toEqual([...SERVER_ACTION_MODULES].sort());
    expect(found.length).toBe(SERVER_ACTION_MODULES.length);
    expect(found).toContain("lib/dsr/admin-actions.ts");
  });

  it.each(files.map((f) => f.path))("%s", (path) => {
    const file = files.find((f) => f.path === path)!;
    const offenders = topLevelExports(file.source).filter((e) => e.kind !== "async function");
    expect(
      offenders,
      `${path} carries "use server", so Next.js keeps only its async function ` +
        `exports and DROPS EVERY OTHER EXPORT FROM THE MODULE — including the ` +
        `actions — for the client and SSR graphs. Move these to a plain module ` +
        `(the DSR pair live in lib/dsr/contract.ts for exactly this reason): ` +
        offenders.map((o) => `${o.name} (${o.kind})`).join(", "),
    ).toEqual([]);
  });
});

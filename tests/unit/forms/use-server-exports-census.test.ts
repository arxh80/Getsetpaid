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
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["lib", "components", "app"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** True for a file whose FIRST statement is the "use server" directive. */
function isUseServerModule(source: string): boolean {
  // Strip a leading block/line comment run, then look at the first token.
  const head = source.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  // The semicolon is OPTIONAL: ASI makes `"use server"` on its own line a
  // directive just the same, and Next.js honours it. Requiring the semicolon
  // is how the first cut of this census let a planted export through (R2).
  return /^["']use server["']\s*;?/.test(head);
}

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
  "lib/admin/health-actions.ts",
  "lib/admin/impersonation.ts",
  "lib/admin/lifecycle.ts",
  "lib/admin/overrides.ts",
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
  "lib/export/actions.ts",
  "lib/feedback/actions.ts",
  "lib/feedback/admin-actions.ts",
  "lib/legal/admin-actions.ts",
  "lib/network/connections.ts",
  "lib/network/link-search.ts",
  "lib/network/links.ts",
  "lib/network/profiles.ts",
  "lib/org/actions.ts",
  "lib/org/workspace-actions.ts",
  "lib/palette/search.ts",
];

const files = ROOTS.flatMap((root) => walk(root))
  .map((path) => ({ path: path.replace(/\\/g, "/"), source: readFileSync(path, "utf8") }))
  .filter((f) => isUseServerModule(f.source));

describe('every "use server" module exports only async functions', () => {
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

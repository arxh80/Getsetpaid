// A "use server" MODULE MAY EXPORT NOTHING BUT ASYNC FUNCTIONS, AND NOTHING
// IN THIS REPOSITORY SAID SO UNTIL A PAGE STOPPED COMPILING.
//
// Phase 8 Task 3's fix round added two string constants beside the operator's
// Server Actions in `lib/dsr/admin-actions.ts`, a file whose first line is
// `"use server"`. That is not a warning in Next.js: the compiler drops EVERY
// export from such a module for the client and SSR graphs, so
// `/super/data-requests` -- the whole operator queue -- failed at request time
// with "The module has no exports at all". It survived `pnpm lint`, `tsc
// --noEmit` and 2910 unit tests, because Vitest imports the module directly,
// where the constants are ordinary exports; the first Playwright run after the
// change found it in seconds.
//
// So this is the census that would have caught it: every `"use server"` file
// in the repository, every name it exports, and the rule that each one is an
// async function. The parse is deliberately syntactic -- importing the modules
// would drag in `server-only`, a Supabase client and a request store, and
// would ALSO pass, since that is exactly the seam that hid the bug.
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
  return /^["']use server["'];/.test(head);
}

/**
 * Every top-level `export` in a file, as {name, kind}. Syntactic and
 * deliberately strict: anything it cannot classify is reported as its literal
 * text, so an unrecognised export shape fails loudly rather than silently
 * passing.
 */
function topLevelExports(source: string): { name: string; kind: string }[] {
  const out: { name: string; kind: string }[] = [];
  for (const line of source.split("\n")) {
    if (!line.startsWith("export")) continue;
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
    out.push({ name: line.trim(), kind: "UNCLASSIFIED" });
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(root))
  .map((path) => ({ path: path.replace(/\\/g, "/"), source: readFileSync(path, "utf8") }))
  .filter((f) => isUseServerModule(f.source));

describe('every "use server" module exports only async functions', () => {
  it("DENOMINATOR: the census found the server-action modules at all", () => {
    // Not vacuous. If the directive detection ever broke, every assertion
    // below would pass over an empty list.
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((f) => f.path)).toContain("lib/dsr/admin-actions.ts");
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

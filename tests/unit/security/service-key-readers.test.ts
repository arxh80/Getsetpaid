import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { appSourceFiles, parse, relPath } from "../support/app-source";

// ===========================================================================
// PHASE 10 TASK 13 (G27) -- WHO READS SUPABASE_SERVICE_ROLE_KEY
// ===========================================================================
// The service-role key bypasses RLS. The three clients that use it get it
// from lib/supabase/env.ts, so the files that read the variable itself are a
// short, pinned list. A reader is code, not a comment: `process.env.KEY`,
// `process.env["KEY"]`, a destructured `{ KEY }`, or the name as a string
// literal handed to a helper (env.ts's own `required("KEY", ...)`). G27's row
// counted five files by text; three of those only name the key in comments,
// so the measured readers are the two below.
//
// scripts/ is not app source (tests/unit/support/app-source.ts), so
// scripts/storage-backup.mjs, which builds its own client, is outside this
// walk by design; its header says so.

const KEY = "SUPABASE_SERVICE_ROLE_KEY";

const READERS = new Map([
  ["lib/supabase/env.ts", "the one accessor the service-role clients (admin.ts, service.ts, storage.ts) use"],
  ["lib/dsr/routing-confirmation.ts", "deliberate: derives a purpose-hashed HMAC key from it; the key itself is never sent"],
]);

/** True when the source reads the service-role key in code. */
export function readsServiceKey(file: string, text: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(n) && n.name.text === KEY) ||
      ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === KEY) ||
      (ts.isBindingElement(n) && ((n.propertyName ?? n.name).getText() === KEY))
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(parse(file, text));
  return found;
}

describe("the files that read SUPABASE_SERVICE_ROLE_KEY (G27)", () => {
  const files = appSourceFiles().map((full) => ({ file: relPath(full), text: readFileSync(full, "utf8") }));

  it("are exactly the named ones", () => {
    expect(files.length).toBeGreaterThan(400);
    const readers = files.filter((f) => readsServiceKey(f.file, f.text)).map((f) => f.file).sort();
    expect(
      readers,
      "a new file reads the service-role key, which bypasses RLS. Use the existing clients, or name it in READERS with the reason.",
    ).toEqual([...READERS.keys()].sort());
  });
});

describe("the service-key detector", () => {
  it.each([
    ["process.env.KEY", `const k = process.env.${KEY};`],
    ["process.env['KEY']", `const k = process.env["${KEY}"];`],
    ["a destructure", `const { ${KEY} } = process.env;`],
    ["a renamed destructure", `const { ${KEY}: k } = process.env;`],
    ["the name handed to a helper", `required("${KEY}", process.env.X);`],
  ])("catches %s", (_label, text) => {
    expect(readsServiceKey("lib/x/a.ts", text)).toBe(true);
  });

  it("and not a comment, or a different key", () => {
    expect(readsServiceKey("lib/x/a.ts", `// read from ${KEY}\nconst k = process.env.OTHER;`)).toBe(false);
    expect(readsServiceKey("lib/x/a.ts", `const k = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;`)).toBe(false);
  });
});

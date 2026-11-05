import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { appSourceFiles, parse, relPath } from "../support/app-source";

// ===========================================================================
// INVOICES PART 2 TASK 1 -- WHO READS THE STRIPE / PAY-LINK VARIABLES
// ===========================================================================
// One reader per secret: lib/stripe/env.ts. Everything else gets the values
// through stripeEnv() / payLinkSecret(). Same detector as
// service-key-readers.test.ts (G27), parameterised by name: a reader is code
// (`process.env.NAME`, `process.env["NAME"]`, a destructure, or the name as a
// string literal handed to a helper), never a comment.
// scripts/ and tests/ are not app source (tests/unit/support/app-source.ts);
// scripts/dev-env.mjs only copies the lines from .env.example.

const NAMES = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_CLIENT_ID",
  "INVOICE_PAY_LINK_SECRET",
  "STRIPE_MODE",
];

export function readsName(name: string, file: string, text: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(n) && n.name.text === name) ||
      ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === name) ||
      (ts.isBindingElement(n) && (n.propertyName ?? n.name).getText() === name)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(parse(file, text));
  return found;
}

describe("the files that read the Stripe variables", () => {
  const files = appSourceFiles().map((full) => ({ file: relPath(full), text: readFileSync(full, "utf8") }));

  it.each(NAMES)("%s is read only in lib/stripe/env.ts", (name) => {
    expect(files.length).toBeGreaterThan(400);
    const readers = files.filter((f) => readsName(name, f.file, f.text)).map((f) => f.file);
    expect(
      readers,
      `a new file reads ${name}. Go through stripeEnv() / payLinkSecret() in lib/stripe/env.ts instead.`,
    ).toEqual(["lib/stripe/env.ts"]);
  });
});

describe("the Stripe-variable detector", () => {
  const NAME = "STRIPE_SECRET_KEY";
  it.each([
    ["process.env.NAME", `const k = process.env.${NAME};`],
    ["process.env['NAME']", `const k = process.env["${NAME}"];`],
    ["a destructure", `const { ${NAME} } = process.env;`],
    ["a renamed destructure", `const { ${NAME}: k } = process.env;`],
    ["the name handed to a helper", `value("${NAME}");`],
  ])("catches %s", (_label, text) => {
    expect(readsName(NAME, "lib/x/a.ts", text)).toBe(true);
  });

  it("and not a comment, or a different name", () => {
    expect(readsName(NAME, "lib/x/a.ts", `// read from ${NAME}\nconst k = process.env.OTHER;`)).toBe(false);
    expect(readsName(NAME, "lib/x/a.ts", `const k = process.env.STRIPE_WEBHOOK_SECRET;`)).toBe(false);
  });
});

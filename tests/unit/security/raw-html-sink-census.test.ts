import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { appSourceFiles, lineOf, parse, relPath, snippet } from "../support/app-source";

// ===========================================================================
// PHASE 10 TASK 13 (G18) -- NO RAW-HTML SINK ANYWHERE IN THE APP
// ===========================================================================
// CLAUDE.md § Non-negotiable rules: "avoid `dangerouslySetInnerHTML`". Until
// G18 only components/legal was asserted. This walks every app source file
// (app/, components/, lib/ and the root entry points) with the TypeScript
// parser, so a comment or a string that names a sink is not a hit, and asserts
// there are none of: the `dangerouslySetInnerHTML` prop (JSX or an object
// key), `innerHTML` / `outerHTML` / `insertAdjacentHTML`, `document.write`,
// `eval(...)` and `new Function(...)`.
//
// If a sink is ever genuinely needed, it needs a sanitiser and a review; add
// an allowlist here then, with the reason, rather than weakening the detector.

const PROPERTY_SINKS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML"]);

/** Every raw-HTML sink in a source file, as `file:line snippet`. */
export function rawHtmlSinks(file: string, text: string): string[] {
  const sf = parse(file, text);
  const hits: string[] = [];
  const hit = (n: ts.Node) => hits.push(`${file}:${lineOf(sf, n)} ${snippet(sf, n)}`);
  const visit = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === "dangerouslySetInnerHTML") hit(n);
    else if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      n.name.getText(sf).replace(/["']/g, "") === "dangerouslySetInnerHTML"
    ) hit(n);
    else if (ts.isPropertyAccessExpression(n) && PROPERTY_SINKS.has(n.name.text)) hit(n);
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && PROPERTY_SINKS.has(n.argumentExpression.text)) hit(n);
    else if (
      ts.isPropertyAccessExpression(n) &&
      (n.name.text === "write" || n.name.text === "writeln") &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "document"
    ) hit(n);
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "eval") hit(n);
    else if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === "Function") hit(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe("no raw-HTML sink in app source (G18)", () => {
  const files = appSourceFiles();

  it("DENOMINATOR: the walk covers app/, components/ and lib/", () => {
    const rel = files.map((f) => relPath(f));
    expect(rel.length).toBeGreaterThan(400);
    for (const dir of ["app/", "components/", "lib/"]) expect(rel.some((f) => f.startsWith(dir))).toBe(true);
  });

  it("finds none", () => {
    const hits = files.flatMap((full) => rawHtmlSinks(relPath(full), readFileSync(full, "utf8")));
    expect(hits, "a raw-HTML sink renders text as markup: render it as text, or sanitise it and add a reviewed allowlist here").toEqual([]);
  });
});

describe("the raw-HTML sink detector", () => {
  it.each([
    ["the JSX prop", "components/x.tsx", `export const X = () => <div dangerouslySetInnerHTML={{ __html: s }} />;`],
    ["the prop as an object key", "lib/x.ts", `createElement("div", { dangerouslySetInnerHTML: { __html: s } });`],
    ["innerHTML", "lib/x.ts", `el.innerHTML = s;`],
    ["outerHTML", "lib/x.ts", `el.outerHTML = s;`],
    ["innerHTML by string key", "lib/x.ts", `el["innerHTML"] = s;`],
    ["insertAdjacentHTML", "lib/x.ts", `el.insertAdjacentHTML("beforeend", s);`],
    ["document.write", "lib/x.ts", `document.write(s);`],
    ["eval", "lib/x.ts", `eval(s);`],
    ["new Function", "lib/x.ts", `const f = new Function("a", s);`],
  ])("catches %s", (_label, file, text) => {
    expect(rawHtmlSinks(file, text)).toHaveLength(1);
  });

  it("and not a comment, a string or a lookalike", () => {
    const text = [
      `// never use dangerouslySetInnerHTML or el.innerHTML = s`,
      `const msg = "avoid eval( and document.write";`,
      `const t = el.textContent; log.write(s); retrieval(s);`,
    ].join("\n");
    expect(rawHtmlSinks("lib/x.ts", text)).toEqual([]);
  });
});

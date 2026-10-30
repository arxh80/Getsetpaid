import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { appSourceFiles, lineOf, parse, relPath } from "../support/app-source";

// ===========================================================================
// PHASE 10 TASK 13 (G9) -- POSTGREST FILTER GRAMMAR IS NEVER BUILT FROM RAW INPUT
// ===========================================================================
// `.or("a.eq.x,b.eq.y")` and `.filter(...)` take PostgREST's own filter
// grammar as a string. A value interpolated into it raw can add a clause
// (`x,id.neq.0`), so every value must arrive in one of the safe forms:
//
//   quoteLogicValue(...)   -- lib/list/postgrest.ts, always quotes
//   containsPattern(...)   -- the escaped ilike pattern
//   cursor.id              -- the keyset cursor's id, uuid-validated on decode
//   a const set from one of those, or a ternary of string literals and such
//   consts (the operator words `gt` / `lt` / `gte` / `lte`)
//
// or be named in SITE_ALLOWED with the reason. The census finds every
// template literal passed to `.or(` / `.filter(`, and every template literal
// assigned to an `or:` property (the keyset clause builders that hand
// `.or(clause.or)` their string). An `.or(x)` with any other non-literal
// argument is a finding unless its file builds `or:` from a checked template.

const SAFE_CALLS = new Set(["quoteLogicValue", "containsPattern"]);

/** Interpolations that are safe for a reason the AST cannot see. */
const SITE_ALLOWED: Record<string, Record<string, string>> = {
  "lib/list/query.ts": {
    column: "applyCursor's column is always spec.sort[...].column, the list spec's allowlisted sort column",
  },
};

/** The five template-literal sites, measured 2026-10-26 (G9's row counted four). */
const KNOWN_SITES = [
  "lib/admin/audit-log.ts",
  "lib/admin/health.ts",
  "lib/dsr/queue.ts",
  "lib/feedback/list.ts",
  "lib/list/query.ts",
];

interface Site {
  where: string;
  unsafe: string[];
}

const callName = (e: ts.Expression): string | null =>
  ts.isCallExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : null;

const isStringy = (e: ts.Expression): boolean => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);

/** Every PostgREST-grammar template literal in a file, with its unsafe interpolations. */
export function interpolationSites(file: string, text: string): Site[] {
  const sf = parse(file, text);
  const decls = new Map<string, ts.Expression[]>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      decls.set(n.name.text, [...(decls.get(n.name.text) ?? []), n.initializer]);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const safeInit = (e: ts.Expression): boolean => {
    const name = callName(e);
    if (name !== null) return SAFE_CALLS.has(name);
    if (ts.isConditionalExpression(e)) return safeInit(e.whenTrue) && safeInit(e.whenFalse);
    if (ts.isIdentifier(e)) return (decls.get(e.text) ?? []).length > 0 && decls.get(e.text)!.every(safeInit);
    return isStringy(e);
  };
  const safeSpan = (e: ts.Expression): boolean => {
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "cursor" && e.name.text === "id") return true;
    if (ts.isIdentifier(e) && SITE_ALLOWED[file]?.[e.text]) return true;
    return safeInit(e);
  };

  const sites: Site[] = [];
  let builtOr = false;
  const indirect: ts.Node[] = [];
  const check = (n: ts.Node, t: ts.TemplateExpression) =>
    sites.push({
      where: `${file}:${lineOf(sf, n)}`,
      unsafe: t.templateSpans.filter((s) => !safeSpan(s.expression)).map((s) => s.expression.getText(sf)),
    });
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["or", "filter"].includes(n.expression.name.text)) {
      const arg = n.arguments[0];
      if (arg && ts.isTemplateExpression(arg)) check(n, arg);
      else if (arg && n.expression.name.text === "or" && !isStringy(arg)) indirect.push(n);
    } else if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "or" && ts.isTemplateExpression(n.initializer)) {
      builtOr = true;
      check(n, n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!builtOr) {
    for (const n of indirect) sites.push({ where: `${file}:${lineOf(sf, n)}`, unsafe: [n.getText(sf)] });
  }
  return sites;
}

describe("PostgREST filter grammar is built only from safe values (G9)", () => {
  const sites = appSourceFiles().flatMap((full) => interpolationSites(relPath(full), readFileSync(full, "utf8")));

  it("finds exactly the known sites (non-vacuity, and a sixth lands red)", () => {
    expect([...new Set(sites.map((s) => s.where.replace(/:\d+$/, "")))].sort()).toEqual(KNOWN_SITES);
  });

  it("and every interpolated value is in a safe form", () => {
    const unsafe = sites.filter((s) => s.unsafe.length > 0).map((s) => `${s.where} ${s.unsafe.join(", ")}`);
    expect(unsafe, "pass the value through quoteLogicValue() (lib/list/postgrest.ts), or name it in SITE_ALLOWED with the reason").toEqual([]);
  });
});

describe("the interpolation detector", () => {
  it("catches a raw value in .or(), in .filter(), and in an or: builder", () => {
    expect(interpolationSites("lib/x.ts", "q.or(`name.eq.${input}`);")[0]?.unsafe).toEqual(["input"]);
    expect(interpolationSites("lib/x.ts", "q.filter(`name.eq.${params.q}`);")[0]?.unsafe).toEqual(["params.q"]);
    expect(interpolationSites("lib/x.ts", "const c = { or: `a.eq.${raw}` };")[0]?.unsafe).toEqual(["raw"]);
  });

  it("catches a const that only looks safe, and an indirect .or(x) with no checked builder", () => {
    expect(interpolationSites("lib/x.ts", "const v = input.trim();\nq.or(`a.eq.${v}`);")[0]?.unsafe).toEqual(["v"]);
    expect(interpolationSites("lib/x.ts", "const v = asc ? 'gt' : input;\nq.or(`a.${v}.1`);")[0]?.unsafe).toEqual(["v"]);
    expect(interpolationSites("lib/x.ts", "q.or(clause);")[0]?.unsafe).toEqual(["q.or(clause)"]);
  });

  it("accepts the safe forms", () => {
    const text = [
      "const strict = asc ? 'gt' : 'lt';",
      "const quoted = quoteLogicValue(cursor.value);",
      "q.or(`created_at.${strict}.${quoted},and(created_at.eq.${quoted},id.${strict}.${cursor.id})`);",
      "q.or(`name.ilike.${containsPattern(s)}`);",
      "q.or('a.eq.1,b.eq.2');",
    ].join("\n");
    expect(interpolationSites("lib/x.ts", text).flatMap((s) => s.unsafe)).toEqual([]);
  });
});

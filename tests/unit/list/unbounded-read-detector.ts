import ts from "typescript";
import { parse } from "../support/app-source";

// The detector behind unbounded-read-census.test.ts (G7). Kept beside the test
// so its fixtures and the census share one implementation.

const BOUNDING = new Set(["limit", "range", "single", "maybeSingle"]);

/** The method names called along a fluent chain, outermost first. */
function chainMethods(e: ts.Expression): { names: string[]; calls: ts.CallExpression[]; root: ts.Expression } {
  const names: string[] = [];
  const calls: ts.CallExpression[] = [];
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isCallExpression(cur) && (ts.isPropertyAccessExpression(cur.expression) || ts.isPropertyAccessChain(cur.expression))) {
      names.push(cur.expression.name.text);
      calls.push(cur);
      cur = cur.expression.expression;
    } else if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
    } else return { names, calls, root: cur };
  }
}

const isIdEquality = (c: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(c.expression) &&
  c.expression.name.text === "eq" &&
  c.arguments.length > 0 &&
  ts.isStringLiteral(c.arguments[0]!) &&
  c.arguments[0].text === "id";

const isHeadOnly = (c: ts.CallExpression): boolean =>
  c.arguments.some(
    (a) =>
      ts.isObjectLiteralExpression(a) &&
      a.properties.some(
        (p) => ts.isPropertyAssignment(p) && p.name.getText() === "head" && p.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ),
  );

/** True when a chain is bounded by itself. */
function chainBounded(calls: ts.CallExpression[]): boolean {
  return calls.some((c) => {
    const name = (c.expression as ts.PropertyAccessExpression).name.text;
    return BOUNDING.has(name) || isIdEquality(c) || (name === "select" && isHeadOnly(c));
  });
}

/** The nearest enclosing function-like node and a stable name for it. */
function enclosing(n: ts.Node): { fn: ts.Node | null; name: string } {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return { fn: p, name: p.name?.getText() ?? "<anonymous>" };
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      // Named by the declaration it is assigned to, through wrappers such as
      // `const f = cache(async () => …)`; an inline callback takes the name of
      // the function it lives in. The later-statement search stays inside p.
      for (let q: ts.Node | undefined = p.parent; q; q = q.parent) {
        if (ts.isVariableDeclaration(q) || ts.isPropertyAssignment(q)) return { fn: p, name: q.name.getText() };
        if (ts.isFunctionDeclaration(q) || ts.isMethodDeclaration(q)) return { fn: p, name: q.name?.getText() ?? "<anonymous>" };
      }
      return { fn: p, name: "<module>" };
    }
  }
  return { fn: null, name: "<module>" };
}

/** The variable a chain's value is stored in, if any (`const q = …` or `q = …`). */
function storedIn(top: ts.Node): string | null {
  let p = top.parent;
  while (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) p = p.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(p.left)) return p.left.text;
  return null;
}

/** Whether the function bounds `name` later: a `name.limit(…)`-style chain anywhere in it. */
function boundedLater(fn: ts.Node | null, name: string): boolean {
  if (!fn) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const { calls, root } = chainMethods(n);
      if (ts.isIdentifier(root) && root.text === name && chainBounded(calls)) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

export interface UnboundedRead {
  /** `file function from(arg)`: the allowlist key, stable across line moves. */
  key: string;
  line: number;
}

/** Every `.from(…).select(…)` table read in a file that nothing bounds. */
export function unboundedReads(file: string, text: string): UnboundedRead[] {
  const sf = parse(file, text);
  const out: UnboundedRead[] = [];
  const visit = (n: ts.Node): void => {
    // The outermost call of a chain: its parent is not a further `.x(` on it.
    if (ts.isCallExpression(n) && !(ts.isPropertyAccessExpression(n.parent) && ts.isCallExpression(n.parent.parent))) {
      const { names, calls } = chainMethods(n);
      const fromIdx = names.lastIndexOf("from");
      const from = calls[fromIdx];
      const fromObj = from && (from.expression as ts.PropertyAccessExpression).expression;
      const isStorage = fromObj && ts.isPropertyAccessExpression(fromObj) && fromObj.name.text === "storage";
      if (from && !isStorage && names.slice(0, fromIdx).includes("select") && !chainBounded(calls)) {
        const { fn, name } = enclosing(n);
        const stored = storedIn(n);
        if (!(stored && boundedLater(fn, stored))) {
          out.push({
            key: `${file} ${name} from(${from.arguments.map((a) => a.getText(sf)).join(", ")})`,
            line: sf.getLineAndCharacterOfPosition(from.getStart(sf)).line + 1,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

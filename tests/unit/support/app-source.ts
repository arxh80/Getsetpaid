import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import ts from "typescript";

// ===========================================================================
// THE APP-SHIPPED SOURCE SET, AND A PARSER FOR IT.
// ===========================================================================
// Shared by the source censuses (tests/unit/legal/storage-census.test.ts,
// tests/unit/consent/marketing-sender-census.test.ts).
//
// WHY THE SET IS DERIVED, NOT LISTED. The first storage census scanned a
// fixed list of folders (app/, components/, lib/, proxy.ts, next.config.ts).
// A GA loader in a root `instrumentation-client.ts` -- Next's own documented
// place to start client analytics -- or in a new `hooks/` folder was never
// read (Task 2 review, I1). So the set is every script file in the repository
// EXCEPT the named non-shipped places below; a new root file or folder is in
// the set the moment it exists.
//
// WHY AN AST, NOT REGEX. The regex scanner stripped comments with a pattern
// that also ate everything after a `//` inside a string, and could not follow
// an aliased import, a destructured method or optional chaining. The
// TypeScript parser already knows what a comment, a string and a call are.
// ===========================================================================

export const REPO_ROOT = resolve(__dirname, "../../..");

export const SCRIPT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** Top-level directories that are not part of what the app ships. */
export const NON_SHIPPED_ROOT_DIRS: ReadonlySet<string> = new Set([
  "tests",
  "supabase",
  "scripts",
  "test-results",
  "playwright-report",
  "coverage",
  "graphify-out",
]);

/** Directories skipped at ANY depth. */
const NEVER_DIRS: ReadonlySet<string> = new Set(["node_modules", ".next"]);

function walk(dir: string, atRoot: boolean, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (NEVER_DIRS.has(entry)) continue;
      // Dot-directories are skipped only at the root (.git, .claude,
      // .superpowers, .agents, .github). Inside app/ a dot-directory can be a
      // route (`.well-known`), so it is scanned.
      if (atRoot && (entry.startsWith(".") || NON_SHIPPED_ROOT_DIRS.has(entry))) continue;
      walk(full, false, out);
    } else if (SCRIPT_EXT.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

/** Every app-shipped script file under `root`, as absolute paths, sorted. */
export function appSourceFiles(root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  walk(root, true, out);
  return out.sort();
}

export function relPath(file: string, root: string = REPO_ROOT): string {
  return file.slice(root.length + 1).replace(/\\/g, "/");
}

export function parse(file: string, text: string): ts.SourceFile {
  const kind = /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(file)
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * The syntax errors the parser RECOVERED from (re-review N5).
 * `ts.createSourceFile` never throws: a file with a syntax error is parsed
 * with recovery, so a badly broken file can be scanned and found "clean"
 * while the scanner simply could not see the statement that was broken.
 * Every census asserts this is empty for every file it scans.
 */
export function parseProblems(sf: ts.SourceFile): string[] {
  const diagnostics =
    (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  return diagnostics.map((d) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
    return `${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
}

/** The directives (`"use client"`, `"use server"`) at the top of a file. */
export function directives(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const statement of sf.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !(ts.isStringLiteral(statement.expression) || ts.isNoSubstitutionTemplateLiteral(statement.expression))
    ) {
      return out;
    }
    out.push(statement.expression.text);
  }
  return out;
}

export const isClientModule = (sf: ts.SourceFile): boolean => directives(sf).includes("use client");
/**
 * A `"use server"` module is a BOUNDARY, not a bundle edge: a client component
 * that imports one gets an RPC stub, and nothing the action module imports is
 * compiled into the browser. So a reachability walk from a client component
 * stops here.
 */
export const isServerActionModule = (sf: ts.SourceFile): boolean => directives(sf).includes("use server");

/**
 * True when the file's first statements include a bare `import "server-only"`
 * (re-review N6). Read from the parsed file, not matched with a regex: a
 * regex matches the same line inside a block comment, which imports nothing.
 */
export function importsServerOnly(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      !s.importClause &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === "server-only",
  );
}

/** Strips parentheses, `await`, `!`, `as`, `satisfies` and `<T>` casts. */
export function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAwaitExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

/**
 * The constant string an expression evaluates to, when that is knowable from
 * the file alone: literals, `+` of constants, templates whose every part is
 * constant, and identifiers bound by `const X = <constant>` anywhere in the
 * file (name-based, so conservative in the direction of FINDING a value).
 */
export function constantString(
  e: ts.Expression | undefined,
  consts: ReadonlyMap<string, ts.Expression> = new Map(),
  depth = 0,
): string | null {
  if (!e || depth > 20) return null;
  const x = unwrap(e);
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = constantString(x.left, consts, depth + 1);
    const r = constantString(x.right, consts, depth + 1);
    return l !== null && r !== null ? l + r : null;
  }
  if (ts.isTemplateExpression(x)) {
    let s = x.head.text;
    for (const span of x.templateSpans) {
      const v = constantString(span.expression, consts, depth + 1);
      if (v === null) return null;
      s += v + span.literal.text;
    }
    return s;
  }
  if (ts.isIdentifier(x)) {
    const init = consts.get(x.text);
    return init ? constantString(init, consts, depth + 1) : null;
  }
  return null;
}

/** `const NAME = <expr>` declarations in a file, by name. */
export function constDeclarations(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      out.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export interface ModuleReference {
  /** The specifier as written. */
  specifier: string | null;
  node: ts.Node;
  /** The imported names (`default`, `*` for a namespace), mapped to local names. */
  bindings: { imported: string; local: string }[];
}

/**
 * Every static import, re-export, dynamic `import()` and `require()` in a
 * file. A dynamic import whose specifier is not constant has `specifier: null`.
 */
export function moduleReferences(sf: ts.SourceFile, consts = constDeclarations(sf)): ModuleReference[] {
  const refs: ModuleReference[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      const bindings: ModuleReference["bindings"] = [];
      if (ts.isImportDeclaration(n) && n.importClause) {
        const c = n.importClause;
        if (c.name) bindings.push({ imported: "default", local: c.name.text });
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) {
          bindings.push({ imported: "*", local: c.namedBindings.name.text });
        } else if (c.namedBindings) {
          for (const el of c.namedBindings.elements) {
            bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
          }
        }
      }
      refs.push({ specifier: constantString(n.moduleSpecifier as ts.Expression, consts), node: n, bindings });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      refs.push({
        specifier: constantString(n.moduleReference.expression, consts),
        node: n,
        bindings: [{ imported: "*", local: n.name.text }],
      });
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === "require"))
    ) {
      const bindings: ModuleReference["bindings"] = [];
      const p = n.parent;
      if (ts.isVariableDeclaration(p) || (ts.isAwaitExpression(p) && ts.isVariableDeclaration(p.parent))) {
        const decl = (ts.isVariableDeclaration(p) ? p : p.parent) as ts.VariableDeclaration;
        if (ts.isIdentifier(decl.name)) bindings.push({ imported: "*", local: decl.name.text });
        else if (ts.isObjectBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            bindings.push({ imported, local: el.name.text });
          }
        }
      }
      refs.push({ specifier: constantString(n.arguments[0], consts), node: n, bindings });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return refs;
}

/**
 * Resolves a specifier to a repo-relative path WITHOUT extension (so
 * `lib/email/send`), for `@/…` and relative specifiers. Returns null for a
 * package specifier.
 */
export function resolveSpecifier(fromRel: string, specifier: string): string | null {
  let target: string;
  if (specifier.startsWith("@/")) target = specifier.slice(2);
  else if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..") {
    target = posix.join(posix.dirname(fromRel), specifier);
  } else return null;
  target = posix.normalize(target).replace(/\/$/, "");
  return target.replace(SCRIPT_EXT, "").replace(/\/index$/, "");
}

/** True when `resolved` (from resolveSpecifier) names the module at repo path `moduleRel`. */
export function namesModule(resolved: string | null, moduleRel: string): boolean {
  if (resolved === null) return false;
  const m = moduleRel.replace(SCRIPT_EXT, "").replace(/\/index$/, "");
  return resolved === m;
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function snippet(sf: ts.SourceFile, node: ts.Node): string {
  const t = node.getText(sf).replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

/** Known entry points Next loads without any import pointing at them. */
export const KNOWN_ENTRY_POINTS = [
  "proxy.ts",
  "middleware.ts",
  "next.config.ts",
  "instrumentation.ts",
  "instrumentation-client.ts",
  "app/layout.tsx",
] as const;

export function existingEntryPoints(root: string = REPO_ROOT): string[] {
  return KNOWN_ENTRY_POINTS.filter((p) => existsSync(join(root, p)));
}

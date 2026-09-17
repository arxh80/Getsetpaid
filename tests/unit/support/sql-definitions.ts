import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// THE LATEST DEFINITION OF A SQL FUNCTION, FROM THE MIGRATIONS
// (Phase 8 Task 2 scoped re-review, N8).
//
// A catalogue binding (a TypeScript list asserted equal to the one a database
// function returns) must read the function's LATEST body: a later migration
// that re-creates it with a different list is what is deployed. The first
// cut found that body with a text regex on `create or replace function
// <name>()`, which silently misses a later `CREATE FUNCTION`, odd spacing,
// quoted identifiers or a `$body$` tag, and would match a commented-out or
// quoted copy -- leaving the binding checking a stale body while green.
//
// This walks every migration IN FILENAME ORDER (the order the CLI applies
// them) and splits each into statements with a small lexer that understands
// `--` and nested `/* */` comments, '...' and E'...' strings, "quoted"
// identifiers and $tag$ dollar quotes. A statement whose head (the text before
// its first dollar quote) reads `create [or replace] function <schema>.<name>(`
// replaces the current definition with that statement's first dollar-quoted
// string; `drop function ... <schema>.<name>` or `alter function <schema>.<name>
// ... rename to` clears it. Overloads are not told apart: every binding that
// uses this names a function with one signature.
//
// The integration half (tests/integration/legal/catalogue-bindings-match-db.test.ts)
// asserts the body this returns is byte-for-byte `pg_proc.prosrc` in the live
// database, so a parse this walker got wrong is a red test, not a stale pass.

export interface SqlFunctionDefinition {
  file: string;
  body: string;
}

export interface MigrationText {
  file: string;
  text: string;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationText[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      text: readFileSync(`${dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`}${file}`, "utf8")
        .split(String.fromCharCode(13))
        .join(""),
    }));
}

interface Statement {
  /** The statement with comments removed and every dollar-quoted run replaced by `$$`. */
  head: string;
  /** The contents of each dollar-quoted run, in order. */
  dollars: string[];
}

const IDENT = /[A-Za-z0-9_]/;

/** Splits SQL into statements, understanding comments, strings and dollar quotes. */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let head = "";
  let dollars: string[] = [];
  let i = 0;
  const n = sql.length;
  const flush = () => {
    if (head.trim() !== "" || dollars.length > 0) out.push({ head, dollars });
    head = "";
    dollars = [];
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? n : end;
      head += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      if (depth > 0) throw new Error("unterminated block comment");
      head += " ";
      continue;
    }
    if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]) && !(i > 1 && IDENT.test(sql[i - 2]));
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error("unterminated string literal");
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      head += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error("unterminated quoted identifier");
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      head += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$" && !(i > 0 && IDENT.test(sql[i - 1]))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) throw new Error(`unterminated dollar quote ${tag[0]}`);
        dollars.push(sql.slice(i + tag[0].length, close));
        head += "$$";
        i = close + tag[0].length;
        continue;
      }
    }
    if (c === ";") {
      flush();
      i += 1;
      continue;
    }
    head += c;
    i += 1;
  }
  flush();
  return out;
}

/** `"Private" . "x"` -> `private.x`; unquoted names fold to lower case, as Postgres does. */
function normaliseHead(head: string): string {
  return head
    .replace(/"((?:[^"]|"")*)"|([^"]+)/g, (_m, quoted: string | undefined, bare: string | undefined) =>
      quoted !== undefined ? quoted.replace(/""/g, '"') : bare!.toLowerCase(),
    )
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s*\(\s*/g, "(")
    .trim();
}

export function latestFunctionDefinition(
  qualifiedName: string,
  migrations: MigrationText[] = readMigrations(),
): SqlFunctionDefinition {
  const name = qualifiedName.toLowerCase();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const create = new RegExp(`^create (or replace )?function ${escaped}\\(`);
  const drop = new RegExp(`^drop function (if exists )?(.*[ ,])?${escaped}(\\(|[ ,;]|$)`);
  const rename = new RegExp(`^alter function ${escaped}(\\(|\\s).* rename to `);
  let found: SqlFunctionDefinition | null = null;
  for (const { file, text } of migrations) {
    for (const statement of splitStatements(text)) {
      const head = normaliseHead(statement.head);
      if (create.test(head)) {
        if (statement.dollars.length === 0) throw new Error(`${file}: ${qualifiedName} has no dollar-quoted body`);
        found = { file, body: statement.dollars[0] };
      } else if (drop.test(head) || rename.test(head)) {
        found = null;
      }
    }
  }
  if (!found) throw new Error(`${qualifiedName} is defined in no migration (or its latest statement drops it)`);
  return found;
}

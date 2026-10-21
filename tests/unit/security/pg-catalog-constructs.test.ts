import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ===========================================================================
// THE FOURTH TIME IS WHERE THE COMMENT STOPS WORKING
// ===========================================================================
// NULLIF, COALESCE, GREATEST, LEAST, CASE, CAST, TRIM, ROW, ARRAY[...],
// COLLATE and the XML forms are SQL *constructs* -- parser syntax -- and are
// NOT functions in pg_catalog. `pg_catalog.nullif(...)` therefore resolves to
// nothing and raises
//
//   42883  function pg_catalog.nullif(text, unknown) does not exist
//
// A plpgsql body is parsed LAZILY, at first execution rather than at CREATE,
// so the migration applies cleanly, CI stays green, and the failure arrives as
// a PostgREST 404 on every RPC that calls it.
//
// This repository has hit that exact trap THREE times:
//   * 20260827015924:132   -- comment written
//   * 20260908030000:365   -- comment written again
//   * 20260915000000:97    -- written anyway (repaired by 20260915001000)
// Two comments did not prevent the third, so this is a check instead.
//
// The habit that causes it is otherwise CORRECT: every function in this schema
// runs `set search_path = ''` and schema-qualifies its calls, so `pg_catalog.`
// in front of a bare name reads as the careful choice. It is the right
// instinct applied to names that are not functions. Unqualified is SAFE for
// these: the SQL parser resolves a construct itself, with no search_path
// lookup to hijack.
// ===========================================================================

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../supabase/migrations", import.meta.url),
);
const PSQL_TESTS_DIR = fileURLToPath(
  new URL("../../../supabase/tests", import.meta.url),
);

/**
 * Names with ZERO entries in pg_catalog.pg_proc on this stack -- each one
 * verified by querying `pg_proc` in the local database rather than assumed:
 *
 *   select proname from pg_proc where pronamespace = 'pg_catalog'::regnamespace
 *
 * DELIBERATELY EXCLUDED, because pg_catalog DOES hold a function of that name
 * and `pg_catalog.<name>(...)` is legal: position (3), extract (6),
 * overlay (6), substring (8), btrim (3), current_setting (2), set_config (1),
 * gen_random_uuid (1), and every `array_*` / `row_security_active` helper.
 * Flagging those would be a false positive on working code.
 */
const CONSTRUCTS = [
  "array",
  "case",
  "cast",
  "coalesce",
  "collate",
  "greatest",
  "is",
  "least",
  "nullif",
  "row",
  "trim",
  "xmlconcat",
  "xmlelement",
  "xmlforest",
  "xmlparse",
  "xmlpi",
  "xmlroot",
  "xmlserialize",
] as const;

// The trailing guard is what keeps `pg_catalog.array_agg`, `pg_catalog.row_
// security_active` and `pg_catalog.trim_array` out of the net: an identifier
// character after the name means this is a different, real, function.
const OFFENDER = new RegExp(
  `pg_catalog\\.(${CONSTRUCTS.join("|")})(?![A-Za-z0-9_])`,
  "gi",
);

/**
 * Files whose offending text is IMMUTABLE HISTORY. A committed migration is
 * never edited, so a defect that shipped stays on disk; the repair is a later
 * migration. Each entry names the file that fixed it, so the allowlist cannot
 * quietly become a place to park new breakage.
 */
const IMMUTABLE_HISTORY: Record<string, string> = {
  "20260915000000_crm_bulk_audit_reentrant.sql":
    "shipped with pg_catalog.nullif/coalesce; both bodies replaced by " +
    "20260915001000_crm_bulk_audit_reentrant_fix.sql. Immutable, so the " +
    "text stays and only the repair can be asserted.",
};

/**
 * Comments blanked IN PLACE (newlines kept, so line numbers survive), by a
 * lexer that understands what `--` is INSIDE.
 *
 * CENSUS AUDIT, finding 3's second half. This used to be
 * a `.replace()` of a `--`-to-end-of-line pattern, which truncates a line at
 * the first `--`
 * wherever it appears -- so
 *
 *   raise notice 'a -- b'; v := pg_catalog.nullif(x, y);
 *
 * hid a real offender inside an ordinary string literal. That is the SQL
 * spelling of the same defect as tests/support/source.ts's stripComments,
 * fixed in the same task. A dollar-quoted body is the normal place for the
 * offending text, so dollar quotes are understood too, and their CONTENTS are
 * kept and re-scanned rather than skipped.
 */
export function stripSqlComments(sql: string): string {
  const out = sql.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      const ch = out[k];
      if (ch !== String.fromCharCode(10) && ch !== String.fromCharCode(13)) out[k] = " ";
    }
  };
  const IDENT = /[A-Za-z0-9_]/;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf(String.fromCharCode(10), i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      // A quoted string or identifier: skipped whole, so nothing inside it is
      // read as a comment and nothing inside it is read as an offender either.
      const escapes = c === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && !(i > 1 && IDENT.test(sql[i - 2]));
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = Math.min(j + 1, n);
      continue;
    }
    if (c === "$" && !(i > 0 && IDENT.test(sql[i - 1]))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        // The BODY is where the offenders live, so step INTO it: only the two
        // delimiters are skipped.
        i += tag[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out.join("");
}

/** Every `.sql` file under `dir`, RECURSIVELY. */
function sqlFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sqlFilesIn(full));
    else if (entry.name.endsWith(".sql")) out.push(full);
  }
  return out;
}

/**
 * The offenders, AND the number of files they were looked for in.
 *
 * CENSUS AUDIT, finding 3, the worst denominator in the repository: this
 * returned a bare `string[]`, `readdirSync(dir)` was NOT recursive, and
 * nothing anywhere asserted that a single file had been read. Moving the
 * nineteen psql suites into subfolders -- `supabase/tests/rls/*.sql`, an
 * entirely routine organising change -- would have left `readdirSync`
 * returning only directory entries, every one filtered out by `.endsWith`,
 * and both assertions passing over ZERO FILES, for ever. The count comes back
 * with the hits now, and the callers pin it.
 */
function offendersIn(dir: string): { files: number; hits: string[] } {
  const hits: string[] = [];
  let files = 0;
  for (const path of sqlFilesIn(dir)) {
    const name = path.slice(dir.length + 1);
    // Counted BEFORE the allowlist skip: the denominator is how many files the
    // WALK found, not how many were searched, or an allowlist could shrink it.
    files += 1;
    if (name in IMMUTABLE_HISTORY) continue;
    const lines = stripSqlComments(readFileSync(path, "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(OFFENDER)) {
        hits.push(`${name}:${i + 1}  ${m[0]}`);
      }
    });
  }
  return { files, hits };
}

const WHY = (hits: string[]) =>
  `${hits.length} schema-qualified SQL construct(s) found:\n\n  ${hits.join(
    "\n  ",
  )}\n\nThese names are SQL CONSTRUCTS (parser syntax), not functions in\n` +
  `pg_catalog, so \`pg_catalog.<name>(...)\` raises 42883 "function ... does\n` +
  `not exist" -- and because plpgsql bodies parse LAZILY, at first execution,\n` +
  `the migration applies green and the failure surfaces as a PostgREST 404 on\n` +
  `every RPC that reaches the line. Write them UNQUALIFIED. That is safe even\n` +
  `under \`set search_path = ''\`: the parser resolves a construct itself, with\n` +
  `no search_path lookup to hijack. (This repo has hit it three times --\n` +
  `20260827015924, 20260908030000, 20260915000000.)`;

describe("pg_catalog. is never put in front of a SQL construct", () => {
  it("no migration schema-qualifies a construct", () => {
    const { files, hits } = offendersIn(MIGRATIONS_DIR);
    // THE DENOMINATOR, which did not exist at all. `>= 163` is the migration
    // count at the tip this was written against; a walk that stopped seeing
    // the directory, or a reorganisation into subfolders, is red here rather
    // than green over nothing.
    expect(files, "the migration walk read no files -- see offendersIn()").toBeGreaterThanOrEqual(163);
    expect(hits, WHY(hits)).toEqual([]);
  });

  it("no psql suite schema-qualifies a construct either", () => {
    const { files, hits } = offendersIn(PSQL_TESTS_DIR);
    // Nineteen suites at this tip. This is the exact number the audit's
    // evasion -- moving them into supabase/tests/rls/ -- would have taken to
    // zero in silence.
    expect(files, "the psql-suite walk read no files -- see offendersIn()").toBeGreaterThanOrEqual(19);
    expect(hits, WHY(hits)).toEqual([]);
  });

  it("DENOMINATOR: the walk is recursive, and a file in a subfolder is read", () => {
    // Proven against a real tree rather than asserted: the two floors above
    // are satisfied today by flat directories, so nothing in them would
    // notice the walk losing its recursion.
    const dir = mkdtempSync(join(tmpdir(), "pgcat-"));
    try {
      mkdirSync(join(dir, "rls"));
      writeFileSync(join(dir, "flat.sql"), "select 1;\n");
      writeFileSync(join(dir, "rls", "nested.sql"), "select pg_catalog.nullif(a, b);\n");
      const { files, hits } = offendersIn(dir);
      expect(files).toBe(2);
      expect(hits).toEqual(["rls/nested.sql:1  pg_catalog.nullif"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the comment stripper does not eat code after a `--` inside a string", () => {
    // MEASURED. The `.replace(/--[^\n]*/g, " ")` this replaced truncated the
    // line at the `--` inside the literal and never saw the offender.
    const line = `raise notice 'a -- b'; v := pg_catalog.nullif(x, y);`;
    expect([...stripSqlComments(line).matchAll(OFFENDER)].length).toBe(1);
    expect([...line.replace(/--[^\n]*/g, " ").matchAll(OFFENDER)].length, "the old regex is supposed to MISS this").toBe(0);
    // A real comment is still removed, including one inside a function body...
    expect([...stripSqlComments(`-- pg_catalog.nullif(x, y)`).matchAll(OFFENDER)].length).toBe(0);
    expect([...stripSqlComments(`/* pg_catalog.coalesce(a) */`).matchAll(OFFENDER)].length).toBe(0);
    expect(
      [...stripSqlComments(`create function f() as $$ begin -- pg_catalog.nullif(a,b)\n  return 1; end $$;`).matchAll(OFFENDER)]
        .length,
    ).toBe(0);
    // ...and a dollar-quoted BODY is stepped into, not skipped, or every real
    // offender in this repository would be invisible.
    expect(
      [...stripSqlComments(`create function f() as $$ begin v := pg_catalog.coalesce(a, b); end $$;`).matchAll(OFFENDER)]
        .length,
    ).toBe(1);
    // Line numbers survive the blanking.
    expect(stripSqlComments(`-- a\nselect 1;\n`).split("\n")).toHaveLength(3);
  });

  // ===========================================================================
  // The guard's own guards. A grep that matches nothing passes for free, and a
  // grep that matches everything is deleted by the next person who trips it.
  // ===========================================================================
  it("catches the three real historical defects", () => {
    for (const bad of [
      "  v_open := pg_catalog.nullif(current_setting('x', true), '');",
      "  if pg_catalog.coalesce(p_opened, false) then",
      "select pg_catalog.greatest(a, b), PG_CATALOG.LEAST(a, b) from t;",
    ]) {
      expect([...bad.matchAll(OFFENDER)].length).toBeGreaterThan(0);
    }
  });

  it("does not flag the real pg_catalog functions this repo calls", () => {
    const good = [
      "pg_catalog.current_setting('app.x', true)",
      "pg_catalog.set_config('app.x', '', true)",
      "pg_catalog.gen_random_uuid()",
      "pg_catalog.btrim(p_name)",
      "pg_catalog.array_agg(l.company_id)",
      "pg_catalog.array_length(v_lost, 1)",
      "pg_catalog.row_security_active('public.organisations')",
      "pg_catalog.regclass",
      "pg_catalog.substring(x from 1 for 2)",
      "pg_catalog.position('a' in x)",
      "pg_catalog.extract(epoch from now())",
    ].join("\n");
    expect([...good.matchAll(OFFENDER)]).toEqual([]);
  });

  it("only allowlists files whose repair is named", () => {
    const names = readdirSync(MIGRATIONS_DIR);
    for (const [file, reason] of Object.entries(IMMUTABLE_HISTORY)) {
      expect(names, `${file} is allowlisted but does not exist`).toContain(file);
      expect(reason).toMatch(/\.sql/);
    }
  });
});

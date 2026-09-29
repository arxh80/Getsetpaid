import { readdirSync, readFileSync } from "node:fs";
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

/** `--` to end of line, and `/* ... *\/` blocks. Prose is not executed. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

function offendersIn(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (name in IMMUTABLE_HISTORY) continue;
    const lines = stripSqlComments(
      readFileSync(`${dir}/${name}`, "utf8"),
    ).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(OFFENDER)) {
        found.push(`${name}:${i + 1}  ${m[0]}`);
      }
    });
  }
  return found;
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
    const hits = offendersIn(MIGRATIONS_DIR);
    expect(hits, WHY(hits)).toEqual([]);
  });

  it("no psql suite schema-qualifies a construct either", () => {
    const hits = offendersIn(PSQL_TESTS_DIR);
    expect(hits, WHY(hits)).toEqual([]);
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

// THE CATALOGUE BINDINGS READ WHAT IS DEPLOYED (Phase 8 Task 2 re-review, N8).
//
// tests/unit/consent/catalogue.test.ts and tests/unit/org/reserved-slugs.test.ts
// bind TypeScript lists to lists a database function returns. They run in CI
// with no database, so they read each function's LATEST body from the
// migrations (tests/unit/support/sql-definitions.ts). This file closes the gap
// that leaves: against the real database, the body that walk picks must be
// byte-for-byte what `pg_proc.prosrc` holds, and the functions' live OUTPUT
// must equal the TypeScript lists. A re-creation the walker missed, or a
// migration applied out of the order it assumes, is a red test here.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { latestFunctionDefinition } from "../../unit/support/sql-definitions";
import { CONSENT_PURPOSES } from "@/lib/consent/catalogue";
import { RESERVED_WORKSPACE_SLUGS, workspaceSlugKey } from "@/lib/org/reserved-slugs";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl, max: 2 });

afterAll(async () => {
  await pool.end();
});

const BOUND_FUNCTIONS = [
  "private.consent_purposes",
  "private.consent_statements",
  "private.consents_before_insert",
  "private.reserved_workspace_slugs",
  "private.organisations_slug_not_reserved",
  "private.workspace_slug_key",
] as const;

async function prosrc(qualified: string): Promise<string[]> {
  const [schema, name] = qualified.split(".");
  const { rows } = await pool.query<{ prosrc: string }>(
    `select p.prosrc from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.proname = $2`,
    [schema, name],
  );
  return rows.map((r) => r.prosrc);
}

describe("the migration walk picks the body the database runs", () => {
  for (const fn of BOUND_FUNCTIONS) {
    it(`${fn}: one deployed definition, equal to the latest one in the migrations`, async () => {
      const live = await prosrc(fn);
      expect(live, `${fn} is deployed exactly once (no overload the walker would conflate)`).toHaveLength(1);
      // Carriage returns are stripped on both sides: some migrations were
      // committed with CRLF endings, which Postgres stores verbatim and the
      // walker drops -- a difference in line endings is not a stale body.
      expect(live[0].split("\r").join("")).toBe(latestFunctionDefinition(fn).body);
    });
  }
});

describe("the live lists equal the TypeScript lists", () => {
  it("private.consent_purposes() returns CONSENT_PURPOSES", async () => {
    const { rows } = await pool.query<{ purpose: string; category: string; policy_slug: string }>(
      `select purpose, category, policy_slug from private.consent_purposes()`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => ({ purpose: r.purpose, category: r.category, policySlug: r.policy_slug }))).toEqual(
      CONSENT_PURPOSES.map(({ purpose, category, policySlug }) => ({ purpose, category, policySlug })),
    );
  });

  it("private.consent_statements() returns each purpose's statement id", async () => {
    const { rows } = await pool.query<{ purpose: string; statement_id: string }>(
      `select * from private.consent_statements() as s(purpose, statement_id)`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => ({ purpose: r.purpose, statementId: r.statement_id }))).toEqual(
      CONSENT_PURPOSES.map(({ purpose, statementId }) => ({ purpose, statementId })),
    );
  });

  it("private.reserved_workspace_slugs() returns RESERVED_WORKSPACE_SLUGS", async () => {
    const { rows } = await pool.query<{ slug: string }>(`select slug from private.reserved_workspace_slugs() order by slug`);
    expect(rows.map((r) => r.slug)).toEqual([...RESERVED_WORKSPACE_SLUGS].sort());
  });

  it("the form's slug key is the database's key (review N2/N7), on the look-alikes and on plain input", async () => {
    const corpus = [
      "legal",
      " Legal ",
      "LEGAL",
      "\uFF4C\uFF45\uFF47\uFF41\uFF4C",
      "legal\u00A0",
      "legal\t",
      "\nlegal\n",
      "\u3000\uFF33\uFF29\uFF27\uFF2E\uFF35\uFF30",
      "l\u0435gal",
      "\uFB01le",
      "Org-Alpha",
      "org-alpha",
      "",
      "..",
      "_next",
      "legal/x",
    ];
    const { rows } = await pool.query<{ key: string }>(
      `select private.workspace_slug_key(s) as key from unnest($1::text[]) with ordinality as t(s, n) order by n`,
      [corpus],
    );
    expect(rows.map((r) => r.key)).toEqual(corpus.map(workspaceSlugKey));
    // DENOMINATOR: the corpus actually exercises the folding.
    expect(corpus.map(workspaceSlugKey).filter((k) => k === "legal")).toHaveLength(7);
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { latestFunctionDefinition, splitStatements } from "../support/sql-definitions";
import { CONSENT_PURPOSES, MARKETING_EMAIL } from "@/lib/consent/catalogue";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";

// THE CONSENT CATALOGUE: the TypeScript list equals the database's, the
// wording is pinned to its identifier, and consent is asked only where the
// law requires it. Read from the migrations -- each function's LATEST
// definition, by an ordered, parsed walk (tests/unit/support/sql-definitions.ts)
// -- so it runs in CI with no database. The live half is
// tests/integration/legal/catalogue-bindings-match-db.test.ts, which asserts
// the walk picked the body the database actually runs.

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../supabase/migrations/20260923000000_consents.sql", import.meta.url)),
  "utf8",
).split(String.fromCharCode(13)).join("");

/**
 * THE STATEMENT PIN. Each identifier stored in `technical_context.statement`
 * names exactly one sentence, forever. Change the sentence and this is red:
 * the fix is a NEW identifier (marketing-email-2) with its own hash here --
 * never an edited hash, because records already point at the old words.
 */
const STATEMENT_SHA256: Record<string, string> = {
  "marketing-email-1": "de6e48343cc3f09dca3d463beac268b70b034e990e4637a21a46c97f85fbcf65",
};

describe("the consent catalogue", () => {
  it("matches private.consent_purposes() row for row (its LATEST definition)", () => {
    const { body } = latestFunctionDefinition("private.consent_purposes");
    // Every VALUES tuple must be understood -- a row the pattern skipped would
    // make the equality below vacuous for that row.
    expect(
      [...body.matchAll(/\('([a-z_]+)'::text, '([a-z]+)'::text, '([a-z-]+)'::text\)/g)].length,
      "every VALUES tuple in private.consent_purposes() was parsed",
    ).toBe((body.match(/\(/g) ?? []).length);
    const rows = [...body.matchAll(/\('([a-z_]+)'::text, '([a-z]+)'::text, '([a-z-]+)'::text\)/g)].map((m) => ({
      purpose: m[1],
      category: m[2],
      policySlug: m[3],
    }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(
      CONSENT_PURPOSES.map(({ purpose, category, policySlug }) => ({ purpose, category, policySlug })),
    );
  });

  it("asks consent only for what the law requires it for", () => {
    for (const p of CONSENT_PURPOSES) {
      // Strictly necessary storage is PECR-exempt and core processing is
      // contract: neither may ever be a consent purpose.
      expect(p.category, p.purpose).not.toBe("necessary");
    }
    // No analytics vendor is chosen (Q129), so no analytics purpose exists yet.
    expect(CONSENT_PURPOSES.filter((p) => p.category === "analytics")).toEqual([]);
    expect(CONSENT_PURPOSES.map((p) => p.purpose)).toEqual(["marketing_email"]);
  });

  it("each purpose is governed by a real legal document", () => {
    const slugs = LEGAL_DOCUMENTS.map((d) => d.slug as string);
    for (const p of CONSENT_PURPOSES) expect(slugs, p.purpose).toContain(p.policySlug);
    expect(MARKETING_EMAIL.policySlug).toBe("marketing-preferences");
  });

  it("each statement identifier is pinned to its exact wording", () => {
    for (const p of CONSENT_PURPOSES) {
      const hash = createHash("sha256").update(p.statement).digest("hex");
      expect(STATEMENT_SHA256[p.statementId], `${p.statementId} has no recorded hash`).toBeDefined();
      expect(hash, `${p.statementId}'s wording changed -- mint a new identifier`).toBe(
        STATEMENT_SHA256[p.statementId],
      );
    }
  });

  it("each statement identifier satisfies the database's technical_context CHECK", () => {
    // consents_technical_context_bounded: ^[a-z0-9][a-z0-9-]{0,63}$
    expect(MIGRATION).toContain("~ '^[a-z0-9][a-z0-9-]{0,63}$'");
    for (const p of CONSENT_PURPOSES) expect(p.statementId).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  it("the statement says withdrawal is possible, and says nothing about the service", () => {
    expect(MARKETING_EMAIL.statement).toMatch(/withdraw/i);
    // Bundling guard: agreeing to marketing must not read as a condition of,
    // or consent to, the service itself.
    expect(MARKETING_EMAIL.statement).not.toMatch(/terms|privacy|account|workspace|service/i);
  });
});

// THE DATABASE'S STATEMENT LIST (review finding M1, 20260923003000). The
// database refuses a grant whose wording id is not in
// private.consent_statements(); this binds that list to the TypeScript one so
// the two cannot drift, and binds every id the database will accept to a
// SHA-256 pin above, so no id can be grantable without its exact words.
describe("the consent wording list is the same in the database and in TypeScript", () => {
  const { file, body } = latestFunctionDefinition("private.consent_statements");
  const rows = [...body.matchAll(/\('([a-z_]+)'::text, '([a-z0-9-]+)'::text\)/g)].map((m) => ({
    purpose: m[1],
    statementId: m[2],
  }));

  it("DENOMINATOR: the latest definition was found and parsed", () => {
    expect(file >= "20260923003000").toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // Every VALUES tuple was understood -- a row the pattern skipped would
    // make the equality below vacuous for that row.
    expect(rows.length).toBe((body.match(/\(/g) ?? []).length);
  });

  it("private.consent_statements() lists exactly the statement each purpose shows", () => {
    expect(rows).toEqual(CONSENT_PURPOSES.map(({ purpose, statementId }) => ({ purpose, statementId })));
  });

  it("every id the database accepts is pinned to its words", () => {
    for (const r of rows) expect(STATEMENT_SHA256[r.statementId], r.statementId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the trigger that enforces the list is the latest before-insert definition", () => {
    const trigger = latestFunctionDefinition("private.consents_before_insert");
    expect(trigger.file >= "20260923003000").toBe(true);
    expect(trigger.body).toContain("private.consent_statements()");
    expect(trigger.body).toContain("hint = 'missing_statement'");
    expect(trigger.body).toContain("hint = 'unknown_statement'");
  });
});

// THE WALKER ITSELF (review N8): the shapes a text regex got wrong.
describe("latestFunctionDefinition reads the latest body, parsed", () => {
  const m = (file: string, text: string) => ({ file, text });

  it("FIXTURE: a later CREATE FUNCTION with odd spacing, quoted names and a $body$ tag wins", () => {
    const found = latestFunctionDefinition("private.x", [
      m("1.sql", "create or replace function private.x() returns int language sql as $$ select 1 $$;"),
      m("2.sql", 'CREATE   FUNCTION\n  "private" . "x" ( ) RETURNS int LANGUAGE sql AS $body$ select 2 $$ $body$;'),
    ]);
    expect(found).toEqual({ file: "2.sql", body: " select 2 $$ " });
  });

  it("FIXTURE: a commented-out or quoted copy is not a definition", () => {
    const found = latestFunctionDefinition("private.x", [
      m("1.sql", "create or replace function private.x() returns int language sql as $$ select 1 $$;"),
      m(
        "2.sql",
        [
          "-- create or replace function private.x() returns int language sql as $$ select 9 $$;",
          "/* create function private.x() as $$ select 8 $$; /* nested */ still comment */",
          "select 'create or replace function private.x() as $$ select 7 $$';",
          "comment on function private.x() is 'create function private.x() $$ select 6 $$';",
          "do $$ begin execute 'create function private.x() returns int as $q$ select 5 $q$'; end $$;",
        ].join("\n"),
      ),
    ]);
    expect(found).toEqual({ file: "1.sql", body: " select 1 " });
  });

  it("FIXTURE: a later drop or rename clears it; a re-create after that is found", () => {
    const create = (v: number) => `create or replace function private.x() returns int language sql as $$ select ${v} $$;`;
    expect(() =>
      latestFunctionDefinition("private.x", [m("1.sql", create(1)), m("2.sql", "drop function if exists private.x();")]),
    ).toThrow(/defined in no migration/);
    expect(() =>
      latestFunctionDefinition("private.x", [m("1.sql", create(1)), m("2.sql", "alter function private.x() rename to y;")]),
    ).toThrow(/defined in no migration/);
    expect(
      latestFunctionDefinition("private.x", [m("1.sql", create(1)), m("2.sql", "drop function private.x()"), m("3.sql", create(3))]),
    ).toEqual({ file: "3.sql", body: " select 3 " });
  });

  it("FIXTURE: a similarly named function is not it", () => {
    const found = latestFunctionDefinition("private.x", [
      m("1.sql", "create function private.x() returns int language sql as $$ select 1 $$;"),
      m("2.sql", "create function private.x_two() returns int language sql as $$ select 2 $$; create function other.x() returns int language sql as $$ select 3 $$;"),
    ]);
    expect(found.body).toBe(" select 1 ");
  });

  it("the lexer splits every real migration without error, and finds the statements it should", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../supabase/migrations/20260923003000_consents_statement_pinned.sql", import.meta.url)),
      "utf8",
    );
    const heads = splitStatements(text.split(String.fromCharCode(13)).join("")).map((s) => s.head.replace(/\s+/g, " ").trim());
    expect(heads.filter((h) => /^create or replace function private\.consent_statements\(\)/.test(h))).toHaveLength(1);
    expect(latestFunctionDefinition("private.consent_statements").file).toBe("20260923003000_consents_statement_pinned.sql");
  });
});

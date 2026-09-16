import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONSENT_PURPOSES, MARKETING_EMAIL } from "@/lib/consent/catalogue";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";

// THE CONSENT CATALOGUE: the TypeScript list equals the database's, the
// wording is pinned to its identifier, and consent is asked only where the
// law requires it. Read from the migration file, so it runs in CI with no
// database (the live half is tests/integration/legal/consents.test.ts).

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
  it("matches private.consent_purposes() row for row", () => {
    const body = /create or replace function private\.consent_purposes\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(MIGRATION)?.[1];
    expect(body, "private.consent_purposes() not found").toBeTruthy();
    const rows = [...body!.matchAll(/\('([a-z_]+)'::text, '([a-z]+)'::text, '([a-z-]+)'::text\)/g)].map((m) => ({
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
function latestDefinition(fn: string): { file: string; body: string } {
  const dir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let found: { file: string; body: string } | null = null;
  const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`create or replace function ${escaped}\\(\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`);
  for (const file of files) {
    const text = readFileSync(`${dir}${file}`, "utf8").split(String.fromCharCode(13)).join("");
    const m = pattern.exec(text);
    if (m) found = { file, body: m[1] };
  }
  if (!found) throw new Error(`${fn} is defined in no migration`);
  return found;
}

describe("the consent wording list is the same in the database and in TypeScript", () => {
  const { file, body } = latestDefinition("private.consent_statements");
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
    const trigger = latestDefinition("private.consents_before_insert");
    expect(trigger.file >= "20260923003000").toBe(true);
    expect(trigger.body).toContain("private.consent_statements()");
    expect(trigger.body).toContain("hint = 'missing_statement'");
    expect(trigger.body).toContain("hint = 'unknown_statement'");
  });
});

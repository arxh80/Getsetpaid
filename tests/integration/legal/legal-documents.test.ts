// THE LIVE DATABASE AND THE APP AGREE ABOUT THE LEGAL DOCUMENT STORE.
//
// tests/unit/legal/seed-matches-catalogue.test.ts reads the MIGRATION TEXT;
// this reads what is DEPLOYED (pg_constraint, the rows themselves), because a
// later migration can replace a constraint and what is live is what decides.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";
import { KNOWN_TOKENS, parseLegalMarkup } from "@/lib/legal/markup";
import { REQUIRED_PLACEHOLDERS } from "@/lib/legal/draft-validation";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

async function constraintDef(name: string): Promise<string> {
  const { rows } = await pool.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.legal_documents'::regclass and conname = $1`,
    [name],
  );
  expect(rows, `constraint ${name} is not on the live table`).toHaveLength(1);
  return rows[0].def;
}

describe("the live legal_documents constraints mirror the app", () => {
  it("the slug CHECK admits exactly the catalogue's fifteen", async () => {
    const def = await constraintDef("legal_documents_slug_known");
    const slugs = [...def.matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]).sort();
    expect(slugs).toEqual(LEGAL_DOCUMENTS.map((d) => d.slug).sort());
  });

  it("the placeholder CHECK admits exactly the parser's tokens", async () => {
    const def = await constraintDef("legal_documents_body_tokens_known");
    const inner = /\(\?!\(([^)]*)\)/.exec(def)?.[1];
    expect(inner, def).toBeTruthy();
    expect(inner!.split("|").map((t) => `{{${t}}}`).sort()).toEqual([...KNOWN_TOKENS].sort());
  });

  it("the required-placeholder CHECK names each document the app requires one of", async () => {
    const def = await constraintDef("legal_documents_required_blocks");
    for (const [slug, tokens] of Object.entries(REQUIRED_PLACEHOLDERS)) {
      expect(def, slug).toContain(`'${slug}'`);
      for (const token of tokens ?? []) expect(def, `${slug} ${token}`).toContain(token);
    }
  });
});

describe("the live seed", () => {
  it("holds one current published version of every catalogue document", async () => {
    const { rows } = await pool.query<{ slug: string; n: number }>(
      `select slug, count(*)::int as n from public.legal_documents
        where status = 'published' group by slug order by slug`,
    );
    expect(rows.map((r) => r.slug)).toEqual(LEGAL_DOCUMENTS.map((d) => d.slug).sort());
    expect(rows.every((r) => r.n === 1)).toBe(true);
  });

  it("every current version parses with nothing dropped", async () => {
    const { rows } = await pool.query<{ slug: string; body: string }>(
      `select slug, body from public.legal_documents where status = 'published'`,
    );
    expect(rows.length).toBe(15);
    for (const row of rows) {
      expect(parseLegalMarkup(row.body).problems, row.slug).toEqual([]);
    }
  });
});

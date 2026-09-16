import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGAL_DOCUMENTS, type LegalSlug } from "@/lib/legal/documents";
import { validateDraft } from "@/lib/legal/draft-validation";
import { KNOWN_TOKENS } from "@/lib/legal/markup";

// THE SEED, THE CHECK CONSTRAINT AND THE CATALOGUE AGREE -- read from the
// migration files, so this runs in CI with no database. (The live-database
// half is tests/integration/legal/legal-documents.test.ts.)
//
// And the seed bodies are valid under the SAME save-time validation the
// editor applies: a seed the editor would refuse to save is a seed counsel
// could not edit and re-save unchanged.

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
const schema = readFileSync(`${MIGRATIONS}20260922000000_legal_documents.sql`, "utf8");
const seed = readFileSync(`${MIGRATIONS}20260922001000_legal_documents_seed.sql`, "utf8");

interface SeedRow {
  slug: string;
  version: number;
  title: string;
  body: string;
}

function seedRows(): SeedRow[] {
  const rows: SeedRow[] = [];
  const pattern =
    /\('([a-z-]+)',\s*(\d+),\s*'((?:[^']|'')*)',\s*\(now\(\) at time zone 'Europe\/London'\)::date,\s*\$body\$\n([\s\S]*?)\$body\$\)/g;
  for (const m of seed.matchAll(pattern)) {
    rows.push({ slug: m[1], version: Number(m[2]), title: m[3].replaceAll("''", "'"), body: m[4] });
  }
  return rows;
}

describe("the legal document seed", () => {
  const rows = seedRows();

  it("seeds exactly the fifteen catalogue slugs, once each, as version 1", () => {
    expect(rows.map((r) => r.slug).sort()).toEqual(LEGAL_DOCUMENTS.map((d) => d.slug).sort());
    expect(new Set(rows.map((r) => r.slug)).size).toBe(15);
    expect(rows.every((r) => r.version === 1)).toBe(true);
  });

  it("titles each document as the catalogue does", () => {
    const titles = new Map(LEGAL_DOCUMENTS.map((d) => [d.slug as string, d.title as string]));
    for (const row of rows) expect(row.title, row.slug).toBe(titles.get(row.slug));
  });

  it.each(LEGAL_DOCUMENTS.map((d) => d.slug))(
    "%s passes the editor's own save-time validation",
    (slug) => {
      const row = rows.find((r) => r.slug === slug);
      expect(row, `${slug} is not in the seed`).toBeDefined();
      const result = validateDraft(slug as LegalSlug, {
        title: row!.title,
        body: row!.body,
        effectiveDate: "2026-09-22",
      });
      expect(result.ok ? {} : result.fieldErrors).toEqual({});
    },
  );

  it("commits no email address -- the contact comes from configuration", () => {
    expect(seed).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(seed).not.toMatch(/mailto:/i);
    // ...and the two pages that exist to give one do use the placeholder.
    for (const slug of ["contact", "vulnerability-disclosure"]) {
      expect(rows.find((r) => r.slug === slug)?.body).toContain("{{support_email}}");
    }
  });

  it("publishes by transition and never records a counsel review", () => {
    expect(seed).not.toMatch(/counsel_review/);
    expect(seed).toMatch(/set status = 'published'/);
  });

  it("the AI Use Policy is the placeholder PRD §12 asks for", () => {
    expect(rows.find((r) => r.slug === "ai-use")?.body).toMatch(/does not use AI/);
  });
});

describe("the schema migration mirrors the app's closed sets", () => {
  it("the slug CHECK lists exactly the catalogue", () => {
    const check = /constraint legal_documents_slug_known check \(slug in \(([\s\S]*?)\)\)/.exec(schema)?.[1];
    expect(check, "legal_documents_slug_known not found").toBeTruthy();
    const slugs = [...check!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
    expect(slugs).toEqual(LEGAL_DOCUMENTS.map((d) => d.slug).sort());
  });

  it("the placeholder CHECK lists exactly the parser's tokens", () => {
    const check = /legal_documents_body_tokens_known\s+check \(body !~ '\\\{\\\{\(\?!\(([^)]*)\)/.exec(schema)?.[1];
    expect(check, "legal_documents_body_tokens_known not found").toBeTruthy();
    expect(check!.split("|").map((t) => `{{${t}}}`).sort()).toEqual([...KNOWN_TOKENS].sort());
  });
});

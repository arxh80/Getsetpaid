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

// ===========================================================================
// FIX ROUND 1: VERSION 2 OF FOUR PAGES (20260922005000)
// ===========================================================================
// The migration builds each corrected body from the CURRENT published one by
// exact replacement (security is written whole). Rebuilt here from the two
// migration files, so the bodies the database will publish are validated,
// and read for the overclaims they exist to remove, with no database.
const corrections = readFileSync(`${MIGRATIONS}20260922005000_legal_documents_v2_corrections.sql`, "utf8");

function correctedBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  const sections = corrections.split("select body into strict v_current").slice(1);
  for (const section of sections) {
    const slug = /where slug = '([a-z-]+)'/.exec(section)?.[1];
    if (!slug) throw new Error("20260922005000: a correction section names no slug");
    let body = seedRows().find((r) => r.slug === slug)?.body;
    if (body === undefined) throw new Error(`20260922005000: ${slug} is not in the seed`);
    for (const m of section.matchAll(/replace\(v_current,\n\$t\$([\s\S]*?)\$t\$,\n\$t\$([\s\S]*?)\$t\$\)/g)) {
      if (!body.includes(m[1])) throw new Error(`20260922005000: ${slug}: a replaced passage is not in the seed`);
      body = body.replace(m[1], m[2]);
    }
    bodies.set(slug, body);
  }
  const security = /insert into legal_v2 values \('security', \$t\$\n([\s\S]*?)\$t\$\);/.exec(corrections)?.[1];
  if (!security) throw new Error("20260922005000: no security body");
  bodies.set("security", `\n${security}`);
  return bodies;
}

describe("version 2 of the four corrected pages", () => {
  const bodies = correctedBodies();
  const titles = new Map(LEGAL_DOCUMENTS.map((d) => [d.slug as string, d.title as string]));

  it("corrects exactly the four pages the review named, each with at least one replacement", () => {
    expect([...bodies.keys()].sort()).toEqual(["data-processing-addendum", "data-retention", "privacy", "security"]);
    for (const [slug, body] of bodies) {
      expect(body, slug).not.toBe(seedRows().find((r) => r.slug === slug)?.body);
    }
  });

  it.each(["data-processing-addendum", "data-retention", "privacy", "security"])(
    "%s version 2 passes the editor's own save-time validation",
    (slug) => {
      const result = validateDraft(slug as LegalSlug, {
        title: titles.get(slug) ?? "",
        body: bodies.get(slug) ?? "",
        effectiveDate: "2026-09-22",
      });
      expect(result.ok ? {} : result.fieldErrors).toEqual({});
    },
  );

  it("I2: the security page states no hosted-configuration control or vendor claim as bare fact", () => {
    const body = bodies.get("security")!;
    for (const overclaim of [
      "is checked at every sign-in",
      "You are signed out after 30 minutes without activity.",
      "and the account holder is emailed",
      "which encrypts stored data",
      "We monitor the alerts above",
    ]) {
      expect(body, overclaim).not.toContain(overclaim);
    }
    // ONE RULE, EVERY SENTENCE: a list item or paragraph naming a control
    // that SECURITY.md § 15 says depends on hosted configuration carries the
    // marker; the provider's encryption claim is the provider's.
    const dependent = /Google|two-factor settings|server|12 hours|locked|email|region/i;
    const units = body.split("\n").filter((line) => dependent.test(line) && !line.startsWith("##"));
    expect(units.length).toBeGreaterThanOrEqual(6);
    for (const line of units) {
      if (/Supabase states/.test(line)) continue;
      if (/Information Commissioner/.test(line)) continue; // a commitment, not a control
      if (/^\[Counsel to confirm|^- \[Counsel to confirm/.test(line)) continue;
      expect(line, line).toContain("(deployment setting)");
    }
    expect(body).toMatch(/Supabase states that it encrypts stored data[^.]*\. We rely on that statement; we have not verified it ourselves\./);
    expect(body).toContain("12 hours");
  });

  it("M1: neither transfer page asserts that nothing leaves the UK/EEA, and both name the two open facts", () => {
    for (const slug of ["privacy", "data-processing-addendum"]) {
      const body = bodies.get(slug)!;
      expect(body, slug).not.toMatch(/do not transfer personal data outside|only subprocessor outside the UK/);
      expect(body, slug).toMatch(/\[Counsel to confirm: [^\]]*Supabase, Inc\.[^\]]*United States[^\]]*application servers[^\]]*\]/);
    }
  });

  it("M2: the retention page states the audit windows as a target, not as what happens", () => {
    const body = bodies.get("data-retention")!;
    expect(body).not.toContain("outside the default view");
    expect(body).toContain("Neither limit is applied yet");
  });

  it("commits no email address and records no counsel review", () => {
    expect(corrections).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(corrections).not.toMatch(/mailto:/i);
    expect(corrections).not.toMatch(/set\s+counsel_review|counsel_reviewer\s*=|counsel_review_recorded_by\s*=/);
    expect(corrections).toMatch(/set status = 'published'/);
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

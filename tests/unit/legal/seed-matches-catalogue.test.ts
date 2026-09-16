import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGAL_DOCUMENTS, type LegalSlug } from "@/lib/legal/documents";
import { validateDraft } from "@/lib/legal/draft-validation";
import { KNOWN_TOKENS } from "@/lib/legal/markup";
import { SUB_PROCESSORS } from "@/lib/legal/sub-processors";

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

/**
 * Apply one corrections migration's exact-replacement sections to `base`
 * (the bodies each section's `select ... where status = 'published'` would
 * read). Returns only the slugs that migration corrects.
 */
function applyCorrections(sql: string, base: ReadonlyMap<string, string>, file: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const sections = sql.split("select body into strict v_current").slice(1);
  for (const section of sections) {
    const slug = /where slug = '([a-z-]+)'/.exec(section)?.[1];
    if (!slug) throw new Error(`${file}: a correction section names no slug`);
    let body = base.get(slug);
    if (body === undefined) throw new Error(`${file}: ${slug} has no current body`);
    let replaced = 0;
    for (const m of section.matchAll(/replace\(v_current,\n\$t\$([\s\S]*?)\$t\$,\n\$t\$([\s\S]*?)\$t\$\)/g)) {
      if (!body.includes(m[1])) throw new Error(`${file}: ${slug}: a replaced passage is not in the current body`);
      body = body.replace(m[1], m[2]);
      replaced++;
    }
    if (replaced === 0) throw new Error(`${file}: ${slug}: no replacement found`);
    bodies.set(slug, body);
  }
  return bodies;
}

function seedBodies(): Map<string, string> {
  return new Map(seedRows().map((r) => [r.slug, r.body]));
}

function correctedBodies(): Map<string, string> {
  const bodies = applyCorrections(corrections, seedBodies(), "20260922005000");
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

// ===========================================================================
// FIX ROUND 2: ONE CONSISTENT STORY ABOUT HOSTING AND TRANSFERS (20260922006000)
// ===========================================================================
// Subprocessors v2, Privacy v3 and DPA v3, rebuilt from the three migration
// files; then EVERY page's current published body is checked, together with
// the generated Subprocessors table, for the statements fix round 1 left
// contradicting each other: the hosting region stated as bare fact, a
// transfer position (either way) stated as settled, and the Subprocessors
// page claiming to be complete.
const consistency = readFileSync(
  `${MIGRATIONS}20260922006000_legal_documents_hosting_and_transfer_consistency.sql`,
  "utf8",
);

function currentBodies(): Map<string, string> {
  const current = seedBodies();
  for (const [slug, body] of correctedBodies()) current.set(slug, body);
  for (const [slug, body] of applyCorrections(consistency, current, "20260922006000")) current.set(slug, body);
  return current;
}

/** A line that states where data is hosted. */
const HOSTING = /\b(UK\/EU|UK\/EEA|EU\/UK)\b[^.]*\bregion\b|\bhosted (in|within) the (UK|EU|EEA)\b/i;
/** A transfer position stated as settled, in either direction. */
const SETTLED_TRANSFER =
  /do not transfer|does not transfer|no (international |restricted )?transfer|not transferred|never (leaves|transferred)|only subprocessor outside|stays? (in|within) the UK|is transferred (to|outside)/i;
/** The v1 Subprocessors completeness claim, and its obvious rewordings. */
const COMPLETENESS = /before it receives any personal data|lists? every (provider|third party)|this list is complete/i;

/** Each line of `body` that breaks the rule, labelled. */
function unqualified(body: string): string[] {
  const failures: string[] = [];
  for (const line of body.split("\n")) {
    const gap = /^(- )?\[Counsel to (confirm|draft)/.test(line.trim());
    if (HOSTING.test(line) && !line.includes("(deployment setting)") && !gap) failures.push(`region: ${line}`);
    if (SETTLED_TRANSFER.test(line) && !gap) failures.push(`transfer: ${line}`);
    if (COMPLETENESS.test(line)) failures.push(`completeness: ${line}`);
  }
  return failures;
}

describe("fix round 2: every published page says one thing about hosting and transfers", () => {
  const current = currentBodies();
  const titles = new Map(LEGAL_DOCUMENTS.map((d) => [d.slug as string, d.title as string]));

  it("20260922006000 corrects exactly subprocessors, privacy and the DPA", () => {
    const before = new Map([...seedBodies(), ...correctedBodies()]);
    const corrected = applyCorrections(consistency, before, "20260922006000");
    expect([...corrected.keys()].sort()).toEqual(["data-processing-addendum", "privacy", "subprocessors"]);
    for (const [slug, body] of corrected) expect(body, slug).not.toBe(before.get(slug));
  });

  it.each(["data-processing-addendum", "privacy", "subprocessors"])(
    "%s, as now published, passes the editor's own save-time validation",
    (slug) => {
      const result = validateDraft(slug as LegalSlug, {
        title: titles.get(slug) ?? "",
        body: current.get(slug) ?? "",
        effectiveDate: "2026-09-22",
      });
      expect(result.ok ? {} : result.fieldErrors).toEqual({});
    },
  );

  it("DENOMINATOR: the rule finds what fix round 1 left behind, so a pass below means something", () => {
    const before = new Map([...seedBodies(), ...correctedBodies()]);
    // Privacy v2 and DPA v2 stated the region flat; Subprocessors v1 claimed
    // completeness; the seeded Privacy v1 settled the transfer question.
    expect(unqualified(before.get("privacy")!).some((f) => f.startsWith("region:"))).toBe(true);
    expect(unqualified(before.get("data-processing-addendum")!).some((f) => f.startsWith("region:"))).toBe(true);
    expect(unqualified(before.get("subprocessors")!).some((f) => f.startsWith("completeness:"))).toBe(true);
    expect(unqualified(seedBodies().get("privacy")!).some((f) => f.startsWith("transfer:"))).toBe(true);
    // The old generated row fails it too.
    expect(unqualified("UK/EU region only. No international transfer: the data is hosted in the UK/EU region.")).toHaveLength(2);
    // And the hosting sentences it must judge are really there today (the
    // Subprocessors page's own region statement is in its generated table,
    // judged in the next test).
    const hostingPages = [...current].filter(([, body]) => body.split("\n").some((l) => HOSTING.test(l)));
    expect(hostingPages.map(([slug]) => slug).sort()).toEqual(["data-processing-addendum", "privacy", "security"]);
  });

  it.each(LEGAL_DOCUMENTS.map((d) => d.slug))(
    "%s states neither the region nor a transfer position as unqualified fact",
    (slug) => {
      const body = current.get(slug);
      expect(body, `${slug} has no current body`).toBeDefined();
      expect(unqualified(body!)).toEqual([]);
    },
  );

  it("the generated Subprocessors table follows the same rule", () => {
    expect(SUB_PROCESSORS.length).toBeGreaterThan(0);
    for (const vendor of SUB_PROCESSORS) {
      // The table renders "<location>. <transferBasis>" in one cell.
      expect(unqualified(`${vendor.location}. ${vendor.transferBasis}`), vendor.name).toEqual([]);
    }
    const supabase = SUB_PROCESSORS.find((v) => v.name === "Supabase, Inc.");
    expect(supabase?.location).toContain("United States");
    expect(supabase?.location).toContain("(deployment setting)");
    expect(supabase?.transferBasis).toMatch(/^Not yet confirmed/);
    expect(supabase?.dpaSigned).toBe(false);
  });

  it("the three transfer-facing pages each name both open facts in a counsel gap", () => {
    for (const slug of ["privacy", "data-processing-addendum", "subprocessors"]) {
      expect(current.get(slug), slug).toMatch(
        /\[Counsel to confirm: (?=[^\]]*United States)(?=[^\]]*application servers)[^\]]*\]/,
      );
    }
  });

  it("the Subprocessors page admits it is incomplete", () => {
    expect(current.get("subprocessors")).toContain("This list is not complete yet.");
  });

  it("commits no email address and records no counsel review", () => {
    expect(consistency).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(consistency).not.toMatch(/mailto:/i);
    expect(consistency).not.toMatch(/set\s+counsel_review|counsel_reviewer\s*=|counsel_review_recorded_by\s*=/);
    expect(consistency).toMatch(/set status = 'published'/);
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

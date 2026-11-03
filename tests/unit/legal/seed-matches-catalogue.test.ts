import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readMigrations, type MigrationText } from "../support/sql-definitions";
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
// Line endings normalised: a Windows checkout with core.autocrlf writes CRLF,
// and the parsers below match on LF.
const CR = String.fromCharCode(13);
const readMigration = (name: string) =>
  readFileSync(`${MIGRATIONS}${name}`, "utf8").split(CR).join("");
const schema = readMigration("20260922000000_legal_documents.sql");
const seed = readMigration("20260922001000_legal_documents_seed.sql");

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
const corrections = readMigration("20260922005000_legal_documents_v2_corrections.sql");

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
    // `v_current` or `v_next`: a migration that makes TWO replacements to one
    // page chains them (20260924002000), and a parser that only knew the first
    // name would silently apply half a correction and then assert against it.
    for (const m of section.matchAll(/replace\(v_(?:current|next),\n\$t\$([\s\S]*?)\$t\$,\n\$t\$([\s\S]*?)\$t\$\)/g)) {
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
const consistency = readMigration("20260922006000_legal_documents_hosting_and_transfer_consistency.sql");

// Phase 8 Task 2: Marketing and Communications Preferences v2 (20260923001000),
// same exact-replacement shape. Applied here so "every page's current body"
// below is still every page's CURRENT body.
const marketingV2 = readMigration("20260923001000_marketing_preferences_v2.sql");

// Phase 8 Task 3: Your Data Protection Rights v2 (20260924002000), same exact-
// replacement shape. Applied here for the same reason.
const dsrV2 = readMigration("20260924002000_data_subject_rights_v2.sql");

// Phase 8 Task 3 fix round 1: Your Data Protection Rights v3 (20260925004000),
// the same exact-replacement shape again. Version 2 is published and
// therefore immutable, so the review's three corrections are a new version.
const dsrV3 = readMigration("20260925004000_data_subject_rights_v3.sql");

// ===========================================================================
// EVERY PAGE'S CURRENT BODY, DERIVED FROM THE MIGRATION WALK
// (Phase 8 Task 6 scoped re-review, m-N7)
// ===========================================================================
// currentBodies() used to chain five named migrations and stop at
// 20260925004000 -- four legal-page migrations short of the truth by the time
// the re-review read it (DPA v4, rights v5, retention v3-v6 had never been
// read by the consistency rule below). The census-audit class exactly: a
// derivation with a hand-typed end. It let nothing through (the re-review
// applied the three regexes to all fifteen live bodies: 0 violations) but it
// could not have said so.
//
// So the chain is DERIVED: every migration after the seed, in filename order
// (the order the CLI applies them), that publishes a body -- recognised by
// the one insert column list every publisher in this repository uses -- is
// applied in one of the three shapes a publisher takes:
//   (a) exact replacement:  select body into strict v_current ... where slug =
//       '<slug>' ... replace(v_current|v_next, $t$old$t$, $t$new$t$)
//   (b) whole body, staged: insert into legal_v2 values ('<slug>', $t$...$t$)
//   (c) whole body, declared: v_body text := $t$...$t$ with one slug named
// and a publisher matching NONE of them throws, naming the file -- a loud
// refusal is a red test; a stale body is a green test over the wrong page.
// The denominator is pinned below (the files walked and the slugs they
// touched), and a PLANTED migration is proved to be read.

const SEED_FILE = "20260922001000_legal_documents_seed.sql";
/** The insert every body-publishing migration in this repository issues. The
 *  RPCs' own inserts (20260922000000) name a different column list. */
const PUBLISHER = /insert into public\.legal_documents \(slug, version, title, effective_date, body\)/;

/** Whether a migration publishes at least one legal document body. */
function publishesLegalBodies(text: string): boolean {
  return PUBLISHER.test(text);
}

/** Apply one publishing migration, in whichever of the three shapes it takes. */
function applyLegalMigration(file: string, text: string, current: Map<string, string>): string[] {
  const touched: string[] = [];
  let recognised = 0;
  if (text.includes("select body into strict v_current")) {
    for (const [slug, body] of applyCorrections(text, current, file)) {
      current.set(slug, body);
      touched.push(slug);
    }
    recognised++;
  }
  for (const m of text.matchAll(/insert into legal_v2 values \('([a-z-]+)', \$t\$\n([\s\S]*?)\$t\$\);/g)) {
    current.set(m[1], `\n${m[2]}`);
    touched.push(m[1]);
    recognised++;
  }
  const whole = /v_body\s+text\s*:=\s*\$t\$([\s\S]*?)\$t\$;/.exec(text);
  if (whole) {
    const slugs = [...new Set([...text.matchAll(/where slug = '([a-z-]+)'/g)].map((m) => m[1]))];
    if (slugs.length !== 1) throw new Error(`${file}: a whole-body publisher must name exactly one slug (found ${slugs.join(", ")})`);
    if (!current.has(slugs[0])) throw new Error(`${file}: ${slugs[0]} has no current body`);
    current.set(slugs[0], whole[1]);
    touched.push(slugs[0]);
    recognised++;
  }
  if (recognised === 0) {
    throw new Error(
      `${file} publishes a legal document body in a shape this walk does not recognise. ` +
        "Every page's current body is rebuilt from the migrations so the consistency rule reads what is live; " +
        "teach applyLegalMigration() the new shape, or the rule checks a stale page.",
    );
  }
  return touched;
}

interface LegalWalk {
  bodies: Map<string, string>;
  /** Every publishing migration applied, in order, with the slugs it touched. */
  applied: { file: string; slugs: string[] }[];
}

/**
 * Every page's current body: the seed, then every publishing migration in
 * filename order. `before` stops the walk (exclusive) at that file name.
 */
function walkLegalBodies(migrations: MigrationText[] = readMigrations(), before?: string): LegalWalk {
  const bodies = seedBodies();
  const applied: { file: string; slugs: string[] }[] = [];
  for (const { file, text } of migrations) {
    if (file <= SEED_FILE) continue;
    if (before !== undefined && file >= before) break;
    if (!publishesLegalBodies(text)) continue;
    applied.push({ file, slugs: applyLegalMigration(file, text, bodies) });
  }
  return { bodies, applied };
}

/** Every page's current body as it stood before version 3 of the DSR page. */
function currentBodiesBeforeV3(): Map<string, string> {
  return walkLegalBodies(readMigrations(), "20260925004000_data_subject_rights_v3.sql").bodies;
}

function currentBodies(): Map<string, string> {
  return walkLegalBodies().bodies;
}

describe("m-N7: the current bodies are derived from every publishing migration, not a named chain", () => {
  const walk = walkLegalBodies();

  it("DENOMINATOR: the files walked and the slugs each touched, pinned -- a new publisher is a red line here", () => {
    expect(walk.applied).toEqual([
      { file: "20260922005000_legal_documents_v2_corrections.sql", slugs: ["privacy", "data-processing-addendum", "data-retention", "security"] },
      { file: "20260922006000_legal_documents_hosting_and_transfer_consistency.sql", slugs: ["subprocessors", "privacy", "data-processing-addendum"] },
      { file: "20260923001000_marketing_preferences_v2.sql", slugs: ["marketing-preferences"] },
      { file: "20260924002000_data_subject_rights_v2.sql", slugs: ["data-subject-rights"] },
      { file: "20260925004000_data_subject_rights_v3.sql", slugs: ["data-subject-rights"] },
      // The four the hand-typed chain never read (re-review, m-N7).
      { file: "20260927008000_legal_pages_describe_export.sql", slugs: ["data-processing-addendum", "data-subject-rights", "data-retention"] },
      { file: "20260930009000_legal_pages_describe_erasure.sql", slugs: ["data-subject-rights", "data-retention"] },
      { file: "20261003009000_legal_retention_job_runs.sql", slugs: ["data-retention"] },
      { file: "20261004006000_legal_retention_says_what_is_not_deleted.sql", slugs: ["data-retention"] },
      // Task 9a (founder 2026-09-30, Q142/Q145, with Q187's clause).
      {
        file: "20261008000000_legal_pages_name_the_hosts.sql",
        slugs: ["privacy", "data-processing-addendum", "security", "subprocessors", "data-retention"],
      },
      // Phase 9 Task 3: the retention page states the two integration periods.
      { file: "20261030004000_legal_retention_names_integrations.sql", slugs: ["data-retention"] },
      // Phase 8 owed (final review B, F1) with Q42: subprocessors 4 names the self-hosted scanner.
      { file: "20261102000000_legal_subprocessors_names_the_scanner.sql", slugs: ["subprocessors"] },
    ]);
    // Seven distinct slugs have a version past 1; the other eight are still
    // their seed. Fifteen bodies either way.
    expect(new Set(walk.applied.flatMap((a) => a.slugs)).size).toBe(7);
    expect(walk.bodies.size).toBe(15);
  });

  it("the walk agrees with the hand-typed chain it replaces, up to where that chain stopped", () => {
    const chain = seedBodies();
    for (const [slug, body] of correctedBodies()) chain.set(slug, body);
    for (const [slug, body] of applyCorrections(consistency, chain, "20260922006000")) chain.set(slug, body);
    for (const [slug, body] of applyCorrections(marketingV2, chain, "20260923001000")) chain.set(slug, body);
    for (const [slug, body] of applyCorrections(dsrV2, chain, "20260924002000")) chain.set(slug, body);
    for (const [slug, body] of applyCorrections(dsrV3, chain, "20260925004000")) chain.set(slug, body);
    expect(walkLegalBodies(readMigrations(), "20260927008000_legal_pages_describe_export.sql").bodies).toEqual(chain);
  });

  it("reads past where the chain stopped: the data-retention body is v6's, which says what is NOT deleted", () => {
    expect(walk.bodies.get("data-retention")).toContain("## What is not deleted automatically");
    expect(walk.bodies.get("data-subject-rights")).toContain("## Deleting your account");
  });

  it("PLANTED: a publishing migration added after the last real one is read and applied", () => {
    const planted: MigrationText = {
      file: "20991231000000_planted_ai_use_v2.sql",
      text: [
        "do $$ declare v_current text; v_next text; begin",
        "  select body into strict v_current",
        "    from public.legal_documents where slug = 'ai-use' and status = 'published';",
        "  v_next := replace(v_current,",
        "$t$does not use AI$t$,",
        "$t$does not use AI (planted by seed-matches-catalogue.test.ts)$t$);",
        "end $$;",
        "insert into public.legal_documents (slug, version, title, effective_date, body)",
        "select p.slug, p.version + 1, p.title, (now() at time zone 'Europe/London')::date, v.body from p, v;",
        "update public.legal_documents set status = 'published' where slug = 'ai-use';",
      ].join("\n"),
    };
    const { bodies, applied } = walkLegalBodies([...readMigrations(), planted]);
    expect(applied.at(-1)).toEqual({ file: planted.file, slugs: ["ai-use"] });
    expect(bodies.get("ai-use")).toContain("(planted by seed-matches-catalogue.test.ts)");
    expect(walk.bodies.get("ai-use")).not.toContain("(planted by");
  });

  it("PLANTED: a publishing migration in a shape the walk does not recognise is a loud refusal, not a stale page", () => {
    const planted: MigrationText = {
      file: "20991231000001_planted_unknown_shape.sql",
      text: [
        "insert into public.legal_documents (slug, version, title, effective_date, body)",
        "values ('ai-use', 99, 'AI Use Policy', current_date, 'a body written in a way nobody taught the walk');",
      ].join("\n"),
    };
    expect(() => walkLegalBodies([...readMigrations(), planted])).toThrow(/does not recognise/);
  });

  it("PLANTED: a replacement whose passage is not in the current body is a loud refusal too", () => {
    const planted: MigrationText = {
      file: "20991231000002_planted_stale_replacement.sql",
      text: [
        "select body into strict v_current from public.legal_documents where slug = 'ai-use';",
        "v_next := replace(v_current,",
        "$t$a passage that was never on the page$t$,",
        "$t$replaced$t$);",
        "insert into public.legal_documents (slug, version, title, effective_date, body) select 1;",
      ].join("\n"),
    };
    expect(() => walkLegalBodies([...readMigrations(), planted])).toThrow(/not in the current body/);
  });
});

/** A line that states where data is hosted. Since Task 9a it also catches a
 *  line that names a region (Ireland, an AWS-style region code). */
const HOSTING =
  /\b(UK\/EU|UK\/EEA|EU\/UK)\b[^.]*\bregion\b|\bhosted (in|within) the (UK|EU|EEA)\b|\bIreland\b|\b[a-z]{2}-[a-z]+-\d\b/i;
/** Q145, founder 2026-09-30: the production database region, by name. A line
 *  that states where data is hosted must say THIS, and must not carry the
 *  "(deployment setting)" marker it carried while the region was unconfirmed. */
const DATABASE_REGION = "Ireland (eu-west-1)";
/** Q142, founder 2026-09-30: the application host. Its server is not bought,
 *  so any line naming it must say its location is pending -- never a country. */
const APP_HOST = /\bIONOS\b/;
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
    if (HOSTING.test(line) && !gap && (!line.includes(DATABASE_REGION) || line.includes("(deployment setting)"))) {
      failures.push(`region: ${line}`);
    }
    if (APP_HOST.test(line) && !gap && !/\bpending\b/i.test(line)) failures.push(`app host: ${line}`);
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
    // Task 9a: the marked region line Privacy v3 / DPA v4 / Security v2 carried
    // is now a failure (the region is named, founder 2026-09-30), and so is a
    // guessed location for the application host.
    const beforeTask9a = walkLegalBodies(readMigrations(), "20261008000000_legal_pages_name_the_hosts.sql").bodies;
    for (const slug of ["privacy", "data-processing-addendum", "security"]) {
      expect(unqualified(beforeTask9a.get(slug)!).some((f) => f.startsWith("region:")), slug).toBe(true);
    }
    expect(unqualified("Our servers are hosted by IONOS SE in London.")).toEqual([
      "app host: Our servers are hosted by IONOS SE in London.",
    ]);
    expect(unqualified("Data is hosted by Supabase in Ireland (eu-west-1) (deployment setting).")).toHaveLength(1);
    expect(unqualified("Data is hosted by Supabase in eu-west-2.")).toHaveLength(1);
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
    // Q145, founder 2026-09-30: the region is Ireland (eu-west-1), stated by
    // name -- the "(deployment setting)" marker it carried while unconfirmed
    // is gone, and a vaguer "UK/EU region" may not come back in its place.
    expect(supabase?.location).toContain("data hosted in Ireland (eu-west-1)");
    expect(supabase?.location).not.toContain("(deployment setting)");
    expect(supabase?.location).not.toMatch(/UK\/EU/);
    expect(supabase?.transferBasis).toMatch(/^Not yet confirmed/);
    expect(supabase?.dpaSigned).toBe(false);
    // Q142, founder 2026-09-30: the application host is IONOS SE, a German
    // company, and its server region is PENDING (not bought yet) -- never a
    // guessed region, and no transfer position settled ahead of it.
    const ionos = SUB_PROCESSORS.find((v) => v.name === "IONOS SE");
    expect(ionos?.location).toContain("Germany");
    expect(ionos?.location).toContain("server region PENDING");
    expect(ionos?.location).not.toMatch(/United Kingdom|\bUK\b|London|Ireland/);
    expect(ionos?.transferBasis).toMatch(/^Not yet confirmed/);
    expect(ionos?.dpaSigned).toBe(false);
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

// ===========================================================================
// PHASE 8 TASK 2: MARKETING PREFERENCES v2 DESCRIBES THE CONTROL THAT EXISTS
// ===========================================================================
describe("Task 2: Marketing and Communications Preferences version 2", () => {
  const before = new Map([...seedBodies(), ...correctedBodies()]);
  const corrected = applyCorrections(marketingV2, before, "20260923001000");
  const body = corrected.get("marketing-preferences") ?? "";

  it("20260923001000 corrects exactly the marketing page", () => {
    expect([...corrected.keys()]).toEqual(["marketing-preferences"]);
    expect(body).not.toBe(before.get("marketing-preferences"));
  });

  it("passes the editor's own save-time validation", () => {
    const result = validateDraft("marketing-preferences", {
      title: "Marketing and Communications Preferences",
      body,
      effectiveDate: "2026-09-23",
    });
    expect(result.ok ? {} : result.fieldErrors).toEqual({});
  });

  it("DENOMINATOR: version 1 spoke of the control in the future tense", () => {
    expect(before.get("marketing-preferences")).toContain("the preference controls added to your account");
  });

  it("names the real control, says no marketing is sent, and says what a record holds and omits", () => {
    expect(body).not.toContain("the preference controls added to your account");
    expect(body).toContain("[Privacy and communications](/account/privacy)");
    expect(body).toContain("**No marketing email is sent today, whatever you choose.**");
    expect(body).toMatch(/the version of this page in force/);
    expect(body).toMatch(/We do not record your IP address or any details of your browser or device/);
    expect(body).toMatch(/\[Counsel to confirm: how long consent records are kept/);
    // The generic "GetSetPaid does not send marketing email" line is kept.
    expect(body).toContain("GetSetPaid does not send marketing email or text messages.");
  });

  it("commits no email address and records no counsel review", () => {
    expect(marketingV2).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(marketingV2).not.toMatch(/mailto:/i);
    expect(marketingV2).not.toMatch(/set\s+counsel_review|counsel_reviewer\s*=|counsel_review_recorded_by\s*=/);
    expect(marketingV2).toMatch(/set status = 'published'/);
  });
});

// ===========================================================================
// PHASE 8 TASK 3: DATA SUBJECT RIGHTS v2 DESCRIBES THE WORKFLOW THAT EXISTS
// ===========================================================================
describe("Task 3 fix round 1: Your Data Protection Rights version 3", () => {
  const before = currentBodiesBeforeV3();
  const corrected = applyCorrections(dsrV3, before, "20260925004000");
  const body = corrected.get("data-subject-rights") ?? "";

  it("20260925004000 corrects exactly the data-subject-rights page", () => {
    expect([...corrected.keys()]).toEqual(["data-subject-rights"]);
    expect(body).not.toBe(before.get("data-subject-rights"));
  });

  it("passes the editor's own save-time validation", () => {
    const result = validateDraft("data-subject-rights", {
      title: "Your Data Protection Rights",
      body,
      effectiveDate: "2026-09-25",
    });
    expect(result.ok ? {} : result.fieldErrors).toEqual({});
  });

  it("DENOMINATOR: version 2 contradicted itself and promised an unlimited mailbox", () => {
    const v2 = before.get("data-subject-rights") ?? "";
    expect(v2).toContain("never shown to anyone else");
    expect(v2).toContain("we pass it to that organisation");
    expect(v2).toContain("email is never limited");
    expect(v2).not.toContain("## If you cannot sign in");
  });

  it("keeps only the promise the product can keep, and names the exception", () => {
    expect(body).not.toContain("never shown to anyone else");
    expect(body).toMatch(/never copied into our security log/);
    expect(body).toMatch(/we have to tell that business that you asked/);
    expect(body).toMatch(/we tell you which business we asked/);
  });

  it("says the form's limit does not apply to email, rather than that email is unlimited", () => {
    expect(body).not.toContain("email is never limited");
    expect(body).toContain("That limit does not apply to email");
    expect(body).toMatch(/limited to ten requests a day/);
  });

  it("writes down the identity procedure for a request with no account", () => {
    expect(body).toContain("## If you cannot sign in");
    // The four properties the procedure has to have to be a procedure: ask
    // little, disclose nothing first, the clock starts when identity is
    // settled, and there is a written refusal with a route to the ICO.
    expect(body).toMatch(/as little as we can/);
    expect(body).toMatch(/tell you nothing about what we hold/);
    expect(body).toMatch(/runs from the day we have what we need/);
    expect(body).toMatch(/complain to the ICO/);
  });

  it("says routing is something WE do by hand, not something the product sends", () => {
    expect(body).not.toContain("we pass it to that organisation and record that we did;");
    expect(body).toMatch(/we write to it ourselves/);
    expect(body).toMatch(/nothing in GetSetPaid tells a business/);
  });

  it("keeps the Q132 counsel gap", () => {
    expect(body).toContain("[Counsel to confirm: the controller and processor characterisation above.]");
  });

  it("records no counsel review and publishes by transition", () => {
    expect(dsrV3).not.toMatch(/set\s+counsel_review|counsel_reviewer\s*=|counsel_review_recorded_by\s*=/);
    expect(dsrV3).toMatch(/set status = 'published'/);
    expect(dsrV3).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });
});

describe("Task 3: Your Data Protection Rights version 2", () => {
  const before = new Map([
    ...seedBodies(),
    ...correctedBodies(),
    ...applyCorrections(consistency, new Map([...seedBodies(), ...correctedBodies()]), "20260922006000"),
    ...applyCorrections(marketingV2, new Map([...seedBodies(), ...correctedBodies()]), "20260923001000"),
  ]);
  const corrected = applyCorrections(dsrV2, before, "20260924002000");
  const body = corrected.get("data-subject-rights") ?? "";

  it("20260924002000 corrects exactly the data-subject-rights page", () => {
    expect([...corrected.keys()]).toEqual(["data-subject-rights"]);
    expect(body).not.toBe(before.get("data-subject-rights"));
  });

  it("passes the editor's own save-time validation", () => {
    const result = validateDraft("data-subject-rights", {
      title: "Your Data Protection Rights",
      body,
      effectiveDate: "2026-09-24",
    });
    expect(result.ok ? {} : result.fieldErrors).toEqual({});
  });

  it("DENOMINATOR: version 1 said the form was still being built", () => {
    expect(before.get("data-subject-rights")).toContain("A self-service request form is being built.");
  });

  it("names the real form, the email route for someone with no account, and what is recorded", () => {
    expect(body).not.toContain("A self-service request form is being built.");
    expect(body).toContain("[your data protection requests](/account/data-requests)");
    expect(body).toMatch(/Being signed in is how we know the request is yours/);
    expect(body).toMatch(/If you do not have a GetSetPaid account, or you cannot sign in/);
    // The intake limit is stated WITH the unlimited alternative beside it, or
    // the sentence would read as "we can refuse to take your request".
    expect(body).toMatch(/limited to ten requests a day/);
    expect(body).toMatch(/email is never limited/);
    expect(body).toMatch(/never copied into our security log/);
    expect(body).toMatch(/withdraw a request at any time/);
  });

  it("keeps the Q132 counsel gap: shipping the routing does not settle the law", () => {
    expect(body).toContain(
      "[Counsel to confirm: the controller and processor characterisation above.]",
    );
    expect(body).toMatch(/we pass it to that organisation and record that we did/);
  });

  it("still keeps the 30-day promise the database enforces", () => {
    expect(body).toMatch(/within 30 days/);
  });

  it("commits no email address and records no counsel review", () => {
    expect(dsrV2).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(dsrV2).not.toMatch(/mailto:/i);
    expect(dsrV2).not.toMatch(/set\s+counsel_review|counsel_reviewer\s*=|counsel_review_recorded_by\s*=/);
    expect(dsrV2).toMatch(/set status = 'published'/);
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

// ===========================================================================
// PHASE 8 TASK 9a: THE HOSTS, NAMED (founder 2026-09-30, Q142/Q145; Q187)
// ===========================================================================
const hosting = readMigration("20261008000000_legal_pages_name_the_hosts.sql");

describe("Task 9a: the four hosting pages name Ireland and IONOS SE, and the retention page says when a period is judged", () => {
  const before = walkLegalBodies(readMigrations(), "20261008000000_legal_pages_name_the_hosts.sql").bodies;
  const corrected = applyCorrections(hosting, before, "20261008000000");
  const titles = new Map(LEGAL_DOCUMENTS.map((d) => [d.slug as string, d.title as string]));

  it("corrects exactly the five pages, each with a real change", () => {
    expect([...corrected.keys()].sort()).toEqual([
      "data-processing-addendum",
      "data-retention",
      "privacy",
      "security",
      "subprocessors",
    ]);
    for (const [slug, body] of corrected) expect(body, slug).not.toBe(before.get(slug));
  });

  it.each(["data-processing-addendum", "data-retention", "privacy", "security", "subprocessors"])(
    "%s passes the editor's own save-time validation",
    (slug) => {
      const result = validateDraft(slug as LegalSlug, {
        title: titles.get(slug) ?? "",
        body: corrected.get(slug) ?? "",
        effectiveDate: "2026-10-08",
      });
      expect(result.ok ? {} : result.fieldErrors).toEqual({});
    },
  );

  it("DENOMINATOR: the versions it supersedes carried the region marker and the unlisted host", () => {
    for (const slug of ["privacy", "data-processing-addendum", "subprocessors"]) {
      expect(before.get(slug), slug).toContain("**(deployment setting)**");
      expect(before.get(slug), slug).not.toContain("IONOS");
    }
    expect(before.get("security")).toContain("The region is chosen in our hosting account **(deployment setting)**.");
  });

  it("Q145: the database region is named on every hosting page, and its marker is gone", () => {
    for (const slug of ["privacy", "data-processing-addendum", "security"]) {
      const body = corrected.get(slug)!;
      expect(body, slug).toContain("hosted by Supabase in Ireland (eu-west-1)");
      expect(body, slug).not.toMatch(/UK\/EU region/);
    }
    for (const slug of ["privacy", "data-processing-addendum", "subprocessors"]) {
      expect(corrected.get(slug), slug).not.toContain("(deployment setting)");
    }
  });

  it("the Security page keeps every marker that is NOT about the region", () => {
    const body = corrected.get("security")!;
    const markers = body.split("(deployment setting)").length - 1;
    expect(markers).toBe(before.get("security")!.split("(deployment setting)").length - 2);
    expect(markers).toBeGreaterThanOrEqual(6);
    for (const control of ["Google sign-in", "two-factor settings", "12 hours in total", "sign-in check", "email delivery"]) {
      const line = body.split("\n").find((l) => l.includes(control));
      expect(line, control).toContain("(deployment setting)");
    }
  });

  it("Q142: the application host is IONOS SE on all four pages, with its location pending and no country guessed", () => {
    for (const slug of ["privacy", "data-processing-addendum", "security", "subprocessors"]) {
      const body = corrected.get(slug)!;
      expect(body, slug).toContain("IONOS SE");
      expect(body, slug).toMatch(/pending/);
      expect(body, slug).not.toMatch(/not yet listed/);
      // Sentence by sentence: Privacy and the DPA name Ireland for the
      // DATABASE in the sentence before the one naming the host.
      const sentences = body.split(/(?<=\.)\s+/).filter((l) => l.includes("IONOS"));
      expect(sentences.length, slug).toBeGreaterThan(0);
      // (Each LINE naming the host says "pending": unqualified() asserts that
      // for every current page, in the test above.)
      for (const sentence of sentences) {
        expect(sentence, slug).not.toMatch(/United Kingdom|\bin the UK\b|London|Ireland|Frankfurt|Berlin/);
      }
    }
  });

  it("Q187: the retention page says the period is judged at deletion, and keeps the sentence the RL binding reads", () => {
    const body = corrected.get("data-retention")!;
    expect(body).toContain("Which of the two applies is judged when the document is deleted");
    expect(body).toContain("restored and deleted again is judged again at that second deletion");
    // rls_phase8_retention.sql § RL page_sentences, verbatim with the numbers in.
    expect(body).toContain("**The file behind a deleted document:** 2 years after the document was deleted");
    expect(body).toContain("-- or 7 years if the document is attached to an event that carries financial entries");
  });

  it("refuses to run against any published version but the one it was written for, and publishes by id", () => {
    for (const [slug, version] of [
      ["privacy", 3],
      ["data-processing-addendum", 4],
      ["security", 2],
      ["subprocessors", 2],
      ["data-retention", 6],
    ] as const) {
      expect(hosting, slug).toMatch(new RegExp(`where slug = '${slug}' and status = 'published';\\n  if v_version <> ${version} then`));
    }
    expect(hosting).toMatch(/set status = 'published', published_at = now\(\)\s+where d\.id = v_new;/);
    expect(hosting).not.toMatch(/where d\.status = 'draft'/);
  });

  it("commits no email address and records no counsel review", () => {
    expect(hosting).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(hosting).not.toMatch(/mailto:/i);
    expect(hosting).not.toMatch(/set\s+counsel_review|counsel_reviewer\s*=|counsel_review_recorded_by\s*=/);
  });
});

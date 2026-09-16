// THE LIVE DATABASE AND THE APP AGREE ABOUT THE LEGAL DOCUMENT STORE.
//
// tests/unit/legal/seed-matches-catalogue.test.ts reads the MIGRATION TEXT;
// this reads what is DEPLOYED (pg_constraint, the rows themselves), because a
// later migration can replace a constraint and what is live is what decides.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";
import {
  KNOWN_TOKENS,
  PLACEMENT_PATTERNS,
  parseLegalMarkup,
  placementViolations,
  safeHref,
} from "@/lib/legal/markup";
import { REQUIRED_PLACEHOLDERS, rendersPlaceholder } from "@/lib/legal/draft-validation";

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

// ===========================================================================
// FIX ROUND 1 (M3, M4): THE VALIDATOR AND THE LIVE CHECKS ACCEPT THE SAME SET
// ===========================================================================
// Evaluated with the LIVE constraint expression (pg_get_constraintdef), not
// with a copy of it, over a generated corpus: every sample the database
// refuses, the parser flags, and every sample it accepts, the parser does not.
function corpus(size: number, alphabet: readonly string[], maxLength: number): string[] {
  let state = 0x1e9a1;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    // The HIGH bits: an LCG's low bits cycle with a tiny period, and a
    // power-of-two alphabet would otherwise see the same few samples.
    return state >>> 11;
  };
  const out: string[] = [];
  for (let n = 0; n < size; n++) {
    const len = 1 + (next() % maxLength);
    let sample = "";
    for (let k = 0; k < len; k++) sample += alphabet[next() % alphabet.length];
    out.push(sample);
  }
  return out;
}

/** Evaluate one live CHECK over many bodies (and a slug), in one query. */
async function liveVerdicts(constraint: string, slug: string, bodies: readonly string[]): Promise<boolean[]> {
  const def = await constraintDef(constraint);
  const expression = /^CHECK \(([\s\S]*)\)$/.exec(def)?.[1];
  expect(expression, def).toBeTruthy();
  // The expression is the catalogue's own text, not input: it names `body`
  // and `slug`, which the subquery supplies.
  const { rows } = await pool.query<{ ok: boolean }>(
    `select coalesce((${expression}), true) as ok
       from (select $1::text as slug, b as body, i from unnest($2::text[]) with ordinality as t(b, i)) x
      order by i`,
    [slug, bodies],
  );
  return rows.map((r) => r.ok);
}

describe("the live placement CHECK is the parser's rule", () => {
  it("carries each of PLACEMENT_PATTERNS verbatim", async () => {
    const def = await constraintDef("legal_documents_body_placeholders_placed");
    for (const [rule, source] of Object.entries(PLACEMENT_PATTERNS)) {
      expect(def, rule).toContain(`'${source}'`);
    }
  });

  it("refuses exactly the bodies the parser flags, over a generated corpus", async () => {
    const samples = corpus(
      4000,
      ["*", "**", "[", "]", "](", ")", "{{", "}}", "\n", "\r", " ", "\t", "a", "{{support_email}}", "{{subprocessors}}", "{{storage_inventory}}"],
      16,
    );
    const live = await liveVerdicts("legal_documents_body_placeholders_placed", "terms", samples);
    let refused = 0;
    samples.forEach((sample, index) => {
      if (!live[index]) refused++;
      expect(placementViolations(sample).size === 0, JSON.stringify(sample)).toBe(live[index]);
    });
    // DENOMINATOR: both verdicts occur.
    expect(refused).toBeGreaterThan(100);
    expect(refused).toBeLessThan(samples.length - 100);
  });

  it("requires the Cookie Policy's and Subprocessors page's tables exactly where the parser renders them", async () => {
    for (const [slug, token] of [
      ["cookies", "{{storage_inventory}}"],
      ["subprocessors", "{{subprocessors}}"],
    ] as const) {
      const samples = corpus(1500, ["\n", "\r", " ", "\t", "a", "#", "- ", token], 8);
      const live = await liveVerdicts("legal_documents_required_blocks_standalone", slug, samples);
      let present = 0;
      samples.forEach((sample, index) => {
        const parsed = parseLegalMarkup(sample);
        const renders = rendersPlaceholder(parsed.blocks, token);
        if (renders) present++;
        expect(renders, `${slug} ${JSON.stringify(sample)}`).toBe(live[index]);
      });
      expect(present).toBeGreaterThan(50);
      expect(present).toBeLessThan(samples.length - 50);
    }
  });
});

describe("the live link CHECK and the parser agree on a scheme's case (M4)", () => {
  it.each([
    ["https://ico.org.uk/", true],
    ["mailto:x@example.test", true],
    ["/legal/privacy", true],
    ["HTTPS://ico.org.uk/", false],
    ["Https://ico.org.uk/", false],
    ["MAILTO:x@example.test", false],
    ["JavaScript:alert(1)", false],
  ] as const)("%s -> %s", async (target, accepted) => {
    const [live] = await liveVerdicts("legal_documents_body_links_allowlisted", "terms", [`[x](${target})`]);
    expect(live).toBe(accepted);
    expect(safeHref(target) !== null).toBe(accepted);
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

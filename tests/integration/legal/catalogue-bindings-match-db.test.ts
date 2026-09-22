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
import {
  DSR_ALERT_LEAD_DAYS,
  DSR_RESPONSE_DAYS,
  DSR_RIGHTS,
  DSR_RIGHT_COPY,
  DSR_STATUSES,
  dsrTransitionAllowed,
} from "@/lib/dsr/contract";
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
  // Phase 8 Task 3.
  "private.dsr_rights",
  "private.dsr_response_days",
  "private.dsr_alert_lead_days",
  "private.dsr_transition_allowed",
  "private.data_subject_requests_before_insert",
  // Phase 8 Task 6 fix round 2 (m-N4): the audit action catalogue's
  // hand-listed half, bound in CI by tests/unit/admin/audit-action-catalogue.test.ts.
  "private.platform_audit_actions",
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

  it("private.dsr_rights() returns DSR_RIGHTS with the same fulfilment kinds", async () => {
    const { rows } = await pool.query<{ right_type: string; fulfilment_kind: string | null }>(
      `select right_type, fulfilment_kind from private.dsr_rights() order by right_type`,
    );
    expect(rows.length).toBe(6);
    expect(
      rows.map((r) => ({ right: r.right_type, kind: r.fulfilment_kind })),
    ).toEqual(
      [...DSR_RIGHTS]
        .sort()
        .map((right) => ({ right, kind: DSR_RIGHT_COPY[right].fulfilmentKind })),
    );
  });

  it("the two clocks are the numbers lib/dsr/contract.ts carries", async () => {
    const { rows } = await pool.query<{ days: number; lead: number }>(
      `select private.dsr_response_days() as days, private.dsr_alert_lead_days() as lead`,
    );
    expect(Number(rows[0].days)).toBe(DSR_RESPONSE_DAYS);
    expect(Number(rows[0].lead)).toBe(DSR_ALERT_LEAD_DAYS);
  });

  it("private.dsr_transition_allowed() answers as dsrTransitionAllowed() does, for EVERY pair", async () => {
    // The full 6x6 grid, not just the legal ones: a mirror that only agrees
    // about the transitions it expects to be legal would miss a widened
    // database side entirely.
    const disagreements: string[] = [];
    for (const from of DSR_STATUSES) {
      for (const to of DSR_STATUSES) {
        const { rows } = await pool.query<{ ok: boolean }>(
          `select private.dsr_transition_allowed($1, $2) as ok`,
          [from, to],
        );
        if (rows[0].ok !== dsrTransitionAllowed(from, to)) {
          disagreements.push(`${from}->${to}: db=${rows[0].ok} ts=${dsrTransitionAllowed(from, to)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
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

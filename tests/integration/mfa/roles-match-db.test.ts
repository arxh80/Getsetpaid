// The tripwire binding the two halves of the MFA role rule together.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
// CLAUDE.md § Session security's "MFA is required for: Platform Superuser,
// Organisation Owner, Admin, Finance" is written down TWICE:
//
//   private.role_requires_mfa(text)   -- the DATABASE half, in
//     supabase/migrations/20260827210000_mfa_aal_permission_gate.sql. This is
//     what public.has_permission() consults, so it is what actually ENFORCES.
//
//   MFA_REQUIRED_ROLES               -- the TYPESCRIPT half, in
//     lib/auth/mfa-gate.ts. This is what decides which screen the app renders
//     and which Server Actions refuse.
//
// Both are necessary (see the migration's header for why the database cannot
// be the only copy, and mfa-gate.ts's for why the app layer is not redundant).
// Nothing structural keeps them in step, and the failure is silent and
// security-relevant in BOTH directions:
//
//   in SQL but not TS   the role is gated in the database but the app never
//                       tells that user to enrol -- they hit an opaque 42501
//                       on every privileged action, with no path to fixing it.
//                       A lockout that no build, lint or type-check would see.
//
//   in TS but not SQL   the app sends the user to an enrolment screen for a
//                       requirement the database will never enforce. Worse
//                       than useless: it LOOKS like the control is on, so a
//                       reviewer reading the app layer concludes the role is
//                       protected when a direct PostgREST call is not.
//
// So this reads the roles the LIVE DATABASE says require MFA and asserts SET
// EQUALITY with the TypeScript set. Containment in either direction alone
// would miss half the drift, so neither is used.
//
// ===========================================================================
// WHY IT COMPARES AGAINST A REAL DATABASE
// ===========================================================================
// Same reasoning as tests/integration/entitlements/tiers-match-db.test.ts,
// which this is modelled on: a test that compared MFA_REQUIRED_ROLES to a
// second hardcoded list written in this file would prove nothing at all. It
// would restate the same literals twice and stay green after someone changed
// the SQL function in a migration and forgot the TypeScript. That is precisely
// the drift being guarded against, which is why this lives in
// tests/integration and needs a live stack to mean anything.
//
// It queries through a direct Postgres connection rather than PostgREST
// because private.role_requires_mfa() lives in the `private` schema, which
// supabase/config.toml deliberately does not expose to the Data API at all --
// and the RLS suite asserts that it stays that way. A superuser psql
// connection is the only way to reach it, and is the correct way: this is a
// test about the function's definition, not about who may call it.
//
// LOCAL ONLY, same discipline as the rest of tests/integration:
// getLocalSupabaseStatus() refuses anything that is not the loopback stack.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { MFA_REQUIRED_ROLES, roleCheckRequiresMfa } from "@/lib/auth/mfa-gate";

const { dbUrl } = getLocalSupabaseStatus();
const pool = new Pool({ connectionString: dbUrl });

afterAll(async () => {
  await pool.end();
});

/**
 * Every role key either half could possibly have an opinion about: the seeded
 * catalogue UNION the TypeScript set.
 *
 * The union, not just public.roles, is what makes the comparison complete. If
 * someone adds "superadmin" to MFA_REQUIRED_ROLES and it is not a real role,
 * iterating over the catalogue alone would never look at it and the test would
 * stay green on a TypeScript set that no longer describes anything.
 */
async function roleUniverse(): Promise<string[]> {
  const { rows } = await pool.query<{ key: string }>(
    "select key from public.roles",
  );
  return [...new Set([...rows.map((r) => r.key), ...MFA_REQUIRED_ROLES])].sort();
}

/** What the LIVE private.role_requires_mfa() says, per role. */
async function sqlVerdicts(universe: string[]): Promise<Map<string, boolean>> {
  const { rows } = await pool.query<{ key: string; requires: boolean }>(
    `select k as key, private.role_requires_mfa(k) as requires
       from unnest($1::text[]) as k`,
    [universe],
  );
  return new Map(rows.map((r) => [r.key, r.requires]));
}

describe("private.role_requires_mfa() and MFA_REQUIRED_ROLES describe the same rule", () => {
  it("the database was genuinely reached and its answer is not degenerate", async () => {
    // A guard against the way this test could rot into meaninglessness: a
    // query that errored into an empty set, or a function that returns the
    // same answer for everything, would make the set comparison below pass
    // trivially in one case and fail confusingly in the other. Assert the
    // catalogue is the one the reference-data migration seeds, and that the
    // function actually discriminates.
    const universe = await roleUniverse();
    const verdicts = await sqlVerdicts(universe);

    expect(universe.length).toBeGreaterThanOrEqual(9);
    expect(verdicts.size).toBe(universe.length);

    const requiring = [...verdicts.values()].filter(Boolean).length;
    expect(requiring, "some role must require MFA").toBeGreaterThan(0);
    expect(
      requiring,
      "some role must NOT require MFA -- a blanket true would lock out every unprivileged role",
    ).toBeLessThan(universe.length);
  });

  it("SET EQUALITY: the roles Postgres gates are exactly the roles TypeScript gates", async () => {
    const universe = await roleUniverse();
    const verdicts = await sqlVerdicts(universe);

    const fromDatabase = universe.filter((key) => verdicts.get(key) === true).sort();
    const fromTypeScript = [...MFA_REQUIRED_ROLES].sort();

    // toEqual on two sorted arrays gives a readable diff naming the role that
    // drifted and which side it is on -- which is the whole point, since the
    // fix differs depending on the direction.
    expect(
      fromDatabase,
      "private.role_requires_mfa() (left) vs MFA_REQUIRED_ROLES in lib/auth/mfa-gate.ts (right). " +
        "A role on one side only is drift in a security rule: fix whichever half is wrong, " +
        "never this assertion.",
    ).toEqual(fromTypeScript);
  });

  it("...and the exported decision function agrees with Postgres role by role", async () => {
    // Binds the RUNTIME path, not just the constant. roleCheckRequiresMfa() is
    // what callerHasPrivilegedRole() actually calls, so if someone rewrote its
    // body to stop consulting MFA_REQUIRED_ROLES, the set-equality assertion
    // above would still pass while the app's real behaviour had changed.
    const universe = await roleUniverse();
    const verdicts = await sqlVerdicts(universe);

    for (const key of universe) {
      const fromTypeScript = roleCheckRequiresMfa({
        data: [{ role: key }],
        error: null,
      });
      expect(
        fromTypeScript,
        `role "${key}": private.role_requires_mfa() says ${verdicts.get(key)}, ` +
          `roleCheckRequiresMfa() says ${fromTypeScript}`,
      ).toBe(verdicts.get(key));
    }
  });

  it("the rule is the one CLAUDE.md § Session security actually states", async () => {
    // The literal requirement, asserted against the database rather than
    // against either mirror -- so a coordinated edit to BOTH halves still has
    // to survive a comparison with the written rule.
    const verdicts = await sqlVerdicts(await roleUniverse());

    for (const role of ["owner", "admin", "finance"]) {
      expect(verdicts.get(role), `${role} must require MFA`).toBe(true);
    }
    for (const role of [
      "manager",
      "booker",
      "venue_manager",
      "marketing",
      "standard_user",
      "read_only",
    ]) {
      expect(verdicts.get(role), `${role} must NOT require MFA at MVP`).toBe(false);
    }
  });
});

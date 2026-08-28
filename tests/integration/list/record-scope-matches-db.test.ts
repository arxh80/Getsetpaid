// The tripwire for RECORD_SCOPED_ROLES, which is the fourth constant in this
// codebase to exist in two languages at once.
//
//   subscription_plans vs TIER_MATRIX
//     -> tests/integration/entitlements/tiers-match-db.test.ts
//   private.role_requires_mfa vs MFA_REQUIRED_ROLES
//     -> supabase/tests/rls_foundation.sql K19/K20
//   public.has_permission vs private.permitted_organisations
//     -> supabase/tests/rls_phase2_crm.sql § M
//   private.past_due_grace_days() vs PAST_DUE_GRACE_DAYS
//     -> tests/integration/entitlements/past-due-grace-matches-db.test.ts
//   private.full_scope_organisations() vs RECORD_SCOPED_ROLES  <- this file
//
// WHAT BREAKS IF THEY DRIFT, and it is not access control. Record scope is
// enforced by the SELECT policies and would hold identically if
// lib/crm/record-scope.ts did not exist. What the TypeScript copy decides is
// COPY: whether an empty contacts list says "No contacts yet" -- a claim about
// the organisation's data -- or "No contacts assigned to you", which is a
// claim about the viewer. Get it wrong for a role and that role is told its
// employer's CRM is empty when it holds thousands of records.
//
// So the failure is silent, plausible, and only visible to the one role that
// drifted. A role added to public.roles later, treated as record-scoped by the
// policy and full-scope by this list, is exactly the case.
//
// IT DRIVES THE DEPLOYED FUNCTION rather than reading its source. Fix round 3
// of Task 2 established why: a `prosrc` substring guard could not see a `<`
// changed to `<=`, and a test that builds its own copy of the expression
// proves only that two things the test wrote agree. So every role in
// public.roles gets a real organisation, a real active membership and a real
// `request.jwt.claims`, and the question put to Postgres is the one the policy
// asks -- "is this organisation in private.full_scope_organisations()".
//
// LOCAL ONLY. Same guard as every other integration test here: env.ts refuses
// anything that is not the loopback stack. Everything is rolled back.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { RECORD_SCOPED_ROLES, isRecordScopedRole } from "@/lib/crm/record-scope";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

async function rolesInDatabase(): Promise<string[]> {
  const { rows } = await pool.query<{ key: string }>(
    "select key from public.roles order by key",
  );
  return rows.map((r) => r.key);
}

describe("RECORD_SCOPED_ROLES mirrors private.full_scope_organisations()", () => {
  it("every role it names actually exists in public.roles", async () => {
    // A typo here fails open in the reassuring direction: the role is never
    // matched, so the scope note never renders and nobody notices.
    const known = await rolesInDatabase();
    for (const role of RECORD_SCOPED_ROLES) {
      expect(known, `RECORD_SCOPED_ROLES names "${role}"`).toContain(role);
    }
  });

  it("the deployed function agrees with isRecordScopedRole() for EVERY role", async () => {
    const roles = await rolesInDatabase();
    expect(roles.length).toBeGreaterThan(0);

    const disagreements: string[] = [];

    for (const role of roles) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const {
          rows: [{ uid }],
        } = await client.query<{ uid: string }>(
          `insert into auth.users (id, instance_id, aud, role, email,
                                   encrypted_password, email_confirmed_at,
                                   created_at, updated_at)
           values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                   'authenticated', 'authenticated',
                   'scope-' || gen_random_uuid() || '@example.test',
                   'x', now(), now(), now())
           returning id as uid`,
        );
        const {
          rows: [{ org }],
        } = await client.query<{ org: string }>(
          `insert into public.organisations (name, slug)
           values ('Scope probe', 'scope-' || replace(gen_random_uuid()::text, '-', ''))
           returning id as org`,
        );
        await client.query(
          `insert into public.organisation_memberships
             (organisation_id, user_id, role, status, joined_at)
           values ($1, $2, $3, 'active', now())`,
          [org, uid, role],
        );

        // Impersonate the way PostgREST does -- `set local role authenticated`
        // plus request.jwt.claims -- not by mocking auth.uid().
        await client.query("set local role authenticated");
        await client.query(
          "select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal1" })],
        );

        const {
          rows: [{ full_scope: fullScope }],
        } = await client.query<{ full_scope: boolean }>(
          `select $1::uuid in (select private.full_scope_organisations())
             as full_scope`,
          [org],
        );

        const databaseSaysRecordScoped = !fullScope;
        const typescriptSaysRecordScoped = isRecordScopedRole(role);
        if (databaseSaysRecordScoped !== typescriptSaysRecordScoped) {
          disagreements.push(
            `${role}: database says record-scoped=${databaseSaysRecordScoped}, ` +
              `isRecordScopedRole() says ${typescriptSaysRecordScoped}`,
          );
        }
      } finally {
        await client.query("rollback").catch(() => {});
        client.release();
      }
    }

    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("a role NOT in public.roles is treated as full scope by both", async () => {
    // The membership FK refuses an unknown role, so the database can never
    // produce one -- which means the TypeScript side must not invent scope for
    // a string it does not recognise either. Failing OPEN here is right: a
    // scope note that does not render is a missing sentence, while one that
    // renders for a full-scope Admin tells them their own CRM is smaller than
    // it is.
    expect(isRecordScopedRole("some_future_role")).toBe(false);
    expect(isRecordScopedRole("")).toBe(false);
    const known = await rolesInDatabase();
    expect(known).not.toContain("some_future_role");
  });
});

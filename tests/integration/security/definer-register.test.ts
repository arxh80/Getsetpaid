// =============================================================================
// PHASE 10 TASK 12 (G26) -- EVERY SECURITY DEFINER FUNCTION IS CLASSIFIED
// =============================================================================
// A definer runs with its owner's rights, so each one needs an answer to "who
// can call this?". definerClasses() sorts every definer in `public` and
// `private` by the catalogue:
//
//   trigger        -- runs only as a trigger.
//   no-api-grant   -- no browser role and no service_role may EXECUTE it.
//   service-role   -- server only. In `public` the permission matrix pins
//                     these by signature (SERVER_ONLY_RPCS).
//   api            -- a browser role may EXECUTE it. In `public` the matrix's
//                     RPC census forces each into its lists. In `private` the
//                     only fence is that `private` is not exposed (G31), so
//                     each must be declared in PRIVATE_POLICY_HELPERS.
//
// The last class is the one that landed silently before G26.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { getLocalSupabaseStatus } from "../rls/support/env";
import { definerClasses, type Queryable } from "./support/catalogue-census";
import { PRIVATE_POLICY_HELPERS } from "./support/definer-register";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/** Private definers a browser role may execute, minus the declared ones, and the reverse. */
async function registerDrift(q: Queryable) {
  const live = (await definerClasses(q)).filter((d) => d.sig.startsWith("private.") && d.cls === "api").map((d) => d.sig);
  const declared = Object.keys(PRIVATE_POLICY_HELPERS);
  return {
    undeclared: live.filter((s) => !declared.includes(s)),
    stale: declared.filter((s) => !live.includes(s)).sort(),
  };
}

describe("SECURITY DEFINER register (G26)", () => {
  it("every private definer a browser role may execute is declared with a reason, and nothing else is", async () => {
    const { undeclared, stale } = await registerDrift(pool);
    expect(
      undeclared,
      "a SECURITY DEFINER function in `private` is executable by anon/authenticated/PUBLIC and is not in " +
        "PRIVATE_POLICY_HELPERS (tests/integration/security/support/definer-register.ts). Declare it with a " +
        "one-line reason, or revoke the grant if no policy, CHECK or invoker body calls it as the caller.",
    ).toEqual([]);
    expect(stale, "declared in PRIVATE_POLICY_HELPERS but no longer a browser-executable private definer: delete the line").toEqual([]);
    for (const [sig, reason] of Object.entries(PRIVATE_POLICY_HELPERS)) expect(reason.trim(), sig).not.toBe("");
  });

  it("DENOMINATOR: the census sees every class it sorts into", async () => {
    const all = await definerClasses(pool);
    const count = (schema: string, cls: string) => all.filter((d) => d.sig.startsWith(`${schema}.`) && d.cls === cls).length;
    // 199 definers when this landed (2026-10-26).
    expect(all.length).toBeGreaterThanOrEqual(180);
    expect(count("private", "api")).toBe(Object.keys(PRIVATE_POLICY_HELPERS).length);
    expect(count("private", "trigger")).toBeGreaterThan(0);
    expect(count("private", "no-api-grant")).toBeGreaterThan(0);
    expect(count("public", "api")).toBeGreaterThan(0);
    expect(count("public", "service-role")).toBeGreaterThan(0);
  });

  it("MUTANT: a planted private definer granted to authenticated goes red, naming itself", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `create function private.zz_probe() returns int language sql security definer set search_path = '' as $$ select 1 $$`,
      );
      await client.query("revoke all on function private.zz_probe() from public");
      await client.query("grant execute on function private.zz_probe() to authenticated");
      expect(await registerDrift(client)).toEqual({ undeclared: ["private.zz_probe()"], stale: [] });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

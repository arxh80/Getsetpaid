// The tripwire for billing overrides, which now exist in two languages: the
// DEPLOYED private.effective_organisation_plan() (SQL) and
// lib/entitlements/policy.ts's resolveEntitlements() (TypeScript).
//
// SAME PATTERN as tests/integration/entitlements/past-due-grace-matches-db.test.ts
// and tests/integration/crm/custom-field-limit-matches-db.test.ts: a rule that
// exists in two languages with nothing binding them is how it drifts. This
// drives the REAL deployed function -- private.effective_organisation_plan(),
// which private.crm_write_organisations(), private.custom_field_limit(),
// private.finance_module_organisations() and
// private.network_publish_organisations() all now call -- across the two
// cases the brief specifically names: an override that is currently ACTIVE,
// and one that has EXPIRED (read-time expiry: the row still exists, it has
// simply stopped being returned).
//
// A DIRECT POSTGRES CONNECTION, not PostgREST -- private.
// effective_organisation_plan() lives in `private`, which supabase/config.toml
// does not expose. LOCAL ONLY, same discipline as every sibling in this
// directory: getLocalSupabaseStatus() refuses anything that does not look
// like the standard local loopback stack.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { resolveEntitlements, type ActiveBillingOverride } from "@/lib/entitlements/policy";
import { TIER_MATRIX } from "@/lib/entitlements/tiers";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

interface EffectivePlanRow {
  has_subscription: boolean;
  plan_id: string | null;
  status_ok: boolean;
  override_active: boolean;
  crm_writes: boolean | null;
  network_publish: boolean | null;
  custom_field_limit: number | null;
  finance_module: boolean | null;
  storage_limit_gb: number | null;
}

/** Seeds an organisation with a real Starter subscription (status active),
 * optionally with an override row -- active or already-expired -- and
 * returns everything both halves need to compare answers. Runs inside a
 * transaction the caller rolls back, same discipline as every fixture in
 * this directory. */
async function seedOrgWithOverride(
  client: import("pg").PoolClient,
  override: null | { tier: string | null; seats: number | null; expired: boolean },
  subscriptionStatus: "active" | "cancelled" = "active",
): Promise<string> {
  const { rows } = await client.query<{ org: string }>(
    `insert into public.organisations (name, slug)
     values ('Override Probe', 'override-probe-' || replace(gen_random_uuid()::text,'-',''))
     returning id as org`,
  );
  const org = rows[0].org;

  // A cancelled subscription's current_period_end is set in the PAST so the
  // past_due grace window (measured from it) can never be what keeps
  // status_ok true by accident -- the cancelled case must stand on the
  // status alone.
  await client.query(
    `insert into public.organisation_subscriptions
       (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
     values ($1, 'starter', 'monthly', 1, $2,
             case when $2 = 'active' then now() + interval '30 days'
                  else now() - interval '30 days' end)`,
    [org, subscriptionStatus],
  );

  if (override) {
    const { rows: userRows } = await client.query<{ id: string }>(
      `insert into auth.users (id, instance_id, aud, role, email)
       values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
               'authenticated', 'authenticated',
               'override-probe-' || gen_random_uuid() || '@test.local')
       returning id`,
    );
    const grantedBy = userRows[0].id;

    await client.query(
      `insert into public.organisation_billing_overrides
         (organisation_id, override_tier, override_seats, reason, granted_by,
          starts_at, expires_at)
       values ($1, $2, $3, 'integration test fixture', $4,
               now() - interval '1 hour',
               now() + case when $5 then interval '-30 minutes' else interval '1 hour' end)`,
      [org, override.tier, override.seats, grantedBy, override.expired],
    );
  }

  return org;
}

/** Reads the deployed effective-plan function for one organisation. */
async function readEffectivePlan(
  client: import("pg").PoolClient,
  org: string,
): Promise<EffectivePlanRow> {
  const { rows } = await client.query<EffectivePlanRow>(
    `select * from private.effective_organisation_plan($1::uuid)`,
    [org],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("billing overrides are the same rule in TypeScript and in SQL", () => {
  it("ACTIVE override naming Pro: the deployed function and resolveEntitlements() agree", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const org = await seedOrgWithOverride(client, {
        tier: "pro",
        seats: null,
        expired: false,
      });

      const plan = await readEffectivePlan(client, org);
      expect(plan.override_active, "override_active").toBe(true);
      expect(plan.status_ok, "status_ok -- override bypasses subscription status").toBe(
        true,
      );
      expect(plan.plan_id, "plan_id is the OVERRIDDEN tier").toBe("pro");
      expect(plan.finance_module, "finance_module reads off Pro").toBe(
        TIER_MATRIX.pro.financeModule,
      );
      expect(plan.network_publish).toBe(TIER_MATRIX.pro.networkPublish);
      expect(plan.crm_writes).toBe(TIER_MATRIX.pro.crmWrites);
      expect(plan.custom_field_limit).toBe(TIER_MATRIX.pro.customFieldLimit);

      const override: ActiveBillingOverride = { tier: "pro", seats: null };
      const fromTypeScript = resolveEntitlements(
        { data: { plan_id: "starter", status: "active", current_period_end: new Date().toISOString() }, error: null },
        Date.now(),
        override,
      );
      expect(fromTypeScript.tier).toBe("pro");
      expect(fromTypeScript.entitlements.financeModule).toBe(plan.finance_module);
      expect(fromTypeScript.entitlements.networkPublish).toBe(plan.network_publish);
      expect(fromTypeScript.entitlements.crmWrites).toBe(plan.crm_writes);
      expect(fromTypeScript.entitlements.customFieldLimit).toBe(plan.custom_field_limit);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("EXPIRED override: the deployed function reverts to the real subscription, and so does TypeScript", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const org = await seedOrgWithOverride(client, {
        tier: "pro",
        seats: null,
        expired: true,
      });

      const plan = await readEffectivePlan(client, org);
      expect(plan.override_active, "an expired row is not active").toBe(false);
      // Reverted to the REAL subscription: Starter, active.
      expect(plan.plan_id).toBe("starter");
      expect(plan.status_ok).toBe(true);
      expect(plan.finance_module, "Starter has no finance module").toBe(
        TIER_MATRIX.starter.financeModule,
      );
      expect(plan.network_publish).toBe(TIER_MATRIX.starter.networkPublish);

      // TypeScript's side of "expired": getOrganisationEntitlements() would
      // simply not have fetched a row at all (its query filters
      // expires_at > now()), so the caller passes null, exactly the shape an
      // expired-and-therefore-unfetched override produces.
      const fromTypeScript = resolveEntitlements(
        { data: { plan_id: "starter", status: "active", current_period_end: new Date().toISOString() }, error: null },
        Date.now(),
        null,
      );
      expect(fromTypeScript.tier).toBe("starter");
      expect(fromTypeScript.entitlements.financeModule).toBe(plan.finance_module);
      expect(fromTypeScript.entitlements.networkPublish).toBe(plan.network_publish);
      expect(fromTypeScript.override).toBe(false);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("REVOKED override (not expired, but revoked_at set) is also inactive on the SQL side", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const org = await seedOrgWithOverride(client, {
        tier: "pro",
        seats: null,
        expired: false,
      });
      await client.query(
        `update public.organisation_billing_overrides
         set revoked_at = now(), revoked_reason = 'test revoke'
         where organisation_id = $1`,
        [org],
      );

      const plan = await readEffectivePlan(client, org);
      expect(plan.override_active).toBe(false);
      expect(plan.plan_id).toBe("starter");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("NO OVERRIDE at all: effective_organisation_plan() matches the plain subscription reading", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const org = await seedOrgWithOverride(client, null);

      const plan = await readEffectivePlan(client, org);
      expect(plan.has_subscription).toBe(true);
      expect(plan.override_active).toBe(false);
      expect(plan.plan_id).toBe("starter");
      expect(plan.status_ok).toBe(true);
      expect(plan.crm_writes).toBe(TIER_MATRIX.starter.crmWrites);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a SEATS-ONLY override does not change plan_id, but its seat_count is carried through", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const org = await seedOrgWithOverride(client, {
        tier: null,
        seats: 42,
        expired: false,
      });

      const { rows } = await client.query<{ seat_count: number; plan_id: string }>(
        `select seat_count, plan_id from private.effective_organisation_plan($1::uuid)`,
        [org],
      );
      expect(rows[0].plan_id).toBe("starter");
      expect(rows[0].seat_count).toBe(42);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("SEATS-ONLY override + CANCELLED subscription: BOTH halves deny (review I1 -- seats do not revive a lapsed subscription)", async () => {
    // THE FIX-ROUND-1 BINDING CASE (20260909010000). As first shipped,
    // effective_organisation_plan()'s status bypass fired on ANY active
    // override row, so this exact state -- a seats-only override on a
    // cancelled subscription -- granted full paid-tier writes in SQL while
    // resolveEntitlements() resolved Free. The two halves must DENY together.
    const client = await pool.connect();
    try {
      await client.query("begin");
      const org = await seedOrgWithOverride(
        client,
        { tier: null, seats: 42, expired: false },
        "cancelled",
      );

      const plan = await readEffectivePlan(client, org);
      expect(plan.override_active, "the seats-only override IS active as a row").toBe(true);
      expect(
        plan.status_ok,
        "status_ok -- a seats-only override must NOT bypass the cancelled status",
      ).toBe(false);
      // status_ok=false is what every gate conjoins on, so plan_id staying
      // 'starter' grants nothing -- same shape as cancelled-with-no-override.
      expect(plan.plan_id).toBe("starter");

      const override: ActiveBillingOverride = { tier: null, seats: 42 };
      const fromTypeScript = resolveEntitlements(
        {
          data: {
            plan_id: "starter",
            status: "cancelled",
            current_period_end: new Date(Date.now() - 30 * 86400_000).toISOString(),
          },
          error: null,
        },
        Date.now(),
        override,
      );
      // TypeScript's cancelled branch: Free's entitlements, override:false.
      expect(fromTypeScript.tier).toBe("free");
      expect(fromTypeScript.override).toBe(false);
      expect(fromTypeScript.entitlements).toEqual(TIER_MATRIX.free);

      // The agreement that matters: neither half grants a paid capability.
      expect(fromTypeScript.entitlements.crmWrites).toBe(false);
      expect(fromTypeScript.entitlements.financeModule).toBe(false);
      expect(plan.status_ok && plan.crm_writes).toBeFalsy();
      expect(plan.status_ok && plan.finance_module).toBeFalsy();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a TIER-NAMING override still bypasses a CANCELLED subscription's status on both halves (the deliberate comp semantics survive the I1 fix)", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const org = await seedOrgWithOverride(
        client,
        { tier: "pro", seats: null, expired: false },
        "cancelled",
      );

      const plan = await readEffectivePlan(client, org);
      expect(plan.status_ok, "a tier-naming override bypasses status").toBe(true);
      expect(plan.plan_id).toBe("pro");
      expect(plan.finance_module).toBe(TIER_MATRIX.pro.financeModule);

      const fromTypeScript = resolveEntitlements(
        {
          data: {
            plan_id: "starter",
            status: "cancelled",
            current_period_end: new Date(Date.now() - 30 * 86400_000).toISOString(),
          },
          error: null,
        },
        Date.now(),
        { tier: "pro", seats: null },
      );
      expect(fromTypeScript.tier).toBe("pro");
      expect(fromTypeScript.override).toBe(true);
      expect(fromTypeScript.entitlements.financeModule).toBe(plan.finance_module);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("private.crm_write_organisations() actually calls the shared effective-plan function (source check)", async () => {
    const { rows } = await pool.query<{ src: string }>(
      "select prosrc as src from pg_proc p" +
        " join pg_namespace n on n.oid = p.pronamespace" +
        " where n.nspname = 'private' and p.proname = 'crm_write_organisations'",
    );
    expect(rows[0].src).toContain("private.effective_organisation_plan(");
  });

  it("private.custom_field_limit() actually calls the shared effective-plan function (source check)", async () => {
    const { rows } = await pool.query<{ src: string }>(
      "select prosrc as src from pg_proc p" +
        " join pg_namespace n on n.oid = p.pronamespace" +
        " where n.nspname = 'private' and p.proname = 'custom_field_limit'",
    );
    expect(rows[0].src).toContain("private.effective_organisation_plan(");
  });

  it("private.finance_module_organisations() actually calls the shared effective-plan function (source check)", async () => {
    const { rows } = await pool.query<{ src: string }>(
      "select prosrc as src from pg_proc p" +
        " join pg_namespace n on n.oid = p.pronamespace" +
        " where n.nspname = 'private' and p.proname = 'finance_module_organisations'",
    );
    expect(rows[0].src).toContain("private.effective_organisation_plan(");
  });

  it("private.network_publish_organisations() actually calls the shared effective-plan function (source check)", async () => {
    const { rows } = await pool.query<{ src: string }>(
      "select prosrc as src from pg_proc p" +
        " join pg_namespace n on n.oid = p.pronamespace" +
        " where n.nspname = 'private' and p.proname = 'network_publish_organisations'",
    );
    expect(rows[0].src).toContain("private.effective_organisation_plan(");
  });
});

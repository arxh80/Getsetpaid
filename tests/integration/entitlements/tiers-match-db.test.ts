// The tripwire Task 9 exists for.
//
// lib/entitlements/tiers.ts's TIER_MATRIX is a typed COMPILE-TIME MIRROR of
// the subscription_plans rows seeded by
// supabase/migrations/20260826202023_reference_data.sql -- it is not a
// second source of truth the app reads instead of the database (see that
// file's header, and lib/entitlements/policy.ts's header). Proving the
// mirror is accurate therefore means reading the ACTUAL seeded rows out of a
// REAL Postgres and comparing them to TIER_MATRIX -- a test that compared
// TIER_MATRIX to a second hardcoded object written in this file would prove
// nothing at all: it would just restate the same literals twice and stay
// green even after someone changed a price in a migration and forgot to
// update tiers.ts. That is exactly the drift this test is designed to catch,
// which is also why it lives in tests/integration rather than tests/unit --
// it needs a live database to mean anything.
//
// LOCAL ONLY, same discipline as tests/integration/rls/rls.test.ts: connects
// through getLocalSupabaseStatus(), which refuses anything that doesn't look
// like the standard local loopback stack. subscription_plans is readable by
// the anon role by design (CLAUDE.md's logged-out pricing page reads it
// before sign-in -- see subscription_plans_select_public in
// 20260826154304_permission_engine_and_rls.sql), so an anon-keyed client is
// sufficient here; no service-role key, no signed-in session, no fixture
// lifecycle needed.
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { TIER_KEYS, TIER_MATRIX, type TierKey } from "@/lib/entitlements/tiers";

interface SubscriptionPlanRow {
  key: string;
  price_monthly_minor: number;
  price_annual_minor: number;
  currency: string;
  crm_writes: boolean;
  network_publish: boolean;
  custom_field_limit: number | null;
  finance_module: boolean;
  storage_limit_gb: number;
}

describe("TIER_MATRIX matches the real seeded subscription_plans rows exactly", () => {
  it("every row Postgres actually has for free/starter/pro equals TIER_MATRIX field-for-field", async () => {
    const { apiUrl, anonKey } = getLocalSupabaseStatus();
    const supabase = createClient(apiUrl, anonKey);

    const { data, error } = await supabase
      .from("subscription_plans")
      .select(
        "key, price_monthly_minor, price_annual_minor, currency, crm_writes, network_publish, custom_field_limit, finance_module, storage_limit_gb",
      )
      .order("key", { ascending: true });

    expect(error).toBeNull();
    const rows = (data ?? []) as SubscriptionPlanRow[];

    // The migration seeds exactly free/starter/pro. If this ever grows (or
    // shrinks), TIER_MATRIX/TierKey need a deliberate update, not a silently
    // passing partial comparison -- so assert the exact key set first.
    expect(rows.map((r) => r.key).sort()).toEqual([...TIER_KEYS].sort());

    for (const row of rows) {
      const key = row.key as TierKey;
      const expected = TIER_MATRIX[key];

      expect(row.price_monthly_minor, `${key}.priceMonthlyMinor`).toBe(
        expected.priceMonthlyMinor,
      );
      expect(row.price_annual_minor, `${key}.priceAnnualMinor`).toBe(
        expected.priceAnnualMinor,
      );
      expect(row.currency, `${key}.currency`).toBe(expected.currency);
      expect(row.crm_writes, `${key}.crmWrites`).toBe(expected.crmWrites);
      expect(row.network_publish, `${key}.networkPublish`).toBe(
        expected.networkPublish,
      );
      expect(row.custom_field_limit, `${key}.customFieldLimit`).toBe(
        expected.customFieldLimit,
      );
      expect(row.finance_module, `${key}.financeModule`).toBe(
        expected.financeModule,
      );
      expect(row.storage_limit_gb, `${key}.storageLimitGb`).toBe(
        expected.storageLimitGb,
      );
    }
  });

  it("pro's custom_field_limit is genuinely NULL in Postgres (unlimited), not zero", async () => {
    const { apiUrl, anonKey } = getLocalSupabaseStatus();
    const supabase = createClient(apiUrl, anonKey);

    const { data, error } = await supabase
      .from("subscription_plans")
      .select("custom_field_limit")
      .eq("key", "pro")
      .maybeSingle();

    expect(error).toBeNull();
    expect(data?.custom_field_limit).toBeNull();
    expect(TIER_MATRIX.pro.customFieldLimit).toBeNull();
  });
});

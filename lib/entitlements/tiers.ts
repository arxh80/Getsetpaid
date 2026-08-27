// Subscription tier gating matrix (Free / Starter / Pro -- see CLAUDE.md
// § Subscription tiers).
//
// THIS IS A TYPED MIRROR, NOT A SECOND SOURCE OF TRUTH. The database is
// authoritative at runtime: lib/entitlements/policy.ts's
// getOrganisationEntitlements() reads organisation_subscriptions joined to
// subscription_plans out of Postgres for every real decision. This file
// exists only for compile-time safety and autocomplete over the three known
// tier keys -- the same division CLAUDE.md already draws for permissions,
// where the actual logic lives in SQL (public.has_permission()) and
// TypeScript holds constants, never a parallel decision path.
//
// PROVEN EQUAL TO THE SEEDED ROWS, NOT MERELY ASSERTED.
// tests/integration/entitlements/tiers-match-db.test.ts reads the real
// seeded public.subscription_plans rows out of a live local Postgres and
// compares them field-for-field against TIER_MATRIX below. A test that only
// compared this file to a second hardcoded object in the test file would
// prove nothing -- it would just restate the same literals twice and stay
// green even after a migration changed a price and nobody updated this
// file. That integration test is the actual point of this task: it is the
// tripwire that fires the moment this mirror drifts from
// supabase/migrations/20260826202023_reference_data.sql.
//
// Values transcribed verbatim from that migration -- do not "simplify" the
// annual prices back to a rounded approximation, they are already exact
// integers (£19 x 12 x 0.85 = £193.80 = 19380 minor; £39 x 12 x 0.85 =
// £397.80 = 39780 minor).

export type TierKey = "free" | "starter" | "pro";

export const TIER_KEYS: readonly TierKey[] = ["free", "starter", "pro"];

export interface TierEntitlements {
  key: TierKey;
  priceMonthlyMinor: number;
  priceAnnualMinor: number;
  currency: "GBP";
  crmWrites: boolean;
  networkPublish: boolean;
  /** null means UNLIMITED (Pro), not zero. Zero is Free's real limit. */
  customFieldLimit: number | null;
  financeModule: boolean;
  storageLimitGb: number;
}

export const TIER_MATRIX: Readonly<Record<TierKey, TierEntitlements>> = {
  free: {
    key: "free",
    priceMonthlyMinor: 0,
    priceAnnualMinor: 0,
    currency: "GBP",
    crmWrites: false,
    networkPublish: false,
    customFieldLimit: 0,
    financeModule: false,
    storageLimitGb: 0,
  },
  starter: {
    key: "starter",
    priceMonthlyMinor: 1900,
    priceAnnualMinor: 19380,
    currency: "GBP",
    crmWrites: true,
    networkPublish: true,
    customFieldLimit: 5,
    financeModule: false,
    storageLimitGb: 5,
  },
  pro: {
    key: "pro",
    priceMonthlyMinor: 3900,
    priceAnnualMinor: 39780,
    currency: "GBP",
    crmWrites: true,
    networkPublish: true,
    customFieldLimit: null,
    financeModule: true,
    storageLimitGb: 20,
  },
};

/**
 * Allowlist check for a `plan_id` value read back from
 * organisation_subscriptions/subscription_plans -- the FK only guarantees
 * the key exists in subscription_plans, not that this mirror already knows
 * about it (e.g. a plan added in a later migration before tiers.ts is
 * updated to match). Callers should fail closed rather than index
 * TIER_MATRIX with an unchecked string.
 */
export function isTierKey(value: string): value is TierKey {
  return value === "free" || value === "starter" || value === "pro";
}

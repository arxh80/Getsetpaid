import "server-only";

// Per-org feature-flag overrides: the READ half every ordinary page consults.
//
// AT MVP THIS GATES NOTHING SHIPPED (Task 4's brief: "gate nothing
// existing"). private.active_feature_override() is the SQL mirror; the two
// are bound by tests/integration/entitlements/billing-override-matches-db.test.ts's
// sibling assertions on the feature side. The ONE consumer that proves the
// wiring end to end is app/(app)/[orgSlug]/page.tsx's "Early access preview"
// badge -- grant an override through /super/billing, and it appears on that
// organisation's workspace home with no other behaviour changed.
//
// Reads organisation_feature_overrides under the caller's OWN RLS
// (organisation_feature_overrides_select_member -- any active member, same
// breadth as the billing table, and for the same reason: an entitlement-style
// read has to work for every role, not just Owner/Admin).

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { isFeatureFlagKey, type FeatureFlagKey } from "@/lib/admin/overrides-contract";

/**
 * Is `flagKey` CURRENTLY active (not revoked, started, not yet expired) for
 * this organisation? Read-time expiry -- the query below applies exactly the
 * predicate private.active_feature_override() applies in SQL.
 *
 * Fails CLOSED on a query error: "could not tell" must never read as "yes,
 * the flag is on", the same direction every other entitlement read in this
 * codebase takes.
 *
 * `cache()`-wrapped per (organisationId, flagKey) pair within one request --
 * `cache()` keys on argument identity, so this costs one round trip per
 * distinct pair a render actually asks about.
 */
export const hasActiveFeatureOverride = cache(
  async (organisationId: string, flagKey: FeatureFlagKey): Promise<boolean> => {
    if (!isFeatureFlagKey(flagKey)) return false;

    const supabase = await createClient();
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("organisation_feature_overrides")
      .select("id")
      .eq("organisation_id", organisationId)
      .eq("flag_key", flagKey)
      .is("revoked_at", null)
      .lte("starts_at", nowIso)
      .gt("expires_at", nowIso)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(
        `[entitlements] organisation_feature_overrides lookup failed for org ${organisationId}, flag ${flagKey}; failing closed (treating the flag as off):`,
        error.message,
      );
      return false;
    }

    return data !== null;
  },
);

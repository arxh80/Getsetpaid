import "server-only";

// The "what/until-when" an org's own admin reads about an active billing
// override -- CLAUDE.md § Superuser dashboard, "visible to the org's admins
// in-app". A DISPLAY-ONLY read: it changes no gate anywhere (that is
// lib/entitlements/policy.ts's getOrganisationEntitlements(), which this
// mirrors the query shape of but does not replace).
//
// GATED IN THE UI, NOT IN THE RLS POLICY. organisation_billing_overrides_
// select_member (20260909000000) deliberately permits ANY active member to
// read the row -- every role's own entitlement resolution needs it, per that
// policy's own comment. This module's caller (app/(app)/[orgSlug]/page.tsx)
// is what narrows the DISPLAY to Owner/Admin (manage_organisation), which is
// the same split Q103 already established for organisations.lifecycle_reason:
// RLS filters rows, restricting who SEES something once every role can
// already reach the row is a UI decision.

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { isTierKey, type TierKey } from "@/lib/entitlements/tiers";

export interface ActiveBillingOverrideSummary {
  readonly overrideTier: TierKey | null;
  readonly overrideSeats: number | null;
  readonly expiresAt: string;
}

/**
 * The organisation's currently-active billing override, or null. Fails
 * CLOSED (returns null, logs) on a query error -- "could not tell" must not
 * render a stale or invented summary.
 */
export const getActiveBillingOverrideSummary = cache(
  async (organisationId: string): Promise<ActiveBillingOverrideSummary | null> => {
    const supabase = await createClient();
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("organisation_billing_overrides")
      .select("override_tier, override_seats, expires_at")
      .eq("organisation_id", organisationId)
      .is("revoked_at", null)
      .lte("starts_at", nowIso)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(
        `[entitlements] active billing override summary lookup failed for org ${organisationId}:`,
        error.message,
      );
      return null;
    }
    if (!data) return null;

    const tier = data.override_tier as string | null;
    return {
      overrideTier: tier !== null && isTierKey(tier) ? tier : null,
      overrideSeats: (data.override_seats as number | null) ?? null,
      expiresAt: data.expires_at as string,
    };
  },
);

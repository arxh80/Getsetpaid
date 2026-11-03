import "server-only";

// The read queries behind /super/billing: every currently-ACTIVE billing and
// feature override, across every organisation.
//
// A SEPARATE MODULE FROM lib/admin/overrides.ts because that file is
// `"use server"`: every export of a "use server" module becomes a callable
// Server Action endpoint, so a read helper living there would be published
// as an RPC for no reason -- the same split lib/admin/lifecycle.ts /
// lib/admin/lifecycle-list.ts and lib/admin/impersonation.ts /
// lib/admin/impersonation-list.ts already use.
//
// ONLY THE CURRENTLY ACTIVE SET, not full history -- the same argument
// lib/admin/lifecycle-list.ts's header makes for wound-down organisations:
// the complete history of every grant and revoke is in the audit log viewer,
// filtered to organisation.billing_override_* / organisation.
// feature_override_*, which is the paginated surface. This is the WORKING
// list an operator needs to find what is live right now, in order to revoke
// it or to avoid granting a second one that would silently supersede it.
//
// BOUNDED (CLAUDE.md § Non-negotiable rules, "paginate everything"): an
// explicit `.limit()`, with the ceiling stated in the UI if it is ever
// reached.
//
// NAMES LOOKED UP SEPARATELY rather than a PostgREST embed, mirroring
// app/(app)/[orgSlug]/page.tsx's loadVenueNames() convention: a plain
// `.in("id", ids)` second query is one fewer thing to get wrong than an
// embed across two independently-RLS'd tables, for a page that is not on any
// hot path.

import { createClient } from "@/lib/supabase/server";
import type { TierKey } from "@/lib/entitlements/tiers";
import { isTierKey } from "@/lib/entitlements/tiers";

/** The ceiling on each list. Not a page size -- there is no "next" -- but the
 *  bound that keeps the query finite however the platform grows. */
export const OVERRIDE_LIST_LIMIT = 50;

export interface ActiveBillingOverrideRow {
  readonly id: string;
  readonly organisationId: string;
  readonly organisationName: string;
  readonly organisationSlug: string;
  readonly overrideTier: TierKey | null;
  readonly overrideSeats: number | null;
  readonly reason: string;
  readonly startsAt: string;
  readonly expiresAt: string;
}

export interface ActiveFeatureOverrideRow {
  readonly id: string;
  readonly organisationId: string;
  readonly organisationName: string;
  readonly organisationSlug: string;
  /** Usually one of FEATURE_FLAG_KEYS -- but deliberately `string`, not
   * FeatureFlagKey (review M4): if the DB CHECK allowlist is extended before
   * the TS mirror deploys (or a service-role write inserts an unmirrored
   * key), the override is still LIVE, and filtering it out of this list
   * would make it invisible on /super/billing and un-revocable through the
   * UI. The page renders an unknown key raw instead. */
  readonly flagKey: string;
  readonly reason: string;
  readonly startsAt: string;
  readonly expiresAt: string;
}

async function organisationNames(
  ids: readonly string[],
): Promise<Map<string, { name: string; slug: string }>> {
  if (ids.length === 0) return new Map();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organisations")
    .select("id, name, slug")
    .in("id", [...new Set(ids)]);

  if (error) {
    console.error("[admin] organisation name lookup for overrides list failed:", error.message);
    return new Map();
  }

  const map = new Map<string, { name: string; slug: string }>();
  for (const row of data ?? []) {
    map.set(row.id as string, { name: row.name as string, slug: row.slug as string });
  }
  return map;
}

/**
 * Every organisation's currently-active billing override, most recent first.
 *
 * READS THROUGH THE CALLER'S OWN RLS. organisation_billing_overrides_select_
 * platform (20260909000000) is what returns rows across every organisation
 * at all -- requires the platform superuser at aal2. The page above still
 * calls isSuperuser() and notFound()s, because a page that renders an empty
 * list to a stranger has told them the route exists.
 */
export async function listActiveBillingOverrides(): Promise<
  readonly ActiveBillingOverrideRow[]
> {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("organisation_billing_overrides")
    .select("id, organisation_id, override_tier, override_seats, reason, starts_at, expires_at")
    .is("revoked_at", null)
    .lte("starts_at", nowIso)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(OVERRIDE_LIST_LIMIT);

  if (error) {
    // LOUD IN THE LOG, SILENT ON THE PAGE -- the same tolerance
    // lib/admin/lifecycle-list.ts's header accepts for its own read failure:
    // this list is a convenience (the operator revokes by picking a row here,
    // grants by typing a slug), and the audit log viewer has the complete
    // history.
    console.error("[admin] active billing overrides list failed:", error.message);
    return [];
  }

  const rows = data ?? [];
  const names = await organisationNames(rows.map((r) => r.organisation_id as string));

  return rows.map((row) => {
    const org = names.get(row.organisation_id as string);
    const overrideTier = row.override_tier as string | null;
    return {
      id: row.id as string,
      organisationId: row.organisation_id as string,
      organisationName: org?.name ?? "(unknown workspace)",
      organisationSlug: org?.slug ?? "",
      overrideTier: overrideTier !== null && isTierKey(overrideTier) ? overrideTier : null,
      overrideSeats: (row.override_seats as number | null) ?? null,
      reason: row.reason as string,
      startsAt: row.starts_at as string,
      expiresAt: row.expires_at as string,
    };
  });
}

/** Every organisation's currently-active feature override, most recent first.
 *  Same shape and the same caveats as listActiveBillingOverrides() above. */
export async function listActiveFeatureOverrides(): Promise<
  readonly ActiveFeatureOverrideRow[]
> {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("organisation_feature_overrides")
    .select("id, organisation_id, flag_key, reason, starts_at, expires_at")
    .is("revoked_at", null)
    .lte("starts_at", nowIso)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(OVERRIDE_LIST_LIMIT);

  if (error) {
    console.error("[admin] active feature overrides list failed:", error.message);
    return [];
  }

  const rows = data ?? [];
  const names = await organisationNames(rows.map((r) => r.organisation_id as string));

  // NO isFeatureFlagKey() FILTER (review M4): a live override whose flag_key
  // the TS mirror does not recognise must still be listed, or it becomes
  // invisible here and un-revocable through the UI while the DB keeps
  // honouring it. The page falls back to rendering the raw key.
  return rows.map((row) => {
    const org = names.get(row.organisation_id as string);
    return {
      id: row.id as string,
      organisationId: row.organisation_id as string,
      organisationName: org?.name ?? "(unknown workspace)",
      organisationSlug: org?.slug ?? "",
      flagKey: row.flag_key as string,
      reason: row.reason as string,
      startsAt: row.starts_at as string,
      expiresAt: row.expires_at as string,
    };
  });
}

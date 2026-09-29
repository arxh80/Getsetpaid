// Billing + feature overrides: the PURE half -- the feature-flag allowlist,
// tier choices for the grant form, and copy helpers -- with no `server-only`
// marker and no Supabase import.
//
// SAME SPLIT, SAME REASON as lib/admin/lifecycle-contract.ts's header: Client
// Components need these values (to render a <select> of flag keys, to word a
// confirmation) and importing them from a `server-only` module would drag
// cookies() and the server Supabase client into the client bundle, which
// Next.js refuses at build time.
//
// NOTHING HERE IS A CONTROL. supabase/migrations/20260909000000's CHECK
// constraints are the actual allowlists -- FEATURE_FLAG_KEYS below is a
// mirror for the <select> to iterate and for a client-side sentence, not a
// second source of truth. Sending a key not in the CHECK still fails in the
// database (23514 from the table, or the RPC's own pre-check, 22023).

import type { TierKey } from "@/lib/entitlements/tiers";

/**
 * The feature-flag allowlist (DECISIONS-QUEUE Q105): a CHECK constraint on
 * organisation_feature_overrides.flag_key, mirrored here as a plain array
 * because there is exactly one flag today and nothing yet reads a catalogue
 * of descriptions. Extend both the CHECK and this array, in the same
 * migration/commit, the day a second flag ships.
 */
export const FEATURE_FLAG_KEYS = ["early_access_preview"] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return (FEATURE_FLAG_KEYS as readonly string[]).includes(value);
}

export const FEATURE_FLAG_LABELS: Readonly<Record<FeatureFlagKey, string>> = {
  early_access_preview: "Early access preview",
};

/**
 * The tiers a billing override may name. Deliberately ALL THREE, including
 * Free -- an override can lower an organisation's effective tier just as
 * easily as raise it (CLAUDE.md's downgrade-safety rule applies either way:
 * it makes writes read-only/limited, it never deletes anything).
 */
export const OVERRIDE_TIER_CHOICES: readonly TierKey[] = ["free", "starter", "pro"];

export const TIER_CHOICE_LABELS: Readonly<Record<TierKey, string>> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
};

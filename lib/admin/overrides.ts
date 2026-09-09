"use server";

// Billing + feature overrides: the WRITE half -- four Server Actions over the
// four RPCs 20260909000000 ships.
//
// NOTHING IN THIS FILE IS THE ENFORCEMENT, with one exception named below.
// public.grant_billing_override / revoke_billing_override /
// grant_feature_override / revoke_feature_override each carry their own
// superuser guard, their own mandatory-reason check and their own audit
// write, in one transaction, and every INSERT/UPDATE goes through the RLS
// policies 20260909000000 ships. So the raw PostgREST path and the app path
// refuse identically -- the same property lib/admin/lifecycle.ts's header
// establishes for the lifecycle RPCs.
//
// WHAT THIS FILE ADDS:
//   1. STEP-UP RE-AUTHENTICATION, on all four. `amr` freshness lives in the
//      JWT and is read through supabase.auth.getClaims(), which the database
//      cannot see -- this file is the only place it can live. CLAUDE.md
//      § Session security requires step-up before "any high-risk
//      admin/superuser function", and both grants are irreversibly billed
//      consequences until they expire or are revoked.
//   2. A SENTENCE PER REFUSAL. The RPCs raise SQLSTATEs; the mapping to
//      prose happens here, once.
//   3. revalidatePath, which the database cannot do.
//
// THERE IS NO EMAIL. CLAUDE.md § Superuser dashboard says a billing override
// must "notify the org admin automatically" -- there is no notification
// subsystem at MVP (Q45, for the Nth time), so the notification is IN-APP
// ONLY: an admin reads their organisation's active overrides on
// /[orgSlug]/settings (a future task's admin-facing summary) and every
// member sees the "Early access preview" badge on the workspace home for a
// feature override. The email fold-in later in Phase 7 (Q91) is where that
// stops being the whole story -- named here rather than silently left
// unmentioned, the same discipline lib/admin/lifecycle.ts's header applies.

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { checkStepUp } from "@/lib/auth/step-up-gate";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import { isSuperuser } from "@/lib/admin/superuser";
import { londonWallClockToInstant } from "@/lib/format/date";
import { isTierKey } from "@/lib/entitlements/tiers";
import { isFeatureFlagKey } from "@/lib/admin/overrides-contract";

const STEP_UP_REQUIRED =
  "Confirm it’s you before changing a workspace’s billing or features. Use the re-authentication prompt at the top of this page, then try again.";

const NOT_YOURS =
  "That can’t be actioned from here. Reload the page — the override may already have been granted, revoked or have expired.";

const REASON_REQUIRED =
  "Give a reason. It goes on the permanent audit record and is what a later reader has instead of your memory.";

const UNKNOWN_ORG =
  "No workspace has that URL name. Check the slug — it’s the part of the workspace URL after the first slash.";

const BAD_EXPIRY = "Pick a date and time in the future. There is no open-ended override.";

function refuse(message: string, formData: FormData): FormState {
  return { error: message, values: echoedValues(formData) };
}

/**
 * Map a PostgREST error from one of the four RPCs to the sentence it
 * deserves. Same technique as lib/admin/lifecycle.ts's rpcRefusal(): the
 * 22023s are told apart by OUR OWN message text, not a user's, so this is
 * not string-matching on untrusted input.
 */
function rpcRefusal(
  context: string,
  code: string | undefined,
  message: string,
  formData: FormData,
): FormState {
  if (code === "42501") return refuse(NOT_YOURS, formData);
  if (code === "22023") {
    if (message.includes("slug")) return refuse(UNKNOWN_ORG, formData);
    if (message.includes("reason is required")) return refuse(REASON_REQUIRED, formData);
    if (message.includes("expiry")) return refuse(BAD_EXPIRY, formData);
    if (message.includes("override at least")) {
      return refuse(
        "Override the tier, the seat count, or both — an override that changes neither does nothing.",
        formData,
      );
    }
    if (message.includes("unknown flag_key")) {
      return refuse("Pick one of the listed feature flags.", formData);
    }
    // "no active override with that id" -- the revoke refusals.
    const detail = message.split(": ").slice(1).join(": ").trim();
    return refuse(
      detail ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.` : NOT_YOURS,
      formData,
    );
  }
  console.error(`[admin] ${context} failed:`, message);
  return refuse(FAILED_MESSAGE, formData);
}

/** Same shape as lib/admin/lifecycle.ts's authoriseSuperuser(). */
async function authoriseSuperuser(
  formData: FormData,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly state: FormState }> {
  if (!(await getCurrentUser())) {
    return { ok: false, state: refuse(FAILED_MESSAGE, formData) };
  }
  if (!(await isSuperuser())) {
    return { ok: false, state: refuse(NOT_YOURS, formData) };
  }
  if (!(await checkStepUp())) {
    return { ok: false, state: refuse(STEP_UP_REQUIRED, formData) };
  }
  return { ok: true };
}

function revalidateOverrideSurfaces(): void {
  revalidatePath("/super/billing");
  // Every organisation's own home renders the early-access badge and (a
  // later task's) billing summary off these tables, so the affected
  // workspace's own layout cache has to drop too -- the same move
  // lib/admin/lifecycle.ts and lib/admin/impersonation.ts make when a grant
  // changes what a customer's own pages render.
  revalidatePath("/", "layout");
}

export async function grantBillingOverrideAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const gate = await authoriseSuperuser(formData);
  if (!gate.ok) return gate.state;

  const slug = field(formData, "organisationSlug");
  const tierRaw = field(formData, "overrideTier");
  const seatsRaw = field(formData, "overrideSeats");
  const reason = field(formData, "reason");
  const expiresRaw = field(formData, "expiresAt");

  const fieldErrors: Record<string, string> = {};
  if (!slug) fieldErrors.organisationSlug = "Enter the workspace’s URL name.";
  if (!reason) fieldErrors.reason = REASON_REQUIRED;

  const tier = tierRaw && tierRaw !== "" ? tierRaw : null;
  if (tier !== null && !isTierKey(tier)) {
    fieldErrors.overrideTier = "Pick one of the listed tiers.";
  }

  let seats: number | null = null;
  if (seatsRaw !== null) {
    const parsed = Number(seatsRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      fieldErrors.overrideSeats = "Use a whole number of 1 or more, or leave it blank.";
    } else {
      seats = parsed;
    }
  }

  if (tier === null && seats === null && !fieldErrors.overrideTier && !fieldErrors.overrideSeats) {
    fieldErrors.overrideTier =
      "Override the tier, the seat count, or both — an override that changes neither does nothing.";
  }

  let expiresAt: string | null = null;
  if (!expiresRaw) {
    fieldErrors.expiresAt = "Every override needs an expiry — there is no open-ended override.";
  } else {
    expiresAt = londonWallClockToInstant(expiresRaw);
    if (expiresAt === null) {
      fieldErrors.expiresAt = "That doesn’t look like a date and time.";
    } else if (Date.parse(expiresAt) <= Date.now()) {
      fieldErrors.expiresAt = BAD_EXPIRY;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("grant_billing_override", {
    p_organisation_slug: slug,
    p_override_tier: tier,
    p_override_seats: seats,
    p_reason: reason,
    p_expires_at: expiresAt,
  });
  if (error) return rpcRefusal("grant_billing_override", error.code, error.message, formData);

  revalidateOverrideSurfaces();
  return {
    message: `Billing override granted for ${slug}. It reverts automatically when it expires — nothing further to do.`,
  };
}

export async function revokeBillingOverrideAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const gate = await authoriseSuperuser(formData);
  if (!gate.ok) return gate.state;

  const overrideId = field(formData, "overrideId");
  const reason = field(formData, "reason");
  const fieldErrors: Record<string, string> = {};
  if (!overrideId) fieldErrors.overrideId = "Missing override id.";
  if (!reason) fieldErrors.reason = REASON_REQUIRED;
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_billing_override", {
    p_override_id: overrideId,
    p_reason: reason,
  });
  if (error) return rpcRefusal("revoke_billing_override", error.code, error.message, formData);

  revalidateOverrideSurfaces();
  return { message: "Billing override revoked. The workspace’s real plan applies immediately." };
}

export async function grantFeatureOverrideAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const gate = await authoriseSuperuser(formData);
  if (!gate.ok) return gate.state;

  const slug = field(formData, "organisationSlug");
  const flagKey = field(formData, "flagKey");
  const reason = field(formData, "reason");
  const expiresRaw = field(formData, "expiresAt");

  const fieldErrors: Record<string, string> = {};
  if (!slug) fieldErrors.organisationSlug = "Enter the workspace’s URL name.";
  if (!flagKey || !isFeatureFlagKey(flagKey)) {
    fieldErrors.flagKey = "Pick one of the listed feature flags.";
  }
  if (!reason) fieldErrors.reason = REASON_REQUIRED;

  let expiresAt: string | null = null;
  if (!expiresRaw) {
    fieldErrors.expiresAt = "Every override needs an expiry — there is no open-ended override.";
  } else {
    expiresAt = londonWallClockToInstant(expiresRaw);
    if (expiresAt === null) {
      fieldErrors.expiresAt = "That doesn’t look like a date and time.";
    } else if (Date.parse(expiresAt) <= Date.now()) {
      fieldErrors.expiresAt = BAD_EXPIRY;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("grant_feature_override", {
    p_organisation_slug: slug,
    p_flag_key: flagKey,
    p_reason: reason,
    p_expires_at: expiresAt,
  });
  if (error) return rpcRefusal("grant_feature_override", error.code, error.message, formData);

  revalidateOverrideSurfaces();
  return { message: `Feature override granted for ${slug}. It reverts automatically when it expires.` };
}

export async function revokeFeatureOverrideAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const gate = await authoriseSuperuser(formData);
  if (!gate.ok) return gate.state;

  const overrideId = field(formData, "overrideId");
  const reason = field(formData, "reason");
  const fieldErrors: Record<string, string> = {};
  if (!overrideId) fieldErrors.overrideId = "Missing override id.";
  if (!reason) fieldErrors.reason = REASON_REQUIRED;
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_feature_override", {
    p_override_id: overrideId,
    p_reason: reason,
  });
  if (error) return rpcRefusal("revoke_feature_override", error.code, error.message, formData);

  revalidateOverrideSurfaces();
  return { message: "Feature override revoked." };
}

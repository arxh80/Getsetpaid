"use server";

// Organisation lifecycle: the WRITE half -- three Server Actions over the
// three RPCs 20260908030000 ships.
//
// NOTHING IN THIS FILE IS THE ENFORCEMENT, with one exception named below.
// public.suspend_organisation / delete_organisation / reinstate_organisation
// each carry their own superuser guard, their own mandatory-reason check and
// their own audit write, in one transaction, and the UPDATE inside each of
// them goes through organisations_update_platform_lifecycle. So the raw
// PostgREST path -- reachable from any browser with the anon key -- and the
// app path refuse identically.
//
// ===========================================================================
// WHAT THIS FILE ADDS, AND WHY EACH ONE IS NOT REDUNDANT
// ===========================================================================
// 1. STEP-UP RE-AUTHENTICATION, ON ALL THREE. This is the exception: `amr`
//    freshness lives in the JWT and is read through supabase.auth.getClaims(),
//    which revalidates with the auth server -- a Postgres function sees only
//    the decoded claims it was handed, so the database CANNOT check this and
//    this file is the only place it can live. CLAUDE.md § Session security
//    requires step-up before "deleting organisation data" and before "any
//    high-risk admin/superuser function".
//
//    INCLUDING REINSTATE, WHICH IS A DELIBERATE DIVERGENCE FROM
//    lib/admin/impersonation.ts. That file argues at length that ending a
//    session must NOT be gated, because step-up expires in five minutes while
//    the thing it would end runs for sixty, so gating the safety control makes
//    "leave it open" the path of least resistance. The argument does not carry
//    here. Reinstating is not a safety control that stops a running grant; it
//    is a GRANT -- it hands a workspace its writes, its billing consequences
//    and its network presence back. Nothing is running that reinstatement
//    stops, and nothing gets more dangerous while the operator re-authenticates.
//    So all three actions gate, and the asymmetry with impersonation is about
//    which direction each action moves capability, not about which feature it
//    belongs to.
// 2. A SENTENCE PER REFUSAL. The RPCs raise SQLSTATEs; the mapping to prose
//    happens here, once.
// 3. revalidatePath, which the database cannot do -- and it has to reach
//    further than the superuser's own page, because a suspension changes what
//    every route of the affected workspace renders.
//
// ===========================================================================
// THERE IS NO EMAIL. THE CUSTOMER FINDS OUT IN THE APP.
// ===========================================================================
// CLAUDE.md § Superuser dashboard says these actions "notify the org's admin".
// There is no notification subsystem at MVP -- Q45, for the fourth time after
// `reminder_at`, connection requests and impersonation requests -- so the
// notification is IN-APP ONLY: components/org/suspended-banner.tsx states what
// happened, when, what it means for the workspace's network presence, how long
// the data is kept and that it can be reversed, on every route of the affected
// workspace, for every member. The email fold-in later in Phase 7 (Q91) is
// where that stops being the whole story.

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { checkStepUp, mintStepUpToken } from "@/lib/auth/step-up-gate";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import { isSuperuser } from "@/lib/admin/superuser";

const STEP_UP_REQUIRED =
  "Confirm it’s you before changing a workspace’s status. Use the re-authentication prompt at the top of this page, then try again.";

const NOT_YOURS =
  "That can’t be actioned from here. Reload the page — the workspace may already be in that state.";

const CHANGED_CONCURRENTLY =
  "That workspace changed while this ran, so nothing was done. Reload the page and decide again.";

const REASON_REQUIRED =
  "Give a reason. It goes on the permanent audit record and is what a later reader has instead of your memory.";

const UNKNOWN_ORG =
  "No workspace has that URL name. Check the slug — it’s the part of the workspace URL after the first slash.";

function refuse(message: string, formData: FormData): FormState {
  return { error: message, values: echoedValues(formData) };
}

/**
 * Map a PostgREST error from one of the three RPCs to the sentence it
 * deserves.
 *
 * The 22023s are told apart by the message the function raised, which is our
 * own text and not a user's -- so this is not string-matching on untrusted
 * input. It is the same technique lib/admin/impersonation.ts's rpcRefusal()
 * uses, for the same reason: one SQLSTATE, several distinct causes, all of
 * them worth a different sentence.
 */
function rpcRefusal(
  context: string,
  code: string | undefined,
  message: string,
  formData: FormData,
): FormState {
  if (code === "42501") return refuse(NOT_YOURS, formData);
  // 20261028000000 (N1): the workspace changed between the locked read and the
  // UPDATE (40001 lifecycle_changed_concurrently). Nothing was written.
  if (code === "40001") return refuse(CHANGED_CONCURRENTLY, formData);
  if (code === "22023") {
    if (message.includes("slug")) return refuse(UNKNOWN_ORG, formData);
    if (message.includes("reason is required")) return refuse(REASON_REQUIRED, formData);
    // "already suspended" / "already deleted" / "not suspended or deleted" --
    // the state-machine refusals. Echoed rather than paraphrased: the RPC's
    // own wording is accurate and a paraphrase would drift from it.
    const detail = message.split(": ").slice(1).join(": ").trim();
    return refuse(
      detail
        ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`
        : NOT_YOURS,
      formData,
    );
  }
  console.error(`[admin] ${context} failed:`, message);
  return refuse(FAILED_MESSAGE, formData);
}

/**
 * On the allowlist, and a credential presented in the last five minutes.
 *
 * isSuperuser() is the IDENTITY check and is deliberately not aal-gated
 * (lib/admin/superuser.ts); the aal2 requirement is enforced by
 * private.has_platform_permission() inside every RPC. This checks the two
 * things the database cannot see for itself: that the caller is signed in at
 * all, and that step-up is fresh.
 */
async function authoriseSuperuser(
  formData: FormData,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly state: FormState }> {
  if (!(await getCurrentUser())) {
    return { ok: false, state: refuse(FAILED_MESSAGE, formData) };
  }
  if (!(await isSuperuser())) {
    // Not a distinguishing message: nothing to learn here.
    return { ok: false, state: refuse(NOT_YOURS, formData) };
  }
  if (!(await checkStepUp()) || !(await mintStepUpToken("organisation_lifecycle"))) {
    return { ok: false, state: refuse(STEP_UP_REQUIRED, formData) };
  }
  return { ok: true };
}

async function callLifecycleRpc(
  fn: "suspend_organisation" | "delete_organisation" | "reinstate_organisation",
  formData: FormData,
  success: (slug: string) => string,
): Promise<FormState> {
  const gate = await authoriseSuperuser(formData);
  if (!gate.ok) return gate.state;

  const slug = field(formData, "organisationSlug");
  const reason = field(formData, "reason");
  const fieldErrors: Record<string, string> = {};
  if (!slug) fieldErrors.organisationSlug = "Enter the workspace’s URL name.";
  if (!reason) fieldErrors.reason = REASON_REQUIRED;
  if (!slug || !reason || Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, {
    p_organisation_slug: slug,
    p_reason: reason,
  });
  if (error) return rpcRefusal(fn, error.code, error.message, formData);

  revalidatePath("/super/organisations");
  // THE WHOLE APP, NOT JUST THIS PAGE. A lifecycle change alters what every
  // route of the affected workspace renders -- the suspended banner, every
  // write control, the workspace switcher -- and those pages are cached under
  // the customer's own layout, not the operator's. Dropping the layout cache
  // is the same move lib/admin/impersonation.ts makes when a session starts or
  // ends, for the same reason.
  revalidatePath("/", "layout");
  return { message: success(slug) };
}

export async function suspendOrganisationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return callLifecycleRpc(
    "suspend_organisation",
    formData,
    (slug) =>
      `${slug} is suspended. It is read-only now — everyone in it can still read everything, and nobody can change anything. Its members see an explanation on every page.`,
  );
}

export async function deleteOrganisationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return callLifecycleRpc(
    "delete_organisation",
    formData,
    (slug) =>
      `${slug} is closed. Nothing has been deleted — it is read-only, out of the network directory, and can be reopened at any time.`,
  );
}

export async function reinstateOrganisationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return callLifecycleRpc(
    "reinstate_organisation",
    formData,
    (slug) => `${slug} is active again. Writes, and its network presence, are back.`,
  );
}

"use server";

// The Owner closes their own workspace (Phase 8 Task 9c job 3b; founder
// 2026-09-30, Q176/Q178). A thin wrapper over public.close_my_workspace()
// (20261021000000), which is the enforcement: see ./closure-contract.ts.
//
// A "use server" MODULE MAY EXPORT NOTHING BUT ASYNC FUNCTIONS -- every
// constant is in ./closure-contract.ts, and tests/unit/forms/
// use-server-exports-census.test.ts holds this file on its roll.
//
// WHAT THIS FILE ADDS, in order, each refusing before the round trip:
//   1. a session;
//   2. the workspace, re-derived from the slug through the caller's OWN
//      RLS-filtered membership (getCurrentOrg) -- never a client-supplied id;
//   3. the caller is its Owner and is NOT an impersonating superuser (whose
//      role envelope is read_only anyway; the RPC reads the membership row);
//   4. step-up freshness -- the one check no database rule can see;
//   5. aal2 on this session (the RPC re-checks it);
//   6. the typed slug and the reason, against the RPC's own bounds.
// Then the RPC, whose refusals are mapped by HINT.

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { checkStepUp, sessionIsAal2 } from "@/lib/auth/step-up-gate";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, type FormState } from "@/lib/forms";
import {
  CLOSED_MESSAGE,
  CLOSE_MESSAGES,
  checkCloseForm,
  closeRefusalFor,
} from "./closure-contract";

export async function closeMyWorkspaceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = echoedValues(formData);
  if (!(await getCurrentUser())) return { error: CLOSE_MESSAGES.failed, values };

  const slug = formData.get("orgSlug");
  if (typeof slug !== "string" || slug === "" || slug.length > 200) {
    return { error: CLOSE_MESSAGES.notOwner, values };
  }
  // null for a slug that does not exist, belongs to another tenant, or names a
  // membership that is not active -- one sentence for all three (the
  // tenant-isolation rule).
  const org = await getCurrentOrg(slug);
  if (!org || org.isImpersonated || org.role !== "owner") {
    return { error: CLOSE_MESSAGES.notOwner, values };
  }
  if (org.isSuspended) return { error: CLOSE_MESSAGES.notActive, values };

  if (!(await checkStepUp())) return { error: CLOSE_MESSAGES.stepUp, values };
  if (!(await sessionIsAal2())) return { error: CLOSE_MESSAGES.aal2, values };

  const checked = checkCloseForm(formData, org.slug);
  if (!checked.ok) return { fieldErrors: checked.fieldErrors, values };

  const supabase = await createClient();
  const { error } = await supabase.rpc("close_my_workspace", {
    p_organisation_id: org.id,
    p_confirmation: checked.confirmation,
    p_reason: checked.reason,
  });
  if (error) {
    const refusal = closeRefusalFor(error);
    if ("error" in refusal && refusal.error === CLOSE_MESSAGES.failed) {
      console.error("[closure] close_my_workspace refused:", error.code, error.message);
    }
    return { ...refusal, values };
  }

  // Every route of the workspace now renders the read-only banner.
  revalidatePath("/", "layout");
  return { message: CLOSED_MESSAGE };
}

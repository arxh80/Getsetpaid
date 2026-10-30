"use server";

// The superuser's two decisions on a workspace its Owner closed (Phase 8 Task
// 9c job 3a; founder 2026-09-30, Q176/Q178): reassign it to a new Owner, or
// delete it permanently. Thin wrappers over public.reassign_closed_workspace
// and public.delete_closed_workspace (20261022001000).
//
// NOTHING HERE IS THE ENFORCEMENT except step-up freshness. Both RPCs check, in
// the database and in this order: a session, the platform superuser, aal2, the
// reason (trimmed, <= 500), the slug, owner_closed (row locked) -- and
// reassign additionally that the new Owner is an ACTIVE member of THAT
// workspace. So the slug and user id this file passes on are client-supplied
// and that is safe: the RPC re-derives the organisation from the slug, and
// re-checks the membership against it. A forged user id from another tenant
// is refused there (new_owner_must_be_active_member).
//
// WHAT THIS FILE ADDS (the lib/admin/lifecycle.ts pattern):
//   1. STEP-UP, which only the server can see (amr freshness is in the JWT).
//   2. Shape validation before the round trip: a bounded slug, uuid grammar, a
//      reason within the RPC's bound, and -- for DELETE only -- the operator
//      retyping the slug, because deletion is the one decision on this page
//      that nothing reverses.
//   3. A sentence per refusal, keyed on the RPC's own HINT (our text, not a
//      user's).
//   4. revalidatePath across the app: a reassign reopens a workspace whose
//      every route renders a closed banner today.

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { checkStepUp, mintStepUpToken } from "@/lib/auth/step-up-gate";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import { isSuperuser } from "@/lib/admin/superuser";

const STEP_UP_REQUIRED =
  "Confirm it’s you before deciding a closed workspace. Use the re-authentication prompt at the top of this page, then try again.";
const NOT_YOURS =
  "That can’t be actioned from here. Reload the page — the workspace may already have been decided.";
const REASON_REQUIRED =
  "Give a reason. It goes on the permanent audit record and is what a later reader has instead of your memory.";
const REASON_TOO_LONG = "Keep the reason to 500 characters or fewer.";
const NOT_OWNER_CLOSED =
  "That workspace is no longer awaiting a decision. Reload the page — someone may already have decided it.";
const OWNER_REQUIRED = "Pick the member who becomes the new Owner.";
const OWNER_NOT_MEMBER =
  "That person is no longer an active member of this workspace. Reload the page and pick again.";
const BACKUP_NOT_SUCCEEDED =
  "This workspace’s backup has not succeeded. Tick “Delete without a backup” to delete it anyway — that is recorded on the audit log.";
const CONFIRM_MISMATCH =
  "Type the workspace’s URL name exactly to confirm. Permanent deletion cannot be undone.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;

function refuse(message: string, formData: FormData): FormState {
  return { error: message, values: echoedValues(formData) };
}

function rpcRefusal(
  context: string,
  error: { code?: string; message: string; hint?: string | null },
  formData: FormData,
): FormState {
  switch (error.hint) {
    case "decision_needs_step_up":
      return refuse(STEP_UP_REQUIRED, formData);
    case "decision_reason_required":
      return { fieldErrors: { reason: REASON_REQUIRED }, values: echoedValues(formData) };
    case "decision_reason_too_long":
      return { fieldErrors: { reason: REASON_TOO_LONG }, values: echoedValues(formData) };
    case "decision_no_such_workspace":
    case "decision_workspace_not_owner_closed":
    // 20261028000000 (N1): it moved under the decision.
    case "lifecycle_changed_concurrently":
      return refuse(NOT_OWNER_CLOSED, formData);
    case "decision_backup_not_succeeded":
      return { fieldErrors: { acknowledgeNoBackup: BACKUP_NOT_SUCCEEDED }, values: echoedValues(formData) };
    case "new_owner_must_be_active_member":
      return { fieldErrors: { newOwnerUserId: OWNER_NOT_MEMBER }, values: echoedValues(formData) };
  }
  if (error.code === "42501") return refuse(NOT_YOURS, formData);
  console.error(`[admin] ${context} failed:`, error.message);
  return refuse(FAILED_MESSAGE, formData);
}

async function authorise(formData: FormData): Promise<FormState | null> {
  if (!(await getCurrentUser())) return refuse(FAILED_MESSAGE, formData);
  if (!(await isSuperuser())) return refuse(NOT_YOURS, formData);
  if (!(await checkStepUp()) || !(await mintStepUpToken("closure_decision"))) {
    return refuse(STEP_UP_REQUIRED, formData);
  }
  return null;
}

/** Slug and reason, shape-checked. Returns the field errors, or the values. */
function common(
  formData: FormData,
):
  | { readonly ok: true; readonly slug: string; readonly reason: string }
  | { readonly ok: false; readonly state: FormState } {
  const slug = field(formData, "organisationSlug");
  if (!slug || slug.length > 200) return { ok: false, state: refuse(NOT_OWNER_CLOSED, formData) };
  const reason = field(formData, "reason");
  if (!reason) {
    return { ok: false, state: { fieldErrors: { reason: REASON_REQUIRED }, values: echoedValues(formData) } };
  }
  if (reason.length > REASON_MAX) {
    return { ok: false, state: { fieldErrors: { reason: REASON_TOO_LONG }, values: echoedValues(formData) } };
  }
  return { ok: true, slug, reason };
}

function revalidate(): void {
  revalidatePath("/super/closures");
  revalidatePath("/", "layout");
}

export async function reassignClosedWorkspaceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const denied = await authorise(formData);
  if (denied) return denied;
  const base = common(formData);
  if (!base.ok) return base.state;
  const newOwner = field(formData, "newOwnerUserId");
  if (!newOwner || !UUID.test(newOwner)) {
    return { fieldErrors: { newOwnerUserId: OWNER_REQUIRED }, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("reassign_closed_workspace", {
    p_organisation_slug: base.slug,
    p_new_owner_user_id: newOwner,
    p_reason: base.reason,
  });
  if (error) return rpcRefusal("reassign_closed_workspace", error, formData);

  revalidate();
  return {
    message: `${base.slug} is reopened under its new Owner. Writes are back for everyone in it, and its remaining Owners and Admins are emailed.`,
    values: { organisationSlug: base.slug },
  };
}

export async function deleteClosedWorkspaceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const denied = await authorise(formData);
  if (denied) return denied;
  const base = common(formData);
  if (!base.ok) return base.state;
  // Retyped, exactly -- no trimming beyond field()'s, no case-folding.
  if (field(formData, "confirmSlug") !== base.slug) {
    return { fieldErrors: { confirmSlug: CONFIRM_MISMATCH }, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  // N3a (20261028002000): the RPC refuses unless the backup succeeded or this
  // is true; the database decides, this only carries the operator's tick.
  const { error } = await supabase.rpc("delete_closed_workspace", {
    p_organisation_slug: base.slug,
    p_reason: base.reason,
    p_acknowledge_no_backup: field(formData, "acknowledgeNoBackup") === "yes",
  });
  if (error) return rpcRefusal("delete_closed_workspace", error, formData);

  revalidate();
  return {
    message: `${base.slug} is marked for permanent deletion. The hourly sweep removes its files and then its records; its remaining Owners and Admins are emailed.`,
    values: { organisationSlug: base.slug },
  };
}

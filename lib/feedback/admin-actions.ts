"use server";

// The one write /super/feedback carries: the founder's manual status flag
// (New / Read / Actioned / Archived).
//
// A PLAIN RLS-GATED UPDATE, the incident-alert resolve's shape and for its
// reasons: this is bookkeeping on platform operational metadata that only the
// operator can read -- not a high-risk action on a tenant -- so no step-up
// and no reason field. It IS audited, from an AFTER UPDATE trigger
// (private.audit_feedback_status_change(), 20260911000000) rather than from
// here, because `feedback` carries a client UPDATE(status) grant and a raw
// PATCH from the operator's own browser is a real path no call site could
// cover. The column-level grant plus private.feedback_update_guard() keep
// every other column immutable whatever this action sends.

import { revalidatePath } from "next/cache";
import { isSuperuser } from "@/lib/admin/superuser";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import {
  FEEDBACK_STATUS_LABELS,
  UUID_RE,
  isFeedbackStatus,
} from "@/lib/feedback/contract";

export async function updateFeedbackStatusAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // Picks the sentence a non-superuser gets; the policy is the enforcement.
  if (!(await isSuperuser())) return { error: FAILED_MESSAGE, values: {} };

  const feedbackId = formData.get("feedbackId");
  const status = formData.get("status");
  if (
    typeof feedbackId !== "string" ||
    !UUID_RE.test(feedbackId) ||
    typeof status !== "string" ||
    !isFeedbackStatus(status)
  ) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  // `.neq("status", status)`: a no-op change matches nothing rather than
  // writing an audit row that says "read -> read".
  const { data, error } = await supabase
    .from("feedback")
    .update({ status })
    .eq("id", feedbackId)
    .neq("status", status)
    .select("id");

  if (error) {
    console.error("[feedback] status update failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if ((data ?? []).length === 0) {
    return {
      error: "That submission is already at that status — reload the page to see its current state.",
      values: echoedValues(formData),
    };
  }

  revalidatePath("/super/feedback");
  return { message: `Marked ${FEEDBACK_STATUS_LABELS[status]}.`, values: {} };
}

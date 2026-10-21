"use server";

// The requester's two writes: make a request, and withdraw one.
//
// NOTHING HERE IS THE ENFORCEMENT. `submit_data_subject_request` takes no user
// argument and the database stamps the session's; the 30-day deadline is a
// generated column; the meter is a BEFORE INSERT trigger; withdrawal is
// refused by that trigger for anyone but the requester. What this file adds is
// a sentence per refusal and a revalidate.
//
// WITHDRAWING IS ONE BUTTON AND NO CONFIRMATION, the consent page's rule
// applied to a second surface: undoing must never be harder than doing.

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { formatRetryAfter } from "@/lib/format/duration";
import {
  ACCOUNT_DATA_REQUESTS_PATH,
  DSR_DETAIL_MAX,
  DSR_RESPONSE_DAYS,
  UUID_RE,
  isDsrRight,
  isDsrScope,
} from "./contract";

/** The submission window, SECURITY.md § 5. Only used when the database failed
 *  to say how long is left, which the trigger always does. */
const DSR_WINDOW_SECONDS = 86_400;

const FAILED =
  "Your request could not be sent just now. Nothing was recorded — please try again.";
const SUBMITTED = `Your request has been sent. We will respond within ${DSR_RESPONSE_DAYS} days.`;
const WITHDRAWN = "Your request has been withdrawn. You can make a new one at any time.";
const NOT_WITHDRAWABLE =
  "That request is already closed, so there is nothing to withdraw. Reload the page to see its current state.";

export async function submitDataSubjectRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: "Your session has ended. Sign in again to make a request." };
  }

  const rightType = field(formData, "rightType") ?? "";
  const subjectScope = field(formData, "subjectScope") ?? "";
  const detail = (field(formData, "detail") ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (!isDsrRight(rightType)) fieldErrors.rightType = "Choose what you are asking for.";
  if (!isDsrScope(subjectScope)) fieldErrors.subjectScope = "Choose which data the request is about.";
  if (detail === "") fieldErrors.detail = "Say what you are asking for.";
  else if (detail.length > DSR_DETAIL_MAX) {
    fieldErrors.detail = `Keep this under ${DSR_DETAIL_MAX.toLocaleString("en-GB")} characters.`;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: "Check the form and try again.", fieldErrors, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_data_subject_request", {
    p_right_type: rightType,
    p_subject_scope: subjectScope,
    p_detail: detail,
  });

  revalidatePath(ACCOUNT_DATA_REQUESTS_PATH);

  if (!error) return { message: SUBMITTED, values: {} };

  if (error.code === "PT429") {
    const seconds = Number(error.hint);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      console.error("[dsr] PT429 arrived without a usable hint:", error.hint);
    }
    return {
      error:
        `You have made several requests today. You can make another in ${formatRetryAfter(
          Number.isFinite(seconds) && seconds > 0 ? seconds : DSR_WINDOW_SECONDS,
        )} — or email us, which is never limited.`,
      values: echoedValues(formData),
    };
  }
  if (error.code === "22023" && error.hint === "no_account_email") {
    return {
      error:
        "Your account has no email address on it, so we have nowhere to send a response. Add one first.",
      values: echoedValues(formData),
    };
  }
  console.error("[dsr] submit_data_subject_request failed:", error.code, error.message);
  return { error: FAILED, values: echoedValues(formData) };
}

export async function withdrawDataSubjectRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: "Your session has ended. Sign in again to withdraw a request." };
  }
  const requestId = field(formData, "requestId") ?? "";
  if (!UUID_RE.test(requestId)) return { error: FAILED };

  const supabase = await createClient();
  const { error } = await supabase.rpc("withdraw_data_subject_request", {
    p_request_id: requestId,
  });

  revalidatePath(ACCOUNT_DATA_REQUESTS_PATH);

  if (!error) return { message: WITHDRAWN };
  if (error.code === "22023" && error.hint === "not_withdrawable") {
    return { error: NOT_WITHDRAWABLE };
  }
  console.error("[dsr] withdraw_data_subject_request failed:", error.code, error.message);
  return { error: FAILED };
}

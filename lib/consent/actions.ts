"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { field, type FormState } from "@/lib/forms";
import { formatRetryAfter } from "@/lib/format/duration";
import { ACCOUNT_PRIVACY_PATH, MARKETING_EMAIL } from "./catalogue";

// ONE ACTION FOR BOTH DIRECTIONS, deliberately. "Withdrawing is exactly as
// easy as granting" is easiest to keep true when the two are the same code
// path: the same form, the same single button, the same confirmation (none),
// differing only in the value of `choice`. A withdrawal cannot acquire a
// confirmation step, a re-authentication or a rate limit without the grant
// visibly acquiring it too -- and the database refuses to meter withdrawals
// at all (20260923000000).
//
// Nothing here is trusted for attribution: record_consent() takes no user
// argument and the database stamps the session's. The version posted with a
// GRANT is the one the page rendered, and the database refuses it unless it
// is still the published one -- so a stale screen gets a sentence, never a
// record of agreeing to text the person did not see.

/** The grant window, SECURITY.md § 5. Only used when the database failed to
 *  say how long is left, which the trigger always does. */
const CONSENT_WINDOW_SECONDS = 3600;

const GRANTED = "You have agreed to marketing email. You can withdraw at any time here.";
const WITHDRAWN = "You have withdrawn your agreement to marketing email.";
const STALE =
  "The Marketing and Communications Preferences page has changed since this screen loaded. Read the current version below, then choose again.";
const ALREADY_GRANTED = "You had already agreed to marketing email — nothing changed.";
const NOT_GRANTED = "You had not agreed to marketing email, so there was nothing to withdraw.";
const FAILED = "Your choice could not be saved just now. Nothing changed — please try again.";

export async function setMarketingConsentAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: "Your session has ended. Sign in again to change this." };
  }

  const choice = field(formData, "choice");
  if (choice !== "grant" && choice !== "withdraw") {
    return { error: FAILED };
  }

  let policyVersion: number | null = null;
  if (choice === "grant") {
    const raw = field(formData, "policyVersion") ?? "";
    policyVersion = /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : null;
    if (policyVersion === null) {
      return { error: STALE };
    }
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("record_consent", {
    p_purpose: MARKETING_EMAIL.purpose,
    p_action: choice === "grant" ? "granted" : "withdrawn",
    p_policy_version: policyVersion,
    p_statement: MARKETING_EMAIL.statementId,
  });

  // Whatever happened, the page must show the ledger as it now is.
  revalidatePath(ACCOUNT_PRIVACY_PATH);

  if (!error) {
    return { message: choice === "grant" ? GRANTED : WITHDRAWN };
  }

  if (error.code === "PT429") {
    const seconds = Number(error.hint);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      console.error("[consent] PT429 arrived without a usable hint:", error.hint);
    }
    return {
      error: `You have changed this too many times in the last hour. Try again in ${formatRetryAfter(
        Number.isFinite(seconds) && seconds > 0 ? seconds : CONSENT_WINDOW_SECONDS,
      )}.`,
    };
  }
  if (error.code === "22023") {
    switch (error.hint) {
      case "stale_policy_version":
        return { error: STALE };
      case "already_granted":
        return { message: ALREADY_GRANTED };
      case "not_granted":
        return { message: NOT_GRANTED };
    }
  }
  console.error("[consent] record_consent failed:", error.code, error.message);
  return { error: FAILED };
}

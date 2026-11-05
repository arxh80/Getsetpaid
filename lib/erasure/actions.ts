"use server";

// Asking for an account to be deleted, from the two places it can be asked
// from: the person themselves, and the operator answering their statutory
// request.
//
// A "use server" MODULE MAY EXPORT NOTHING BUT ASYNC FUNCTIONS. Every
// constant and every message in here lives in ./contract.ts, which is not a
// "use server" module — a single `export const` added to this file would
// silently drop EVERY export from it for the client and SSR graphs and take
// the page down, invisibly to lint, tsc and the unit suite. Phase 8 Task 3
// shipped exactly that; tests/unit/forms/use-server-exports-census.test.ts is
// the census it earned, and this file is on its roll.
//
// NOTHING HERE IS THE ENFORCEMENT. `public.erasure_jobs` carries a client
// INSERT grant, so a scripted POST straight to PostgREST is a real path: the
// attribution (the subject is the SESSION's, whatever the insert named), the
// Q131 last-owner guard, the "one live job" rule and the rate limit are all
// at the insert, in `private.erasure_jobs_before_insert()`. What this file
// adds is the step-up gate — which IS app-side, because "was a credential
// presented in the last five minutes" is a fact about a JWT that no database
// rule can see — the typed confirmation, and honest copy.

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { checkStepUp, mintStepUpToken } from "@/lib/auth/step-up-gate";
import { createClient } from "@/lib/supabase/server";
import { formatRetryAfter } from "@/lib/format/duration";
import type { FormState } from "@/lib/forms";
import {
  ACCOUNT_ERASE_PATH,
  ERASURE_ALREADY_RUNNING,
  ERASURE_NEEDS_CONFIRMATION,
  ERASURE_NEEDS_STEP_UP,
  ERASURE_RATE_LIMITED_PREFIX,
  ERASURE_STARTED_MESSAGE,
  confirmationMatches,
} from "./contract";
import { nudgeErasureRunner } from "./runner";

/**
 * A person deletes their own account.
 *
 * Three app-side gates before the insert, in the order that spends the least
 * on a refusal: a session, the typed phrase, then step-up. The typed phrase
 * is before step-up deliberately — being asked to re-authenticate and THEN
 * told the confirmation box was empty is the worst order there is.
 */
export async function startAccountErasureAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Sign in to delete your account." };

  const typed = formData.get("confirmation");
  if (!confirmationMatches(typeof typed === "string" ? typed : null)) {
    return { error: ERASURE_NEEDS_CONFIRMATION };
  }

  // STEP-UP. CLAUDE.md § Session security names "deleting organisation data";
  // deleting a person's own account is the same class and is irreversible,
  // which the export next door is not.
  if (!(await checkStepUp()) || !(await mintStepUpToken("account_erasure"))) {
    return { error: ERASURE_NEEDS_STEP_UP };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("erasure_jobs").insert({ kind: "account" });
  const refusal = refusalFor(error);
  if (refusal) return { error: refusal };

  nudgeErasureRunner();
  revalidatePath(ACCOUNT_ERASE_PATH);
  return { message: ERASURE_STARTED_MESSAGE };
}

/**
 * Turn the database's refusal into a sentence, or null when there was none.
 *
 * Not exported: a "use server" module may export nothing but async functions.
 */
function refusalFor(
  error: { code?: string; message?: string; hint?: string | null } | null,
): string | null {
  if (!error) return null;

  // PT429 from private.erasure_jobs_before_insert(). The seconds left are in
  // `hint`, rendered as a duration because a person reads durations.
  if (error.code === "PT429") {
    const seconds = Number.parseInt(error.hint ?? "", 10);
    const wait =
      Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${formatRetryAfter(seconds)}.` : "";
    return `${ERASURE_RATE_LIMITED_PREFIX}${wait}`;
  }

  // 23505 from erasure_jobs_one_live_account_job.
  if (error.code === "23505") return ERASURE_ALREADY_RUNNING;

  // 22023 + last_owner_of_workspace: the Q131 guard, whose own message names
  // the workspaces and says what to do. It is written for the person, so it
  // is shown rather than replaced.
  if (error.code === "22023" && error.hint === "last_owner_of_workspace") {
    return error.message ?? "You are the last owner of a workspace, so this cannot be done yet.";
  }

  if (error.code === "42501") {
    return "That account cannot be deleted from here.";
  }

  console.error("[erasure] start refused:", error.code, error.message);
  return "Your account could not be deleted just now. Nothing has changed — please try again.";
}

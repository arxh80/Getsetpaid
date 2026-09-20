"use server";

// Starting an export. Two actions because there are two controllers (Q132),
// and they differ in exactly two things: whether a workspace is named, and
// whether step-up is required.
//
// A "use server" MODULE MAY EXPORT NOTHING BUT ASYNC FUNCTIONS. Every
// constant and every message in here lives in ./contract.ts, which is not a
// "use server" module — a single `export const` added to this file would
// silently drop EVERY export from it for the client and SSR graphs and take
// the page down, invisibly to lint, tsc and the unit suite. Phase 8 Task 3
// shipped exactly that; tests/unit/forms/use-server-exports-census.test.ts is
// the census it earned, and this file is on its roll.
//
// NOTHING HERE IS THE ENFORCEMENT. public.export_jobs carries a client INSERT
// grant, so a scripted POST straight to PostgREST is a real path: the
// permission check, the attribution, the "one live job" rule and the rate
// limit are all at the insert, in private.export_jobs_before_insert() and the
// INSERT policy beside it. What this file adds is the step-up gate — which
// IS app-side, because "was a credential presented in the last five minutes"
// is a fact about a JWT that no database rule can see — and honest copy.

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { checkStepUp } from "@/lib/auth/step-up-gate";
import { createClient } from "@/lib/supabase/server";
import { formatRetryAfter } from "@/lib/format/duration";
import type { FormState } from "@/lib/forms";
import {
  ACCOUNT_EXPORTS_PATH,
  EXPORT_ALREADY_RUNNING,
  EXPORT_RATE_LIMITED_PREFIX,
  EXPORT_STARTED_MESSAGE,
  workspaceExportPath,
} from "./contract";
import { nudgeExportRunner } from "./runner";

export async function startAccountExportAction(
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Sign in to export your data." };

  const supabase = await createClient();
  const { error } = await supabase.from("export_jobs").insert({ kind: "account" });
  const refusal = refusalFor(error);
  if (refusal) return { error: refusal };

  nudgeExportRunner();
  revalidatePath(ACCOUNT_EXPORTS_PATH);
  return { message: EXPORT_STARTED_MESSAGE };
}

export async function startWorkspaceExportAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = formData.get("orgSlug");
  if (typeof slug !== "string" || slug === "") {
    return { error: "That workspace could not be exported." };
  }

  const user = await getCurrentUser();
  if (!user) return { error: "Sign in to export this workspace." };

  // getCurrentOrg() returns null for a slug that does not exist, belongs to
  // another tenant, or names a membership that is not active — and does not
  // distinguish them, which is the tenant-isolation rule. One sentence for
  // all three.
  const org = await getCurrentOrg(slug);
  if (!org) return { error: "That workspace could not be exported." };

  // STEP-UP. CLAUDE.md § Session security names "large data exports"
  // explicitly, and a workspace export is the largest thing this product
  // hands out. The account export is deliberately NOT gated: it is the
  // person's own data about themselves, the statutory route must not be the
  // only route, and a prompt on it would make exercising a right harder than
  // exercising it through a form.
  if (!(await checkStepUp())) {
    return {
      error:
        "Confirm it is you before exporting this workspace. Use the prompt on this page, then start the export again.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("export_jobs")
    .insert({ kind: "workspace", organisation_id: org.id });
  const refusal = refusalFor(error);
  if (refusal) return { error: refusal };

  nudgeExportRunner();
  revalidatePath(workspaceExportPath(slug));
  return { message: EXPORT_STARTED_MESSAGE };
}

/**
 * Turn the database's refusal into a sentence, or null when there was none.
 *
 * Not exported: a "use server" module may export nothing but async
 * functions, and a helper that is not a Server Action must therefore stay
 * local (or move to contract.ts, which is where everything testable already
 * is).
 */
function refusalFor(
  error: { code?: string; message?: string; hint?: string | null } | null,
): string | null {
  if (!error) return null;

  // PT429 from private.export_jobs_before_insert(). The seconds left are in
  // `hint`, rendered in minutes because a person reads minutes.
  if (error.code === "PT429") {
    const seconds = Number.parseInt(error.hint ?? "", 10);
    const wait = Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${formatRetryAfter(seconds)}.` : "";
    return `${EXPORT_RATE_LIMITED_PREFIX}${wait}`;
  }

  // 23505 from export_jobs_one_live_account_job / _workspace_job.
  if (error.code === "23505") return EXPORT_ALREADY_RUNNING;

  if (error.code === "42501") {
    return "You do not have permission to export this workspace.";
  }

  console.error("[export] start refused:", error.code, error.message);
  return "The export could not be started just now. Nothing has changed — please try again.";
}

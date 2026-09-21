"use server";

// The two writes /super/health's retention panel carries (Phase 8 Task 6,
// requirement 4): the kill switch, and the dry run.
//
// BOTH ARE BEHIND STEP-UP, and that is a deliberate difference from the
// incident-alert resolve beside them. Resolving an alert is bookkeeping on a
// flag; these two are "any high-risk admin/superuser function" in CLAUDE.md
// § Session security's sense — one of them stops the product enforcing its own
// published retention policy, and the other one runs the machinery that
// deletes the audit log, in preview.
//
// THE DRY RUN IS THE LIGHTER OF THE TWO AND IS STILL GATED. It deletes
// nothing — every sweep counts from the same query and returns — but it is
// the only control on any page that reaches the retention runner at all, and
// a preview is one parameter away from not being one. Gating it costs the
// founder one re-auth and removes the whole question.
//
// A PLAIN <form action>, no client JS: the same progressive-enhancement rule
// as every other form in this product (lib/forms.ts).

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { isSuperuser } from "@/lib/admin/superuser";
import { checkStepUp } from "@/lib/auth/step-up-gate";
import { createClient } from "@/lib/supabase/server";
import { runRetentionSweep } from "@/lib/retention/runner";
import { echoedValues, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";

const STEP_UP_REQUIRED =
  "Confirm it’s you first — re-enter your credentials, then try again.";
const MAX_REASON = 500;

async function authorise(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; state: FormState }> {
  // Server actions are public endpoints; everything is untrusted. The RPC's
  // own private.has_platform_permission() and the tables' policies are the
  // enforcement — these checks pick the sentence, and pick the same one a
  // non-superuser gets everywhere else on /super: nothing that confirms the
  // control exists.
  if (!(await getCurrentUser()) || !(await isSuperuser())) {
    return { ok: false, state: { error: FAILED_MESSAGE, values: {} } };
  }
  if (!(await checkStepUp())) {
    return {
      ok: false,
      state: { error: STEP_UP_REQUIRED, values: echoedValues(formData) },
    };
  }
  return { ok: true };
}

export async function setRetentionEnabledAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const gate = await authorise(formData);
  if (!gate.ok) return gate.state;

  // BOTH SWITCHES ARE SENT ON EVERY SUBMIT, because the RPC requires both:
  // a form that posted only the one being changed would silently re-enable
  // the other by omission. The hidden fields carry the current state of the
  // switch the operator is not touching.
  const enabled = formData.get("enabled") === "true";
  const auditPurgeEnabled = formData.get("auditPurgeEnabled") === "true";
  const reason = String(formData.get("reason") ?? "").trim();

  if (reason === "") {
    return {
      fieldErrors: { reason: "Say why — it goes into the audit record." },
      values: echoedValues(formData),
    };
  }
  if (reason.length > MAX_REASON) {
    return {
      fieldErrors: { reason: `Keep it under ${MAX_REASON} characters.` },
      values: echoedValues(formData),
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_retention_enabled", {
    p_enabled: enabled,
    p_audit_purge_enabled: auditPurgeEnabled,
    p_reason: reason,
  });
  if (error) {
    console.error("[admin] the retention switches could not be changed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  revalidatePath("/super/health");
  return {
    message: `Saved. The retention job is ${enabled ? "running" : "stopped"}; the audit purge is ${
      auditPurgeEnabled ? "running" : "stopped"
    }.`,
    values: {},
  };
}

export async function previewRetentionRunAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const gate = await authorise(formData);
  if (!gate.ok) return gate.state;

  // `dry: true` all the way down: start_retention_run() records the mode on
  // the row, every sweep counts instead of deleting, and the runner skips the
  // Storage removals too. What comes back is a row on the panel below, marked
  // `dry`, which is where the founder reads the numbers — this sentence is
  // the receipt, not the report.
  const result = await runRetentionSweep({ dry: true });

  if (result.outcome === "unavailable") {
    return {
      error:
        "The preview couldn’t run — the server-side key it needs isn’t configured on this deployment.",
      values: {},
    };
  }
  if (result.outcome === "refused") {
    return {
      message:
        "Nothing was previewed: the retention job is switched off. Turn it back on to see what a run would remove.",
      values: {},
    };
  }
  if (result.outcome === "failed") {
    return {
      error: "The preview failed. The run below says which sweep refused.",
      values: {},
    };
  }

  revalidatePath("/super/health");
  return {
    message: `Preview complete. It would remove ${result.objectsNamed} stored file${
      result.objectsNamed === 1 ? "" : "s"
    }; the run below has the row counts. Nothing was deleted.`,
    values: {},
  };
}

"use server";

// The one write /super/health carries: resolving (or reopening) an incident
// alert.
//
// DELIBERATELY LIGHTER THAN EVERY OTHER ADMIN WRITE HERE, and the difference
// is what the write touches. Lifecycle, impersonation and overrides all act
// ON A TENANT -- so they ride audited RPCs, step-up, mandatory reasons and
// transition markers. Resolving an alert changes one flag on a row of
// PLATFORM OPERATIONAL METADATA that the operator alone can read: it is
// bookkeeping, not a high-risk superuser function (CLAUDE.md § Session
// security's step-up list), so it is a plain RLS-gated UPDATE. The row still
// records who resolved it and when -- private.incident_alert_resolution_
// guard() (20260909020000) forces resolved_by to the caller and refuses any
// other column -- so the accountability is IN the row rather than in
// audit_events. The brief: "a simple resolved flag, no escalation machinery".
//
// A PLAIN <form action>, no client JS: same progressive-enhancement rule as
// every other form in this product (lib/forms.ts).

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { isSuperuser } from "@/lib/admin/superuser";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveIncidentAlertAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // Server actions are public endpoints; everything is untrusted. The RLS
  // policy + guard trigger are the enforcement -- this check only picks the
  // sentence a non-superuser gets, and it matches what every /super page
  // says to them: nothing.
  if (!(await isSuperuser())) {
    return { error: FAILED_MESSAGE, values: {} };
  }

  const user = await getCurrentUser();
  const alertId = formData.get("alertId");
  const reopen = formData.get("reopen") === "true";

  if (user === null || typeof alertId !== "string" || !UUID_RE.test(alertId)) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const update = supabase
    .from("incident_alerts")
    .update(
      reopen
        ? { resolved_at: null, resolved_by: null }
        : { resolved_at: new Date().toISOString(), resolved_by: user.id },
    )
    .eq("id", alertId);
  // Idempotence: resolving an already-resolved alert (a double submit, two
  // tabs) matches nothing rather than silently re-stamping a later time over
  // the first resolver's; reopening an open one likewise.
  const { data, error } = await (reopen
    ? update.not("resolved_at", "is", null)
    : update.is("resolved_at", null)
  ).select("id");

  if (error) {
    console.error("[admin] incident alert resolve failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if ((data ?? []).length === 0) {
    return {
      error:
        "That alert has already been updated — reload the page to see its current state.",
      values: echoedValues(formData),
    };
  }

  revalidatePath("/super/health");
  return { message: reopen ? "Alert reopened." : "Alert resolved.", values: {} };
}

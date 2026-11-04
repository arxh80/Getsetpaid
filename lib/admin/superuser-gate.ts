import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { isSuperuser } from "@/lib/admin/superuser";
import { checkStepUp } from "@/lib/auth/step-up-gate";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import { echoedValues, type FormState } from "@/lib/forms";

// The gate every /super Server Action runs first. It lives outside the
// "use server" modules that call it because there every export would become a
// callable action, and outside lib/admin/superuser.ts so a test that stubs
// isSuperuser() stubs it here too.
//
// isSuperuser() is the IDENTITY check and is deliberately not aal-gated
// (lib/admin/superuser.ts); the aal2 requirement is enforced by
// private.has_platform_permission() inside every RPC. This checks the two
// things the database cannot see for itself: that the caller is signed in at
// all, and, when `stepUp` carries a message, that step-up is fresh.
//
// Returns the refusal to hand back, or null when the action may proceed.
export async function authoriseSuperuser(
  formData: FormData,
  messages: { notSuperuser: string; stepUp: string | null },
): Promise<FormState | null> {
  const refuse = (error: string): FormState => ({ error, values: echoedValues(formData) });
  if (!(await getCurrentUser())) return refuse(FAILED_MESSAGE);
  // Not a distinguishing message: the module's ordinary refusal, nothing to learn.
  if (!(await isSuperuser())) return refuse(messages.notSuperuser);
  if (messages.stepUp && !(await checkStepUp())) return refuse(messages.stepUp);
  return null;
}

"use server";

// Server Action backing the reusable re-auth prompt
// (components/auth/reauth-prompt.tsx), which components/auth/step-up-gate.tsx
// renders whenever checkStepUp() says the current session's last credential
// use is stale. Re-entering the password here is exactly the event
// isStepUpSatisfied() looks for -- a "password" amr entry timestamped now --
// so the very next render of the gate sees a fresh session.
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "./index";
import { safeNextPath } from "./redirects";
import { field, type FormState } from "@/lib/forms";

export async function reauthenticateAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const password = field(formData, "password");
  const next = safeNextPath(field(formData, "next"));

  if (!password) {
    return { fieldErrors: { password: "Enter your password." } };
  }

  const user = await getCurrentUser();
  if (!user?.email) {
    // No session at all -- send them through the normal front door rather
    // than failing this form in a confusing way.
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: user.email,
    password,
  });

  if (error) {
    // Same one-message rule as signInAction: never confirm or deny which
    // part was wrong.
    return { error: "That password wasn't right. Try again." };
  }

  redirect(next);
}

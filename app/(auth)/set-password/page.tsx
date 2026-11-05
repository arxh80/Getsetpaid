import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ChoosePasswordForm } from "@/components/auth/choose-password-form";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { signOutAction } from "@/lib/auth/actions";
import { safeNextPath } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";
import { mustChoosePassword } from "@/lib/supabase/middleware";

export const metadata: Metadata = { title: "Choose your password · GetSetPaid" };

// Phase 10 Task 20 (Q245). The one page an account carrying the must-choose
// mark can reach (the proxy sends everything else here): its address was just
// proved by a browser that did not create it, so lib/auth/first-proof.ts
// replaced the password and signed out every other session. The copy says
// what happened without saying why -- "somebody else signed up as you" would
// be a claim this page cannot stand behind (it is also what a person who
// simply confirmed on their phone sees).
export default async function SetPasswordPage({ searchParams }: PageProps<"/set-password">) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login");
  // Nothing to choose: never a password-change screen for an ordinary account.
  if (!mustChoosePassword(data.claims)) redirect(next);

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Choose your password</h1>
        <p className="text-lg text-ink-muted">
          Your email address is confirmed. To finish, choose the password you&rsquo;ll sign in with
          from now on.
        </p>
        <p className="text-base text-ink-muted">
          For your security, no password set on this account before you confirmed your email works
          any more, and any other device signed in to it has been signed out.
        </p>
      </div>

      <ChoosePasswordForm next={next} />

      <div className="border-t border-rule pt-5">
        <SignOutButton userId={data.claims.sub} action={signOutAction} />
      </div>
    </div>
  );
}

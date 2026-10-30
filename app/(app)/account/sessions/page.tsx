import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { SignOutEverywhereForm } from "@/components/account/sign-out-everywhere-form";

export const metadata: Metadata = { title: "Sign out everywhere · GetSetPaid" };

// PHASE 10 TASK 22 -- "sign out everywhere", for a lost or stolen device.
// Account-level, outside any workspace, like the other /account pages. The
// list of signed-in devices PRD § 6.1 describes is deferred (Q253): this page
// is only the revocation.
export default async function AccountSessionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Sign out everywhere</h1>
        <p className="max-w-prose text-lg text-ink-muted">
          If you lost a device, or signed in somewhere you no longer trust, end every session
          your account has open, including this one.
        </p>
      </div>

      <section aria-labelledby="what-happens-heading" className="flex flex-col gap-4">
        <h2 id="what-happens-heading" className="text-xl font-bold text-ink">
          What happens
        </h2>
        <ul className="flex max-w-prose list-disc flex-col gap-2 pl-5 text-base text-ink">
          <li>Every browser and device signed in to your account is signed out, this one too.</li>
          <li>
            A device that was already open can keep working for up to{" "}
            <span className="tabular-nums">15</span> minutes, then it has to sign in again.
          </li>
          <li>Nothing in your account or your workspaces changes. You can sign straight back in.</li>
          <li>
            Your password stays the same. If someone may know it, signing out alone will not keep
            them out.
          </li>
        </ul>
        <SignOutEverywhereForm userId={user.id} />
      </section>
    </div>
  );
}

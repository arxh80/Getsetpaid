import type { Metadata } from "next";
import Link from "next/link";
import { SignupForm } from "@/components/auth/signup-form";
import { GoogleButton } from "@/components/auth/google-button";
import { safeNextPath } from "@/lib/auth/redirects";

export const metadata: Metadata = { title: "Create an account · GetSetPaid" };

export default async function SignupPage({
  searchParams,
}: PageProps<"/signup">) {
  const params = await searchParams;
  const next = safeNextPath(
    typeof params.next === "string" ? params.next : null,
  );

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Create your account
        </h1>
        {/* No claims we cannot stand behind -- no customer counts, no "join
            thousands of promoters". Just what happens next. */}
        <p className="text-lg text-ink-muted">
          Then set up a workspace, or accept an invitation to one.
        </p>
      </div>

      <SignupForm next={next} />

      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-rule" />
        <span className="text-xs uppercase tracking-[0.04em] text-ink-muted">
          or
        </span>
        <span className="h-px flex-1 bg-rule" />
      </div>

      <GoogleButton next={next} />

      <p className="border-t border-rule pt-5 text-base text-ink-muted">
        Already have an account?{" "}
        <Link href="/login" className="text-primary underline underline-offset-4">
          Sign in
        </Link>
        .
      </p>
    </div>
  );
}

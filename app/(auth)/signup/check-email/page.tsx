import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Confirm your email · GetSetPaid" };

// Reached from signUpAction in two different situations that MUST look
// identical to the visitor:
//
//   1. Email confirmations are enabled, so the account exists but is not
//      usable until they click the emailed link.
//   2. The address already had an account, and Supabase returned
//      422 user_already_exists.
//
// Telling those apart would confirm which addresses are already customers.
// The copy is written to be true of both without hinting at either.
export default async function CheckEmailPage({
  searchParams,
}: PageProps<"/signup/check-email">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : null;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Check your email
        </h1>
        <p className="text-lg text-ink-muted">
          {email ? (
            <>
              We&apos;ve sent a message to{" "}
              <span className="font-semibold text-ink">{email}</span>. Open it to
              finish setting up your account.
            </>
          ) : (
            <>We&apos;ve sent you a message. Open it to finish setting up your account.</>
          )}
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t border-rule pt-5">
        <p className="text-base text-ink-muted">
          Already confirmed?{" "}
          <Link href="/login" className="text-primary underline underline-offset-4">
            Sign in
          </Link>
          .
        </p>
        <p className="text-base text-ink-muted">
          Wrong address?{" "}
          <Link href="/signup" className="text-primary underline underline-offset-4">
            Start again
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

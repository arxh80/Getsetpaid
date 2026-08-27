import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Check your email · GetSetPaid" };

// Shown after a magic-link request -- ALWAYS, whether or not the address has
// an account. That is deliberate: a "no account with that email" screen turns
// this form into an account-existence checker for any address someone cares to
// type. See lib/auth/actions.ts on account enumeration.
//
// The address is echoed back because the most common real failure here is a
// typo, and seeing it is what lets someone catch that. It is rendered as text
// content, so React escapes it -- never as HTML, and never into an attribute.
export default async function MagicLinkSentPage({
  searchParams,
}: PageProps<"/magic-link/sent">) {
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
              If <span className="font-semibold text-ink">{email}</span> has a
              GetSetPaid account, a sign-in link is on its way.
            </>
          ) : (
            <>If that address has a GetSetPaid account, a sign-in link is on its way.</>
          )}
        </p>
      </div>

      <div className="border-t border-rule pt-5">
        <p className="text-base text-ink-muted">
          Nothing after a minute? Check the spam folder, or{" "}
          <Link
            href="/magic-link"
            className="text-primary underline underline-offset-4"
          >
            request another link
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

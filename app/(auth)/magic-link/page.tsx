import type { Metadata } from "next";
import Link from "next/link";
import { MagicLinkForm } from "@/components/auth/magic-link-form";
import { safeNextPath } from "@/lib/auth/redirects";

export const metadata: Metadata = { title: "Sign-in link · GetSetPaid" };

export default async function MagicLinkPage({
  searchParams,
}: PageProps<"/magic-link">) {
  const params = await searchParams;
  const next = safeNextPath(
    typeof params.next === "string" ? params.next : null,
  );

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Get a sign-in link
        </h1>
        <p className="text-lg text-ink-muted">
          We&apos;ll email you a link that signs you in. It works once, and only
          for a short time.
        </p>
      </div>

      <MagicLinkForm next={next} />

      <p className="border-t border-rule pt-5 text-base text-ink-muted">
        Prefer a password?{" "}
        <Link href="/login" className="text-primary underline underline-offset-4">
          Sign in with one
        </Link>
        .
      </p>
    </div>
  );
}

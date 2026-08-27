import type { Metadata } from "next";
import Link from "next/link";
import { CreateOrgForm } from "@/components/org/create-org-form";
import { getActiveMemberships, getPendingInvites } from "@/lib/auth";

export const metadata: Metadata = { title: "Create your organisation · GetSetPaid" };

// The empty state for a brand-new account.
//
// DESIGN.md priority: "empty states that teach the workflow". So this does not
// just present a form -- it says what a workspace IS in this product (the
// private side of the private/network split) and what happens immediately
// after, because "organisation" is a word every SaaS product uses to mean
// something slightly different.
//
// Deliberately NOT redirecting away when the user already has memberships:
// creating a second organisation is legitimate (multi-org is supported from
// MVP), so the page instead links back to what they already have.
export default async function OnboardingPage() {
  const [active, invites] = await Promise.all([
    getActiveMemberships(),
    getPendingInvites(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-7">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Create your organisation
        </h1>
        <p className="text-lg text-ink-muted">
          A workspace holds your contacts, events and financials, and only the
          people you invite can see any of it.
        </p>
      </div>

      <CreateOrgForm />

      {invites.length > 0 ? (
        <p className="border-t border-rule pt-5 text-base text-ink-muted">
          You also have {invites.length === 1 ? "an invitation" : `${invites.length} invitations`}{" "}
          waiting.{" "}
          <Link href="/invites" className="text-primary underline underline-offset-4 hover:text-ink">
            Review {invites.length === 1 ? "it" : "them"}
          </Link>
          .
        </p>
      ) : null}

      {active.length > 0 ? (
        <p className="border-t border-rule pt-5 text-base text-ink-muted">
          Looking for a workspace you already belong to?{" "}
          <Link
            href={`/${active[0].organisation.slug}`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Go to {active[0].organisation.name}
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}

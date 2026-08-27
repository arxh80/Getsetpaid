import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveMemberships, getCurrentOrg, hasPermission } from "@/lib/auth";
import { RuledList, RuledRow } from "@/components/ui/ruled-row";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  // Not found and not-yours share a title, same as they share a 404 body.
  return { title: org ? `${org.name} · GetSetPaid` : "Not found · GetSetPaid" };
}

// The workspace home.
//
// Deliberately thin: the real app shell (workspace switcher, navigation, the
// golden-path screens) belongs to later Foundation tasks. What it does do is
// prove the tenancy boundary end-to-end -- an org resolves only for an ACTIVE
// member, and everything on the page comes from a query that ran as that user.
export default async function OrgHomePage({ params }: PageProps<"/[orgSlug]">) {
  const { orgSlug } = await params;

  // NULL COVERS THREE CASES AND MUST NOT DISTINGUISH THEM: no such workspace,
  // someone else's workspace, or one the caller is only invited to. All three
  // render the identical 404. DESIGN.md § Error pages is explicit that
  // returning 403 for "exists, not yours" and 404 for "doesn't exist" is an
  // enumeration oracle -- it lets an attacker map other tenants' slugs.
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [canManageMembers, memberships] = await Promise.all([
    hasPermission(org.id, "manage_members"),
    getActiveMemberships(),
  ]);

  const others = memberships.filter((m) => m.organisationId !== org.id);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          {/* break-words because this heading renders a USER-SUPPLIED name at
              --text-3xl. Measured at 320px before the fix: an organisation
              called "Northernlightstouringandproductionserviceslimited" (one
              unbroken token -- no space or hyphen to break at) overflowed its
              box by 503px, and because html/body carry `overflow-x: clip`
              (app/globals.css) that overflow does NOT produce a scrollbar --
              it is silently CLIPPED, so the user simply cannot see the end of
              their own workspace name and has no way to scroll to it. Names
              containing a space or hyphen were never affected, which is why
              this survived earlier review. Verified after: wraps to 3 lines,
              0px overflow, and ordinary names still render on one line
              unchanged at every width. */}
          <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
            {org.name}
          </h1>
          <p className="text-base text-ink-muted">
            You’re signed in as {roleLabel(org.role)}.
          </p>
        </div>

        {canManageMembers ? (
          <Link
            href={`/${org.slug}/members`}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            Manage members
          </Link>
        ) : null}
      </div>

      {/* An honest empty state rather than invented dashboard tiles. It names
          what is coming and what can be done now -- DESIGN.md: "empty states
          that teach the workflow". */}
      <section className="border border-rule bg-surface p-5">
        <h2 className="text-xl font-bold text-ink">Nothing here yet</h2>
        <p className="mt-2 max-w-prose text-base text-ink-muted">
          Contacts, events and financials arrive with the next release. For now,
          this workspace is set up and ready
          {canManageMembers ? " — bring your colleagues in." : "."}
        </p>
      </section>

      {others.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-bold text-ink">Your other workspaces</h2>
          <RuledList>
            {others.map((m) => (
              <RuledRow
                key={m.id}
                title={
                  <Link
                    href={`/${m.organisation.slug}`}
                    className="text-primary underline underline-offset-4 hover:text-ink"
                  >
                    {m.organisation.name}
                  </Link>
                }
                meta={roleLabel(m.role)}
              />
            ))}
          </RuledList>
        </section>
      ) : null}
    </div>
  );
}

function roleLabel(key: string): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

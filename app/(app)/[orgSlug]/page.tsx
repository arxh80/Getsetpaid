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

  const [canManageMembers, canManageCustomFields, memberships] = await Promise.all([
    hasPermission(org.id, "manage_members"),
    hasPermission(org.id, "manage_custom_fields"),
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

        {/* TWO ADMIN LINKS, EACH ON ITS OWN KEY. `manage_custom_fields` is a
            different permission from `manage_members` (Owner and Admin hold
            both; nobody else holds either), so they are checked separately
            rather than one standing in for the other -- a Manager who could
            invite people but not define fields would otherwise get a link to a
            screen that refuses them.

            NOT LINKED FOR EVERYONE WHO CAN READ THE PAGE, which is the one
            place this page and the settings page differ on purpose: the
            settings page renders read-only for anyone with view_crm (so a
            typed URL is not a 404 that implies there are no custom fields),
            but putting a link to a read-only settings screen in front of every
            Read Only user would be signposting a dead end. */}
        <div className="flex flex-wrap items-center gap-4">
          {canManageMembers ? (
            <Link
              href={`/${org.slug}/members`}
              className="text-base text-primary underline underline-offset-4 hover:text-ink"
            >
              Manage members
            </Link>
          ) : null}
          {canManageCustomFields ? (
            <Link
              href={`/${org.slug}/settings/custom-fields`}
              className="text-base text-primary underline underline-offset-4 hover:text-ink"
            >
              Custom fields
            </Link>
          ) : null}
        </div>
      </div>

      {/* An honest empty state rather than invented dashboard tiles. It names
          what is coming and what can be done now -- DESIGN.md: "empty states
          that teach the workflow".

          UPDATED IN PHASE 2 TASK 3, and the update was not cosmetic: this
          panel said "Contacts, events and financials arrive with the next
          release" while /[orgSlug]/contacts existed and worked. Nothing in the
          product linked to it, so the only way to reach the first CRM screen
          was to type the URL, and the workspace home actively said it was not
          there yet.

          UPDATED AGAIN IN TASK 4b, for the same reason and against the note
          Task 3 left here ("Task 4 turns this into real navigation once there
          are five entity lists to navigate between"). There are five now, and
          three of them had no link into them from anywhere in the product --
          which is the identical defect, one release later. This is a LIST OF
          LINKS rather than a paragraph with two of them in it, because five
          destinations in prose is a paragraph people scan past.

          IT IS STILL NOT A NAVIGATION BAR. A persistent nav belongs in
          app/(app)/layout.tsx, where it would also have to answer what happens
          on narrow screens, where the workspace switcher sits relative to it,
          and which of these a Read Only user should see -- a design, not a
          list. Named here rather than half-built. */}
      <section className="border border-rule bg-surface p-5">
        <h2 className="text-xl font-bold text-ink">Where to start</h2>
        <p className="mt-2 max-w-prose text-base text-ink-muted">
          The five record types this workspace is built on. Events, holds and
          settlements all point back to one of them.
        </p>
        <ul className="mt-4 flex flex-col border-t border-rule">
          {CRM_AREAS.map((area) => (
            <li key={area.path} className="border-b border-rule py-3">
              <Link
                href={`/${org.slug}/${area.path}`}
                className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
              >
                {area.label}
              </Link>
              <p className="mt-1 max-w-prose text-base text-ink-muted">
                {area.blurb}
              </p>
            </li>
          ))}
        </ul>
        {canManageMembers ? (
          <p className="mt-4 max-w-prose text-base text-ink-muted">
            This workspace is set up and ready — bring your colleagues in.
          </p>
        ) : null}
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

/**
 * The five CRM areas, in the order the workflow uses them.
 *
 * DATA RATHER THAN FIVE COPIES OF THE SAME JSX, so the sixth (events, Phase 3)
 * is one line here instead of a paragraph somebody has to match to the other
 * five.
 *
 * NOT FILTERED BY PERMISSION, deliberately. Every role in the Q2 matrix that
 * can reach this page holds `view_crm`, so all five lists are READABLE by all
 * of them -- and each list already explains, in its own empty state, why a
 * record-scoped user is seeing fewer rows than their colleagues. Hiding a link
 * because the viewer cannot WRITE there would be the "hidden loses the
 * explanation" mistake components/crm/write-gate.tsx exists to avoid, applied
 * to a read.
 */
const CRM_AREAS = [
  {
    path: "contacts",
    label: "Contacts",
    blurb:
      "The people this workspace works with — agents, promoters, venue managers, drivers.",
  },
  {
    path: "companies",
    label: "Companies",
    blurb:
      "The businesses behind them. A contact can belong to several, and one of them is their main one.",
  },
  {
    path: "artists",
    label: "Artists",
    blurb:
      "Who you book. Their representation and their fee history hang off one record.",
  },
  {
    path: "agencies",
    label: "Agencies",
    blurb:
      "Who represents them, in what territory, and from when.",
  },
  {
    path: "venues",
    label: "Venues",
    blurb:
      "Where the events happen, and the rooms inside them events can be assigned to.",
  },
] as const;

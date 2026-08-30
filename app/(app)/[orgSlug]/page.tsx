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
          are five entity lists to navigate between"). There are six now (Phase
          3 added Events), and at the time this section was written three of the
          five had no link into them from anywhere in the product -- which is
          the identical defect, one release later. This is a LIST OF LINKS
          rather than a paragraph with two of them in it, because six
          destinations in prose is a paragraph people scan past.

          THE PARAGRAPH BELOW COUNTS THE LIST AND MUST BE EDITED WITH IT.
          Phase 3 Task 3 added Events to CRM_AREAS and left the sentence saying
          "the five record types ... Events, holds and settlements all point
          back to one of them" -- so the page named Events as something that
          points back to the list Events was now in, and the count was wrong.
          Found in review, not in a browser. There is no test that counts the
          list and reads the sentence, and writing one would be a test about
          English; the guard is this comment.

          IT IS STILL NOT A NAVIGATION BAR. A persistent nav belongs in
          app/(app)/layout.tsx, where it would also have to answer what happens
          on narrow screens, where the workspace switcher sits relative to it,
          and which of these a Read Only user should see -- a design, not a
          list. Named here rather than half-built. */}
      <section className="border border-rule bg-surface p-5">
        <h2 className="text-xl font-bold text-ink">Where to start</h2>
        <p className="mt-2 max-w-prose text-base text-ink-muted">
          The six record types this workspace is built on. An event points at a
          venue and the artists on its lineup; holds and settlements, when they
          arrive, will point back here too.
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

      {/* HOUSEKEEPING, LINKED FOR EVERYONE WHO CAN READ IT.
          Same rule as CRM_AREAS above and for the same reason: both pages are
          READABLE by every role that reaches this one (they hold view_crm),
          and each says on its own face who can act on what it shows. Hiding a
          link because the viewer cannot WRITE there is the "hidden loses the
          explanation" mistake components/crm/write-gate.tsx exists to avoid,
          applied to a read -- and it is worse here than on a list, because a
          Booker who cannot find the queue also cannot tell anybody that two
          records need merging. */}
      <section className="border border-rule bg-surface p-5">
        <h2 className="text-xl font-bold text-ink">Keeping the records clean</h2>
        <p className="mt-2 max-w-prose text-base text-ink-muted">
          Two copies of the same venue is how a booking ends up on the wrong
          one. New records are checked as they are created.
        </p>
        <ul className="mt-4 flex flex-col border-t border-rule">
          <li className="border-b border-rule py-3">
            <Link
              href={`/${org.slug}/duplicates`}
              className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
            >
              Possible duplicates
            </Link>
            <p className="mt-1 max-w-prose text-base text-ink-muted">
              Pairs that look like the same record, waiting for somebody to
              decide. An Owner, Admin or Manager can merge them.
            </p>
          </li>
          <li className="border-b border-rule py-3">
            <Link
              href={`/${org.slug}/merges`}
              className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
            >
              Merge history
            </Link>
            <p className="mt-1 max-w-prose text-base text-ink-muted">
              What was merged into what, and every value the merge discarded.
              Permanent — merges cannot be edited or removed.
            </p>
          </li>
        </ul>
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
 * The six CRM areas, in the order the workflow uses them.
 *
 * DATA RATHER THAN SIX COPIES OF THE SAME JSX. This comment used to say "the
 * sixth (events, Phase 3) is one line here instead of a paragraph somebody has
 * to match to the other five", and Phase 3 Task 3 collected on it: adding
 * Events was one entry in the array below and nothing else in this file.
 *
 * NOT FILTERED BY PERMISSION, deliberately. Every role in the Q2 matrix that
 * can reach this page holds `view_crm`, so all six lists are READABLE by all
 * of them -- and each list already explains, in its own empty state, why a
 * record-scoped user is seeing fewer rows than their colleagues. Hiding a link
 * because the viewer cannot WRITE there would be the "hidden loses the
 * explanation" mistake components/crm/write-gate.tsx exists to avoid, applied
 * to a read.
 *
 * Events is the sixth and it obeys the same rule: `view_crm` is what the
 * SELECT policy in 20260901011000 requires, and a Finance or Marketing user
 * holds it while holding no `manage_events` at all. They can read the list;
 * the "New event" control on it explains itself.
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
  // LAST, because the workflow arrives here: CLAUDE.md's core sequence is
  // `relationship -> enquiry/hold -> booking/event -> delivery -> settlement`,
  // and an event is the thing the five above get attached to.
  {
    path: "events",
    label: "Events",
    blurb:
      "The nights you are putting on. A date, a venue and a lineup, with everything above it hanging off one record.",
  },
] as const;

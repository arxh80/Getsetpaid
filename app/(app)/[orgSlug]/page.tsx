import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getActiveMemberships,
  getCurrentOrg,
  getCurrentUser,
  hasPermission,
} from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  loadOpenTasksForUser,
  loadUpcomingEvents,
  OPEN_TASKS_COUNT,
  UPCOMING_EVENT_COUNT,
  type OpenTaskRow,
  type UpcomingEventRow,
} from "@/lib/crm/queries";
import { TaskStatusChip } from "@/components/crm/task-status-chip";
import { PriorityChip } from "@/components/crm/priority-chip";
import { formatDateTime } from "@/lib/format/date";
import { countPendingReceivedRequests } from "@/lib/network/requests-list";
import { Alert } from "@/components/ui/alert";
import { RuledList, RuledRow } from "@/components/ui/ruled-row";
import { CRM_AREAS, OPERATIONS_AREAS } from "@/lib/nav/areas";

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

  const user = await getCurrentUser();
  const [
    canManageMembers,
    canManageCustomFields,
    canViewNetwork,
    memberships,
    upcoming,
    openTasks,
    pendingReceivedRequests,
  ] = await Promise.all([
      hasPermission(org.id, "manage_members"),
      hasPermission(org.id, "manage_custom_fields"),
      // THE NETWORK CARD'S OWN GATE (Phase 6 Task 2). Unlike CRM_AREAS and
      // OPERATIONS_AREAS below -- which are never gated because every role
      // that reaches this page holds view_crm and it never closes for
      // suspension -- view_network DOES close for a suspended workspace
      // (lib/network/access.ts: "survives_suspension=false, unlike
      // view_crm"). So this card, alone on this page, is checked rather than
      // assumed universal.
      hasPermission(org.id, "view_network"),
      getActiveMemberships(),
      // THE FIRST THING ON THIS PAGE THAT READS TENANT DATA. It is a capped
      // read, not a list surface -- see `loadUpcomingEvents` for why this page
      // gets `.limit(5)` and a link rather than a fourth pager.
      loadUpcomingEvents(org.id),
      // "MY OPEN TASKS" -- the viewer's own unfinished tasks, another capped
      // read (not a list surface). Pinned to the user, not the workspace, so it
      // is the same short list for an Admin as for a Standard User.
      user ? loadOpenTasksForUser(org.id, user.id) : Promise.resolve(null),
      // TASK 4: THE NETWORK CARD'S PENDING-RECEIVED COUNT. Unconditional, same
      // as `upcoming`/`openTasks` above -- the query is cheap (a `head: true`
      // count) and RLS-safe for a suspended workspace regardless (view_network
      // is closed, so the query answers 0 rather than leaking anything); only
      // the RENDER below is gated on `canViewNetwork`. This is the ONE other
      // discovery surface besides app/(app)/[orgSlug]/network/requests --
      // there is no notification of any kind (Q45/Q75, CLAUDE.md's
      // `reminder_at` precedent).
      countPendingReceivedRequests(org.id),
    ]);

  const others = memberships.filter((m) => m.organisationId !== org.id);
  // WHY THE ROLE AND NOT ONLY THE COUNT. An empty block means "nothing is
  // booked" for a full-scope viewer and "nothing assigned to you is booked"
  // for a record-scoped one, and only the role tells the page which sentence
  // is true. Same argument, same wording, as the events list's scope note.
  const recordScoped = isRecordScopedRole(org.role);

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

      {/* ===================================================================
          UPCOMING EVENTS -- THE ONE PIECE OF REAL DATA ON THE WORKSPACE HOME
          ===================================================================
          FIRST, ABOVE "Where to start", because it is the only section that
          answers a question somebody actually opened this page with. The two
          sections below it are navigation.

          NOT A lib/list/ SURFACE, and that is the decision rather than an
          omission: a fixed five with an explicit `order`, no cursor, no
          toolbar, no pager, and a link to the real list. `loadUpcomingEvents`
          carries the argument; `tests/unit/list/one-cursor-only.test.ts` is
          the guard that a bounded `.limit()` is allowed and a second cursor is
          not.

          A `<ul role="list">` RATHER THAN THE BARE `<ul>` the two sections
          below use. Safari with VoiceOver drops list semantics from a `ul`
          whose `list-style` is `none`, and this list's rows are ruled rather
          than bulleted, so the role is restored explicitly. The other two
          sections predate this and are left alone rather than swept in. */}
      <section className="border border-rule bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="text-xl font-bold text-ink">Upcoming events</h2>
          <Link
            href={`/${org.slug}/events`}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            See all events
          </Link>
        </div>

        {upcoming.outcome === "unavailable" ? (
          // A FAILED QUERY IS NOT AN EMPTY DIARY. Rendering "Nothing coming
          // up" here would tell a promoter with a full month that they have
          // nothing on, which is the one thing an empty state must never do.
          <div className="mt-4">
            <Alert tone="error">
              We couldn’t load your upcoming events just now. Refresh the page
              to try again — nothing has been deleted.
            </Alert>
          </div>
        ) : upcoming.rows.length === 0 ? (
          <>
            <h3 className="mt-4 text-base font-semibold text-ink">
              Nothing coming up
            </h3>
            {/* ONE LINE IN THE SOURCE, deliberately: this is the brief's copy
                verbatim and tests/unit/crm/source-shape.test.ts asserts the
                whole sentence. Wrapped across two source lines it renders
                identically and the assertion cannot see it. */}
            <p className="mt-1 max-w-prose text-base text-ink-muted">
              Events you create will appear here once they have a date in the future.
            </p>
            {recordScoped ? <ScopeNote /> : null}
          </>
        ) : (
          <>
            {/* THE NUMBER ONLY WHEN IT IS TRUE. With two events on the books
                "The next 5 by date" claims three that do not exist -- a small
                lie on the first screen a user sees, and the same class as an
                empty state that says "no records" to a record-scoped user.
                Below the cap the ordering is the only thing worth saying. */}
            <p className="mt-2 max-w-prose text-base text-ink-muted">
              {upcoming.rows.length === UPCOMING_EVENT_COUNT ? (
                <>
                  The next{" "}
                  <span className="tabular-nums">{UPCOMING_EVENT_COUNT}</span>{" "}
                  by date, soonest first.
                </>
              ) : (
                <>Soonest first.</>
              )}
            </p>
            {recordScoped ? <ScopeNote /> : null}
            <ul role="list" className="mt-4 flex flex-col border-t border-rule">
              {upcoming.rows.map((event) => (
                <UpcomingEvent
                  key={event.id}
                  event={event}
                  orgSlug={org.slug}
                  venueName={
                    event.venueId
                      ? (upcoming.venueNames.get(event.venueId) ?? null)
                      : null
                  }
                />
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ===================================================================
          MY OPEN TASKS (Phase 4 Task 3)
          ===================================================================
          The viewer's own unfinished tasks, soonest due first. A capped read
          like Upcoming events -- five, a link to the full list, no pager. It is
          the viewer's list, not the workspace's, so an Admin sees only their
          own here (the tasks LIST is where the whole workspace's are). */}
      <section className="border border-rule bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="text-xl font-bold text-ink">My open tasks</h2>
          <Link
            href={`/${org.slug}/tasks`}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            See all tasks
          </Link>
        </div>

        {openTasks === null || openTasks.outcome === "unavailable" ? (
          // A FAILED QUERY IS NOT AN EMPTY LIST. Rendering "Nothing on your
          // plate" here would tell someone with ten open tasks they have none.
          <div className="mt-4">
            <Alert tone="error">
              We couldn’t load your tasks just now. Refresh the page to try
              again — nothing has been deleted.
            </Alert>
          </div>
        ) : openTasks.rows.length === 0 ? (
          <>
            <h3 className="mt-4 text-base font-semibold text-ink">
              Nothing on your plate
            </h3>
            <p className="mt-1 max-w-prose text-base text-ink-muted">
              Tasks assigned to you that are still open will appear here.
            </p>
          </>
        ) : (
          <>
            <p className="mt-2 max-w-prose text-base text-ink-muted">
              {openTasks.rows.length === OPEN_TASKS_COUNT ? (
                <>
                  Your next{" "}
                  <span className="tabular-nums">{OPEN_TASKS_COUNT}</span>, by due
                  date.
                </>
              ) : (
                <>By due date.</>
              )}
            </p>
            <ul role="list" className="mt-4 flex flex-col border-t border-rule">
              {openTasks.rows.map((task) => (
                <OpenTask key={task.id} task={task} orgSlug={org.slug} />
              ))}
            </ul>
          </>
        )}
      </section>

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

          THIS GRID IS NOW REDUNDANT WITH THE SIDEBAR (Sidebar nav build,
          app/(app)/[orgSlug]/layout.tsx + components/nav/sidebar.tsx) AND IS
          KEPT ANYWAY -- a deliberate call, not an oversight. Removing it would
          touch every golden-path/accessibility/tenant-breakout spec that reads
          this page's card links and blurbs, for a purely cosmetic win (one
          less way to reach the same six routes), and this page still earns
          its keep as the dashboard: the upcoming-events and open-tasks
          sections above are real data the sidebar has no room for. If this
          page is revisited, the six-plus-four cards below are the part to cut
          first; "Keeping the records clean" and "Network" (below) are not
          reachable from the sidebar at all yet and would need to move there
          first. */}
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

      {/* DAY TO DAY (Phase 4). The operational layer that hangs off the six
          record types above: tasks to do, meetings held, notes kept, files
          filed (documents, Task 6). Linked
          for everyone who can read the page, same rule as CRM_AREAS -- every
          role here holds view_crm, and each list explains on its own face who
          can write. There is no persistent navbar to add these to (the app
          shell is a header and a workspace switcher), and building one is a
          design this task does not take -- so, like the six record types, these
          are discovered from the workspace home. */}
      <section className="border border-rule bg-surface p-5">
        <h2 className="text-xl font-bold text-ink">Day to day</h2>
        <p className="mt-2 max-w-prose text-base text-ink-muted">
          The work around the records: what needs doing, who you met, what you
          want kept, and the files that go with them. Each can be linked to the
          contacts, events and everyone else above.
        </p>
        <ul className="mt-4 flex flex-col border-t border-rule">
          {OPERATIONS_AREAS.map((area) => (
            <li key={area.path} className="border-b border-rule py-3">
              <Link
                href={`/${org.slug}/${area.path}`}
                className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
              >
                {area.label}
              </Link>
              <p className="mt-1 max-w-prose text-base text-ink-muted">{area.blurb}</p>
            </li>
          ))}
        </ul>
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

      {/* NETWORK (Phase 6 Tasks 2-3). Gated on `canViewNetwork` -- the one
          section on this page that closes for a suspended workspace, since
          view_network is survives_suspension=false while view_crm is not
          (lib/network/access.ts). Everything CRM_AREAS-shaped stays
          unconditional; this does not.

          THE DIRECTORY LEADS (Task 3's IA decision). Discovering who else is
          on the network is the point of an industry network; publishing your
          own identity is something you do to get found, and it is demoted to
          the second link. Free-tier honesty: `canViewNetwork` carries no tier
          term (view_network is a browsing key every plan holds), so a Free
          workspace sees this whole section, including "Browse the network",
          exactly as a paid one does. */}
      {canViewNetwork ? (
        <section className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">Network</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            The industry network: discover who else has published, and
            publish a company, artist, venue or agency record of your own so
            other GetSetPaid workspaces can find it.
          </p>
          <ul className="mt-4 flex flex-col border-t border-rule">
            <li className="border-b border-rule py-3">
              <Link
                href={`/${org.slug}/network`}
                className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
              >
                Browse the network
              </Link>
              <p className="mt-1 max-w-prose text-base text-ink-muted">
                Search every published company, artist, venue and agency by
                name, or filter by type.
              </p>
            </li>
            <li className="border-b border-rule py-3">
              <Link
                href={`/${org.slug}/network/profiles`}
                className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
              >
                Your network profiles
              </Link>
              <p className="mt-1 max-w-prose text-base text-ink-muted">
                Create, edit and publish network identities for your own
                records — draft and published alike.
              </p>
            </li>
            {/* TASK 4: the requests inbox/outbox, with the pending-received
                count -- tabular-nums (DESIGN.md's numeral rule) and the ONE
                other discovery surface besides the requests page itself,
                since there is no notification of any kind (Q45/Q75). */}
            <li className="border-b border-rule py-3">
              <Link
                href={`/${org.slug}/network/requests`}
                className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
              >
                Connection requests
                {pendingReceivedRequests > 0 ? (
                  <span className="ml-2 tabular-nums text-ink-muted">
                    ({pendingReceivedRequests} pending)
                  </span>
                ) : null}
              </Link>
              <p className="mt-1 max-w-prose text-base text-ink-muted">
                Requests to connect, sent and received. There is no other
                notification — check here.
              </p>
            </li>
            <li className="py-3">
              <Link
                href={`/${org.slug}/network/links`}
                className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
              >
                Linked records
              </Link>
              <p className="mt-1 max-w-prose text-base text-ink-muted">
                Your own private records, explicitly linked to network
                identities other workspaces have published.
              </p>
            </li>
          </ul>
        </section>
      ) : null}

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

/**
 * One upcoming night: what it is called, when it is, and where.
 *
 * THE DATE IS A `<time>` WITH THE RAW INSTANT IN `dateTime` and the UK-local
 * rendering as its text, and it carries `tabular-nums` -- DESIGN.md § Numerals
 * applies to "every date column", and five dates stacked in a column is a
 * column whether or not it is inside a `<table>`.
 */
function UpcomingEvent({
  event,
  orgSlug,
  venueName,
}: {
  event: UpcomingEventRow;
  orgSlug: string;
  /** Null when there is no venue AND when the caller cannot read the one this
   *  event names -- see `loadVenueNames` for why those collapse deliberately. */
  venueName: string | null;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule py-3">
      <Link
        href={`/${orgSlug}/events/${event.id}`}
        className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
      >
        {event.name}
      </Link>
      <time
        dateTime={event.startsAt}
        className="text-base tabular-nums text-ink-muted"
      >
        {formatDateTime(event.startsAt)}
      </time>
      {venueName && event.venueId ? (
        <Link
          href={`/${orgSlug}/venues/${event.venueId}`}
          className="text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          {venueName}
        </Link>
      ) : (
        // NOT AN EM DASH IN A ROW OF LINKS. "No venue yet" is the true and
        // actionable sentence for the common case (an event is routinely
        // created before the venue is booked), and it is the same sentence
        // when the venue is one this caller cannot read -- which is the
        // collision `loadVenueNames` makes on purpose.
        <span className="text-base text-ink-muted">No venue yet</span>
      )}
    </li>
  );
}

/**
 * One open task on the workspace home: what it is, its status and priority, and
 * when it is due. The due date is a `<time>` with the raw instant in `dateTime`
 * and tabular figures (DESIGN.md § Numerals applies to a column of dates).
 */
function OpenTask({ task, orgSlug }: { task: OpenTaskRow; orgSlug: string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule py-3">
      <Link
        href={`/${orgSlug}/tasks/${task.id}`}
        className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
      >
        {task.title}
      </Link>
      <TaskStatusChip status={task.status} />
      <PriorityChip priority={task.priority} />
      {task.dueAt !== null ? (
        <time dateTime={task.dueAt} className="text-base tabular-nums text-ink-muted">
          due {formatDateTime(task.dueAt)}
        </time>
      ) : (
        <span className="text-base text-ink-muted">no due date</span>
      )}
    </li>
  );
}

/** The one sentence a record-scoped viewer needs beside a short list. */
function ScopeNote() {
  return (
    <p className="mt-2 text-sm text-ink-muted">
      You’re seeing events assigned to you. Others in this workspace may see
      more.
    </p>
  );
}

function roleLabel(key: string): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// CRM_AREAS and OPERATIONS_AREAS used to be defined here as two private
// arrays. Sidebar nav build: moved to lib/nav/areas.ts (imported above) so
// the new persistent sidebar (components/nav/sidebar.tsx, wired up in
// app/(app)/[orgSlug]/layout.tsx) can render the SAME six-plus-four areas
// with the same `label`, plus a short `sub` subheading this card grid does
// not need. One array per group, not two that can drift -- see that file's
// header comment for the full argument, including why the layout does not
// simply import these two arrays from this page module instead.

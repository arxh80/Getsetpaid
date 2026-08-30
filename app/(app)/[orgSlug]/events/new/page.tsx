import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadVenuesForPicker } from "@/lib/crm/queries";
import { EventForm } from "@/components/crm/event-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";

// New event. The ROUTE is gated, not only the button that leads to it.
//
// Task 3 shipped the list with a "New event" control pointing here and nothing
// on the other end -- so for a `read_only` user the acceptance criterion "the
// route refuses it, not just the button" had no route to assert against. This
// is that route: `getCrmWriteAccess` decides before the form is rendered, and
// the INSERT policy (20260901011000, rls_phase3_events.sql EC9) refuses the
// write from any client regardless. Neither is the other's substitute.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/events/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `New event · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NewEventPage({
  params,
}: PageProps<"/[orgSlug]/events/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const access = await getCrmWriteAccess(org, "manage_events");
  const basePath = `/${org.slug}/events`;
  // ONLY FETCHED WHEN THE FORM WILL BE RENDERED. A Read Only user gets the
  // explanation and no picker, so there is no reason to read a hundred venues
  // and their rooms for a page with no `<select>` on it.
  const venues = access.canWrite ? await loadVenuesForPicker(org.id) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Events
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          New event
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          A night you are putting on. Only a name and a start time are
          required — the venue, the room and the ticket link can wait, and the
          lineup is added on the event’s own page.
        </p>
      </div>

      {access.canWrite ? (
        <EventForm
          orgSlug={org.slug}
          venues={venues}
          values={{
            name: "",
            startsAt: "",
            endsAt: "",
            // The column defaults too (20260901000000), and the form states
            // the same two rather than rendering an empty option: a `<select>`
            // whose first entry is blank invites a required-field error on a
            // question that already has a sensible answer.
            eventType: "other",
            status: "draft",
            venueId: "",
            venueRoomId: "",
            location: "",
            ticketLink: "",
            notes: "",
          }}
          cancelHref={basePath}
        />
      ) : (
        <WriteBlockedNote access={access} id="new-event-blocked" />
      )}
    </div>
  );
}

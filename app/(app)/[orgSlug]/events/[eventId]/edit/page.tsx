import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadEvent, loadVenuesForPicker } from "@/lib/crm/queries";
import { EventForm } from "@/components/crm/event-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { Alert } from "@/components/ui/alert";
import { instantToLondonWallClock } from "@/lib/format/date";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/events/[eventId]/edit">): Promise<Metadata> {
  const { orgSlug, eventId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadEvent(org.id, eventId);
  return {
    title:
      result.outcome === "found"
        ? `Edit ${result.record.name} · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function EditEventPage({
  params,
}: PageProps<"/[orgSlug]/events/[eventId]/edit">) {
  const { orgSlug, eventId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadEvent(org.id, eventId),
    getCrmWriteAccess(org, "manage_events"),
  ]);

  // A FAILED QUERY IS NOT A MISSING RECORD.
  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this event just now. Refresh the page to try again —
        nothing has been changed.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const event = result.record;
  const detailHref = `/${org.slug}/events/${event.id}`;

  const breadcrumb = (
    <p className="text-sm text-ink-muted">
      <Link
        href={`/${org.slug}/events`}
        className="text-primary underline underline-offset-4 hover:text-ink"
      >
        Events
      </Link>
      {" › "}
      <Link
        href={detailHref}
        className="break-words text-primary underline underline-offset-4 hover:text-ink"
      >
        {event.name}
      </Link>
    </p>
  );

  // A deleted event is not editable and is not a 404.
  if (event.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb}
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Edit event
        </h1>
        <Alert tone="info">
          {event.name} has been deleted, so it can’t be edited. Restore it from
          its own page first and the form will be here.
        </Alert>
        <p>
          <Link
            href={detailHref}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            Go to {event.name}
          </Link>
        </p>
      </div>
    );
  }

  // THE STORED IDS ARE PASSED TO THE PICKER, and that is not belt-and-braces.
  // A `<select>` that does not contain the value the record holds silently
  // submits a DIFFERENT one, so editing this event's NAME while its venue was
  // deleted by somebody else would clear the venue with nothing said. Passing
  // the ids puts them in the list, marked; the action then refuses the save
  // with an explanation the user can act on. See `loadVenuesForPicker`.
  const venues = access.canWrite
    ? await loadVenuesForPicker(org.id, event.venueId, event.venueRoomId)
    : [];

  return (
    <div className="flex flex-col gap-6">
      {breadcrumb}
      <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
        Edit {event.name}
      </h1>

      {access.canWrite ? (
        <EventForm
          orgSlug={org.slug}
          venues={venues}
          values={{
            id: event.id,
            name: event.name,
            // INSTANT -> UK WALL CLOCK, because that is what the input speaks.
            // The action converts back with the inverse, so a save that
            // changes nothing else leaves `starts_at` byte-identical.
            startsAt: instantToLondonWallClock(event.startsAt),
            endsAt: event.endsAt === null ? "" : instantToLondonWallClock(event.endsAt),
            eventType: event.eventType,
            status: event.status,
            venueId: event.venueId ?? "",
            venueRoomId: event.venueRoomId ?? "",
            location: event.location ?? "",
            // The RAW column, not `ticketLinkHref`. The form is where a
            // rejected value is corrected, so the user has to see what is
            // actually stored -- handing them the normalised href would hide
            // the thing they are being asked to fix, and handing them nothing
            // would delete it on the next save.
            ticketLink: event.ticketLink ?? "",
            notes: event.notes ?? "",
          }}
          cancelHref={detailHref}
        />
      ) : (
        <WriteBlockedNote access={access} id="edit-event-blocked" />
      )}
    </div>
  );
}

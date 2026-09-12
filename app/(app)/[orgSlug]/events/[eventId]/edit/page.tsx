import type { CurrentOrg } from "@/lib/auth";
import { loadEvent, loadVenuesForPicker, type EventDetail } from "@/lib/crm/queries";
import { instantToLondonWallClock } from "@/lib/format/date";
import { EventForm } from "@/components/crm/event-form";
import { editRecordPage } from "@/components/crm/edit-record-page";

const { generateMetadata, Page } = editRecordPage({
  segment: "events",
  backLabel: "Events",
  noun: "event",
  pronoun: "it",
  paramKey: "eventId",
  permissionKey: "manage_events",
  load: loadEvent,
  label: (event) => event.name,
  deletedAt: (event) => event.deletedAt,
  // The picker read happens inside the slot, which the factory calls only on
  // the writable branch -- so a Read Only caller still pays nothing for it.
  form: ({ org, record, detailHref }) => (
    <EditEventForm org={org} event={record} detailHref={detailHref} />
  ),
});

export { generateMetadata };
export default Page;

async function EditEventForm({
  org,
  event,
  detailHref,
}: {
  org: CurrentOrg;
  event: EventDetail;
  detailHref: string;
}) {
  // THE STORED IDS ARE PASSED TO THE PICKER, and that is not belt-and-braces.
  // A `<select>` that does not contain the value the record holds silently
  // submits a DIFFERENT one, so editing this event's NAME while its venue was
  // deleted by somebody else would clear the venue with nothing said. Passing
  // the ids puts them in the list, marked; the action then refuses the save
  // with an explanation the user can act on. See `loadVenuesForPicker`.
  const venues = await loadVenuesForPicker(
    org.id,
    event.venueId,
    event.venueRoomId,
  );

  return (
    <EventForm
      orgSlug={org.slug}
      venues={venues}
      values={{
        id: event.id,
        name: event.name,
        // INSTANT -> UK WALL CLOCK, because that is what the input speaks. The
        // action converts back with the inverse, so a save that changes
        // nothing else leaves `starts_at` byte-identical FOR ANY INSTANT THIS
        // FORM WROTE.
        //
        // The qualifier is load-bearing (fix round 1, M-6):
        // `instantToLondonWallClock` drops SECONDS by design, because
        // `datetime-local` without a `step` cannot display them, so an instant
        // written with non-zero seconds by an import or through `psql` is
        // rounded down to `:00` on the next save of any other field. Nothing
        // this form can create has non-zero seconds, so there is no path from
        // the product into that state today -- which is why it is a narrower
        // comment rather than a fix.
        startsAt: instantToLondonWallClock(event.startsAt),
        endsAt:
          event.endsAt === null ? "" : instantToLondonWallClock(event.endsAt),
        eventType: event.eventType,
        status: event.status,
        venueId: event.venueId ?? "",
        venueRoomId: event.venueRoomId ?? "",
        location: event.location ?? "",
        // The RAW column, not `ticketLinkHref`. The form is where a rejected
        // value is corrected, so the user has to see what is actually stored --
        // handing them the normalised href would hide the thing they are being
        // asked to fix, and handing them nothing would delete it on the next
        // save.
        ticketLink: event.ticketLink ?? "",
        notes: event.notes ?? "",
      }}
      cancelHref={detailHref}
    />
  );
}

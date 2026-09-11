import type { CurrentOrg } from "@/lib/auth";
import { loadVenuesForPicker } from "@/lib/crm/queries";
import { EventForm } from "@/components/crm/event-form";
import { newRecordPage } from "@/components/crm/new-record-page";

const { generateMetadata, Page } = newRecordPage({
  segment: "events",
  backLabel: "Events",
  title: "New event",
  blurb: (
    <>
      A night you are putting on. Only a name and a start time are required —
      the venue, the room and the ticket link can wait, and the lineup is added
      on the event’s own page.
    </>
  ),
  permissionKey: "manage_events",
  blockedId: "new-event-blocked",
  // ONLY FETCHED WHEN THE FORM WILL BE RENDERED, and that is what the render
  // slot buys: `newRecordPage` calls this only when the caller may write, so a
  // Read Only user gets the explanation without a hundred venues and their
  // rooms being read for a page with no `<select>` on it.
  form: ({ org, basePath }) => <NewEventForm org={org} basePath={basePath} />,
});

export { generateMetadata };
export default Page;

async function NewEventForm({
  org,
  basePath,
}: {
  org: CurrentOrg;
  basePath: string;
}) {
  const venues = await loadVenuesForPicker(org.id);
  return (
    <EventForm
      orgSlug={org.slug}
      venues={venues}
      values={{
        name: "",
        startsAt: "",
        endsAt: "",
        // The column defaults too (20260901000000), and the form states the
        // same two rather than rendering an empty option: a `<select>` whose
        // first entry is blank invites a required-field error on a question
        // that already has a sensible answer.
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
  );
}

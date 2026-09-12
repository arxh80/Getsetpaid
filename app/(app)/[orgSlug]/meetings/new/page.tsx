import { MeetingForm } from "@/components/crm/meeting-form";
import { newRecordPage } from "@/components/crm/new-record-page";

const { generateMetadata, Page } = newRecordPage({
  segment: "meetings",
  backLabel: "Meetings",
  title: "New meeting",
  blurb: (
    <>
      A title and a start are required. Add the location, a video link, who is
      coming and any notes, and link it to the records it is about from its own
      page.
    </>
  ),
  permissionKey: "manage_meetings",
  blockedId: "new-meeting-blocked",
  form: ({ org, basePath }) => (
    <MeetingForm
      orgSlug={org.slug}
      values={{
        title: "",
        startsAt: "",
        endsAt: "",
        location: "",
        meetingUrl: "",
        attendees: "",
        notes: "",
        status: "scheduled",
      }}
      cancelHref={basePath}
    />
  ),
});

export { generateMetadata };
export default Page;

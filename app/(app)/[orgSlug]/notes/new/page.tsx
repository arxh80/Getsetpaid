import { NoteForm } from "@/components/crm/note-form";
import { newRecordPage } from "@/components/crm/new-record-page";

const { generateMetadata, Page } = newRecordPage({
  segment: "notes",
  backLabel: "Notes",
  title: "New note",
  blurb: (
    <>
      Free-form text. “Company” is shared with the workspace; “Private” is only
      ever seen by you. Link it to the records it is about from its own page.
    </>
  ),
  permissionKey: "manage_notes",
  blockedId: "new-note-blocked",
  form: ({ org, basePath }) => (
    <NoteForm
      orgSlug={org.slug}
      values={{ body: "", visibility: "company" }}
      cancelHref={basePath}
    />
  ),
});

export { generateMetadata };
export default Page;

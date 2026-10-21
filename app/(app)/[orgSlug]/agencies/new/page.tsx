import { AgencyForm } from "@/components/crm/agency-form";
import { newRecordPage } from "@/components/crm/new-record-page";

const { generateMetadata, Page } = newRecordPage({
  segment: "agencies",
  backLabel: "Agencies",
  title: "New agency",
  blurb: (
    <>
      A booking or management agency. Only a name is needed — who they represent,
      in what territory and from when goes on the agency’s own page once it
      exists.
    </>
  ),
  // The relationship layer shares one key -- see the factory's own note.
  permissionKey: "manage_contacts",
  blockedId: "new-agency-blocked",
  form: ({ org, basePath }) => (
    <AgencyForm orgSlug={org.slug} values={{ name: "" }} cancelHref={basePath} />
  ),
});

export { generateMetadata };
export default Page;

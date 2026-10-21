import { loadAgency } from "@/lib/crm/queries";
import { AgencyForm } from "@/components/crm/agency-form";
import { editRecordPage } from "@/components/crm/edit-record-page";

const { generateMetadata, Page } = editRecordPage({
  segment: "agencies",
  backLabel: "Agencies",
  noun: "agency",
  pronoun: "it",
  paramKey: "agencyId",
  // The relationship layer shares one key -- see the factory's own note.
  permissionKey: "manage_contacts",
  load: loadAgency,
  label: (agency) => agency.name,
  deletedAt: (agency) => agency.deletedAt,
  form: ({ org, record, detailHref }) => (
    <AgencyForm
      orgSlug={org.slug}
      values={{ id: record.id, name: record.name }}
      cancelHref={detailHref}
    />
  ),
});

export { generateMetadata };
export default Page;

import { loadCompany } from "@/lib/crm/queries";
import { CompanyForm } from "@/components/crm/company-form";
import { editRecordPage } from "@/components/crm/edit-record-page";

const { generateMetadata, Page } = editRecordPage({
  segment: "companies",
  backLabel: "Companies",
  noun: "company",
  pronoun: "it",
  paramKey: "companyId",
  permissionKey: "manage_contacts",
  load: loadCompany,
  label: (company) => company.name,
  deletedAt: (company) => company.deletedAt,
  form: ({ org, record, detailHref }) => (
    <CompanyForm
      orgSlug={org.slug}
      values={{ id: record.id, name: record.name, type: record.type }}
      cancelHref={detailHref}
    />
  ),
});

export { generateMetadata };
export default Page;

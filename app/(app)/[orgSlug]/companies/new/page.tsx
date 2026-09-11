import { CompanyForm } from "@/components/crm/company-form";
import { newRecordPage } from "@/components/crm/new-record-page";

const { generateMetadata, Page } = newRecordPage({
  segment: "companies",
  backLabel: "Companies",
  title: "New company",
  blurb: (
    <>
      A business this workspace deals with. Only a name is required — the type
      can wait until you know it.
    </>
  ),
  permissionKey: "manage_contacts",
  blockedId: "new-company-blocked",
  form: ({ org, basePath }) => (
    <CompanyForm
      orgSlug={org.slug}
      values={{ name: "", type: [] }}
      cancelHref={basePath}
    />
  ),
});

export { generateMetadata };
export default Page;

import { loadContact } from "@/lib/crm/queries";
import { formatTags } from "@/lib/crm/validate";
import { ContactForm } from "@/components/crm/contact-form";
import { editRecordPage } from "@/components/crm/edit-record-page";

const { generateMetadata, Page } = editRecordPage({
  segment: "contacts",
  backLabel: "Contacts",
  noun: "contact",
  pronoun: "it",
  paramKey: "contactId",
  permissionKey: "manage_contacts",
  load: loadContact,
  label: (contact) => contact.name,
  deletedAt: (contact) => contact.deletedAt,
  form: ({ org, record, detailHref }) => (
    <ContactForm
      orgSlug={org.slug}
      values={{
        id: record.id,
        name: record.name,
        email: record.email ?? "",
        phone: record.phone ?? "",
        title: record.title ?? "",
        location: record.location ?? "",
        website: record.website ?? "",
        tags: formatTags(record.tags),
        socials: record.socialsRaw,
      }}
      cancelHref={detailHref}
    />
  ),
});

export { generateMetadata };
export default Page;

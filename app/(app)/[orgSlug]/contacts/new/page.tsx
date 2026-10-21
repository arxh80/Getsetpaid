import { ContactForm } from "@/components/crm/contact-form";
import { newRecordPage } from "@/components/crm/new-record-page";

const { generateMetadata, Page } = newRecordPage({
  segment: "contacts",
  backLabel: "Contacts",
  title: "New contact",
  blurb: (
    <>
      A person this workspace works with. Only a name is required — the rest can
      be filled in when you know it.
    </>
  ),
  permissionKey: "manage_contacts",
  blockedId: "new-contact-blocked",
  form: ({ org, basePath }) => (
    <ContactForm
      orgSlug={org.slug}
      values={{
        name: "",
        email: "",
        phone: "",
        title: "",
        location: "",
        website: "",
        tags: "",
        socials: {},
      }}
      cancelHref={basePath}
    />
  ),
});

export { generateMetadata };
export default Page;

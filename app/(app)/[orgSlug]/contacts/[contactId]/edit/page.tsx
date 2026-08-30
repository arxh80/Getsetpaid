import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadContact } from "@/lib/crm/queries";
import { formatTags } from "@/lib/crm/validate";
import { ContactForm } from "@/components/crm/contact-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { Alert } from "@/components/ui/alert";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/contacts/[contactId]/edit">): Promise<Metadata> {
  const { orgSlug, contactId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadContact(org.id, contactId);
  return {
    title:
      result.outcome === "found"
        ? `Edit ${result.record.name} · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function EditContactPage({
  params,
}: PageProps<"/[orgSlug]/contacts/[contactId]/edit">) {
  const { orgSlug, contactId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadContact(org.id, contactId),
    getCrmWriteAccess(org, "manage_contacts"),
  ]);

  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this contact just now. Refresh the page to try again —
        nothing has been changed.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const contact = result.record;
  const detailHref = `/${org.slug}/contacts/${contact.id}`;

  // A DELETED CONTACT IS NOT EDITABLE, and it is not a 404 either. The record
  // is there, the user can see it, and the honest answer is "restore it
  // first" -- which is also what the database says: updateContactAction's
  // predicate carries `deleted_at is null`, so an edit submitted from here
  // would match no rows and be reported as refused. Saying so up front is the
  // difference between a rule and a dead end.
  if (contact.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        <Breadcrumb href={detailHref} name={contact.name} orgSlug={org.slug} />
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Edit contact
        </h1>
        <Alert tone="info">
          {contact.name} has been deleted, so it can’t be edited. Restore it
          from its own page first and the form will be here.
        </Alert>
        <p>
          <Link
            href={detailHref}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            Go to {contact.name}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb href={detailHref} name={contact.name} orgSlug={org.slug} />
      <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
        Edit {contact.name}
      </h1>

      {access.canWrite ? (
        <ContactForm
          orgSlug={org.slug}
          values={{
            id: contact.id,
            name: contact.name,
            email: contact.email ?? "",
            phone: contact.phone ?? "",
            title: contact.title ?? "",
            location: contact.location ?? "",
            website: contact.website ?? "",
            tags: formatTags(contact.tags),
            // The RAW object, not the parsed entries: the form edits what is
            // stored, including a value the render side refuses to linkify.
            // Showing the user a blank field where a bad value is stored would
            // make it un-fixable through the product -- they would save the
            // form and the bad value would still be there.
            socials: contact.socialsRaw,
          }}
          cancelHref={detailHref}
        />
      ) : (
        <WriteBlockedNote access={access} id="edit-contact-blocked" />
      )}
    </div>
  );
}

function Breadcrumb({
  href,
  name,
  orgSlug,
}: {
  href: string;
  name: string;
  orgSlug: string;
}) {
  return (
    <p className="text-sm text-ink-muted">
      <Link
        href={`/${orgSlug}/contacts`}
        className="text-primary underline underline-offset-4 hover:text-ink"
      >
        Contacts
      </Link>
      {" › "}
      <Link
        href={href}
        className="break-words text-primary underline underline-offset-4 hover:text-ink"
      >
        {name}
      </Link>
    </p>
  );
}

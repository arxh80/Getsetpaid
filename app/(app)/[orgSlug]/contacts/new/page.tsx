import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { ContactForm } from "@/components/crm/contact-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";

// New contact.
//
// THE ROUTE IS GATED, NOT ONLY THE BUTTON THAT LEADS TO IT. A Read Only user
// who types this URL, or follows a link a colleague pasted, gets the
// explanation and no form -- rather than a form that submits and is refused.
// The form's action re-checks the same thing server-side and the RLS policy
// refuses the INSERT regardless, so this is the third of three and the only
// one the user ever sees.
//
// `/new` sits above `/[contactId]` in the same directory. Next resolves a
// static segment before a dynamic one, and ids here are uuids, so there is no
// contact this route can shadow.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/contacts/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `New contact · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NewContactPage({
  params,
}: PageProps<"/[orgSlug]/contacts/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const access = await getCrmWriteAccess(org, "manage_contacts");
  const basePath = `/${org.slug}/contacts`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Contacts
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          New contact
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          A person this workspace works with. Only a name is required — the rest
          can be filled in when you know it.
        </p>
      </div>

      {access.canWrite ? (
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
      ) : (
        <WriteBlockedNote access={access} id="new-contact-blocked" />
      )}
    </div>
  );
}

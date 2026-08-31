import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { NoteForm } from "@/components/crm/note-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/notes/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `New note · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function NewNotePage({ params }: PageProps<"/[orgSlug]/notes/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const access = await getCrmWriteAccess(org, "manage_notes");
  const basePath = `/${org.slug}/notes`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={basePath} className="text-primary underline underline-offset-4 hover:text-ink">
            Notes
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">New note</h1>
        <p className="max-w-prose text-base text-ink-muted">
          Free-form text. “Company” is shared with the workspace; “Private” is
          only ever seen by you. Link it to the records it is about from its own
          page.
        </p>
      </div>

      {access.canWrite ? (
        <NoteForm
          orgSlug={org.slug}
          values={{ body: "", visibility: "company" }}
          cancelHref={basePath}
        />
      ) : (
        <WriteBlockedNote access={access} id="new-note-blocked" />
      )}
    </div>
  );
}

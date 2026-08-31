import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadNote } from "@/lib/crm/queries";
import { NoteForm } from "@/components/crm/note-form";
import { Alert } from "@/components/ui/alert";

// Edit a note. AUTHOR-ONLY (Q54): a non-author is sent back to the record,
// where the read-only explanation is -- the update action refuses them anyway
// (the policy pins owner_user_id), so rendering the form would be a form whose
// submit cannot succeed.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/notes/[noteId]/edit">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Edit note · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function EditNotePage({
  params,
}: PageProps<"/[orgSlug]/notes/[noteId]/edit">) {
  const { orgSlug, noteId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access, user] = await Promise.all([
    loadNote(org.id, noteId),
    getCrmWriteAccess(org, "manage_notes"),
    getCurrentUser(),
  ]);

  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this note just now. Refresh the page to try again —
        nothing has been changed.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const note = result.record;
  const basePath = `/${org.slug}/notes`;
  const isAuthor = user !== null && note.ownerUserId === user.id;
  // Deleted, not the author, or no write access: back to the record, which
  // carries the correct explanation for each.
  if (note.deletedAt !== null || !isAuthor || !access.canWrite) {
    redirect(`${basePath}/${note.id}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/${note.id}`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Note
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Edit note</h1>
      </div>

      <NoteForm
        orgSlug={org.slug}
        values={{ id: note.id, body: note.body, visibility: note.visibility }}
        cancelHref={`${basePath}/${note.id}`}
      />
    </div>
  );
}

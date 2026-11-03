import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadNote } from "@/lib/crm/queries";
import { notePreview } from "@/lib/crm/notes-list";
import { NoteForm } from "@/components/crm/note-form";
import { Alert } from "@/components/ui/alert";
import { DeletedRecordNotice } from "@/components/crm/deleted-record-notice";

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
  const detailHref = `${basePath}/${note.id}`;
  const isAuthor = user !== null && note.ownerUserId === user.id;

  // DELETED IS EXPLAINED IN PLACE, like every other edit route. It used to be
  // one of three conditions bundled into a single redirect; it is now answered
  // where the user asked, with the link to Restore still there.
  //
  // A note has no name, so the notice is given the first words of its body --
  // the same handle the notes list and the command palette use to identify one.
  if (note.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-sm text-ink-muted">
          <Link
            href={detailHref}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Note
          </Link>
        </p>
        <DeletedRecordNotice
          label={notePreview(note.body, 60)}
          noun="note"
          detailHref={detailHref}
        />
      </div>
    );
  }

  // NOT THE AUTHOR, OR NO WRITE ACCESS: STILL A REDIRECT, and deliberately so.
  // A note is author-only writable (Q54), which no other entity is, and the
  // note's own page already renders the right sentence for each of those two
  // cases with context this page does not have -- whose note it is, and what
  // the reader may do with it instead. Explaining "deleted" here and leaving
  // these there is not a half-measure: deleted is a state the record is in and
  // Restore is the answer, while these two are facts about the CALLER, which
  // the record page is the honest place to state.
  if (!isAuthor || !access.canWrite) {
    redirect(detailHref);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={detailHref}
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
        cancelHref={detailHref}
      />
    </div>
  );
}

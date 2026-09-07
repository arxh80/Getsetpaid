import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  DELETED_RECORD_EXPLANATION,
  getCrmWriteAccess,
} from "@/lib/crm/write-access";
import { loadLinkOptionGroups, loadLinksFor, loadNote } from "@/lib/crm/queries";
import { NOTE_VISIBILITY_LABELS } from "@/lib/crm/task-status";
import { EntityLinkPicker } from "@/components/crm/entity-link-picker";
import { deleteNoteAction, restoreNoteAction } from "@/lib/crm/notes";
import { Alert } from "@/components/ui/alert";
import { DeleteRecordForm, RestoreRecordForm } from "@/components/crm/delete-restore";
import { SecondaryRecordAction, WriteBlockedNote } from "@/components/crm/write-gate";
import { formatDateTime } from "@/lib/format/date";

// One note, with the entity-link picker.
//
// A NOTE IS AUTHOR-ONLY WRITABLE (Q54): only its author may edit, delete, or
// change its links -- the DB policies pin `owner_user_id = auth.uid()` on every
// note and note_link write. So the write controls here are gated on AUTHORSHIP
// as well as the permission: a colleague can read a company note but not touch
// it, and hiding the control (with an explanation) matches the refusal the
// policy would give.

const AUTHOR_ONLY = "Only the person who wrote this note can change it.";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/notes/[noteId]">): Promise<Metadata> {
  const { orgSlug, noteId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadNote(org.id, noteId);
  return {
    title:
      result.outcome === "found"
        ? `Note · Notes · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

const MANAGE_NOTE = "note-manage-blocked";

export default async function NoteDetailPage({
  params,
}: PageProps<"/[orgSlug]/notes/[noteId]">) {
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
        nothing has been deleted.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const note = result.record;
  const basePath = `/${org.slug}/notes`;
  const deleted = note.deletedAt !== null;
  const isAuthor = user !== null && note.ownerUserId === user.id;
  const canEdit = access.canWrite && isAuthor;

  // The reason a control is blocked, most specific first: deleted, then
  // authorship, then the permission itself.
  const manageBlocked = deleted
    ? DELETED_RECORD_EXPLANATION
    : !isAuthor
      ? AUTHOR_ONLY
      : access.canWrite
        ? null
        : access.explanation;

  const [links, optionGroups] = await Promise.all([
    loadLinksFor("notes", org.id, note.id),
    canEdit && !deleted ? loadLinkOptionGroups(org.id) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={basePath} className="text-primary underline underline-offset-4 hover:text-ink">
            Notes
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Note</h1>
        <div className="flex flex-wrap items-center gap-3">
          <span className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
            {NOTE_VISIBILITY_LABELS[note.visibility]}
          </span>
          <span className="text-sm text-ink-muted">
            Added{" "}
            <time dateTime={note.createdAt} className="tabular-nums">
              {formatDateTime(note.createdAt)}
            </time>
          </span>
        </div>
      </div>

      {deleted ? (
        <Alert tone="info">
          {DELETED_RECORD_EXPLANATION} It was deleted on{" "}
          <time dateTime={note.deletedAt!} className="tabular-nums">
            {formatDateTime(note.deletedAt!)}
          </time>
          .
        </Alert>
      ) : null}

      <section className="border-t border-rule pt-6">
        {/* The body is UNTRUSTED free text, rendered as TEXT (React escapes it),
            never through dangerouslySetInnerHTML. whitespace-pre-line keeps the
            line breaks the author typed. */}
        <p className="max-w-prose text-base break-words whitespace-pre-line text-ink">
          {note.body}
        </p>
      </section>

      <EntityLinkPicker
        orgSlug={org.slug}
        parentTable="notes"
        parentId={note.id}
        linked={links}
        optionGroups={optionGroups}
        disabledReason={manageBlocked}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Manage</h2>
        {/* One explanation for the group. When the block is authorship rather
            than the permission, WriteBlockedNote (which keys off access) would
            say the wrong thing, so the note is rendered directly. */}
        {manageBlocked !== null && !deleted ? (
          <p
            id={MANAGE_NOTE}
            className="max-w-prose border border-rule bg-surface px-3 py-3 text-sm text-ink-muted"
          >
            <span className="font-semibold text-ink">Read-only.</span> {manageBlocked}
          </p>
        ) : (
          <WriteBlockedNote access={access} id={MANAGE_NOTE} />
        )}
        {!deleted ? (
          <>
            <div className="flex flex-wrap items-start gap-4">
              {canEdit ? (
                <SecondaryRecordAction
                  access={access}
                  href={`${basePath}/${note.id}/edit`}
                  label="Edit note"
                  describedBy={MANAGE_NOTE}
                />
              ) : (
                // Non-author (or no write permission): an inert button with the
                // group's explanation, the same shape SecondaryRecordAction
                // renders for a blocked write. Not a synthetic CrmWriteAccess --
                // authorship is not one of its reasons.
                <button
                  type="button"
                  disabled
                  aria-describedby={MANAGE_NOTE}
                  className="inline-flex h-11 items-center justify-center border border-rule bg-surface px-4 text-base font-semibold whitespace-nowrap text-ink cursor-not-allowed opacity-55"
                >
                  Edit note
                </button>
              )}
            </div>
            <DeleteRecordForm
              action={deleteNoteAction}
              hiddenFields={{ orgSlug: org.slug, noteId: note.id }}
              label="Delete note"
              question={`Delete this note? It comes out of the notes list. Its links stay with it and can be restored from Notes › Deleted.`}
              blocked={!canEdit}
              describedBy={MANAGE_NOTE}
            />
          </>
        ) : (
          <RestoreRecordForm
            action={restoreNoteAction}
            hiddenFields={{ orgSlug: org.slug, noteId: note.id }}
            label="Restore note"
            blocked={!canEdit}
            describedBy={MANAGE_NOTE}
          />
        )}
      </section>
    </div>
  );
}

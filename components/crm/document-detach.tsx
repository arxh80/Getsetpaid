"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { removeLinkAction } from "@/lib/crm/link-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Detach one document from one CRM record, in the related panel.
//
// ===========================================================================
// A PER-ENTITY DETACH, NOT A DELETE — AND THE DIFFERENCE IS THE POINT
// ===========================================================================
// This soft-deletes the ONE `document_links` row attaching this document to
// this record (removeLinkAction, Task 3, { count: "exact" }). The document and
// its attachments to every OTHER record are untouched — which is exactly why
// deleting the document from /documents is the wrong way to un-attach it: that
// removes it from everything at once. Documents have no detail page, so the
// panel is where this has to live (tasks/notes detach from their own pages via
// components/crm/entity-link-picker.tsx; a document has nowhere else to go).
//
// ===========================================================================
// WHY router.refresh() ON SUCCESS
// ===========================================================================
// removeLinkAction revalidates the PARENT's path — `/{org}/documents/{docId}`,
// a page that does not exist — because for a task or a note the parent's page
// IS the page the picker sits on. Here the panel is on the TARGET record's page
// (a contact, an event), which that revalidation does not touch. So on success
// we refresh the current route, dropping the detached row from the panel. With
// JavaScript off, the plain form POST reloads the page anyway and the panel
// re-reads without this; this is the client-navigation path's equivalent.
//
// authorised on manage_documents (PERMISSION_FOR_LINK_PARENT['documents'],
// Task 3) by removeLinkAction itself; hiding this control is not the control.
// When the caller cannot write it renders inert with an explanation
// (aria-describedby), the write-gate discipline.

export function DocumentDetachControl({
  orgSlug,
  documentId,
  linkId,
  filename,
  blocked,
  describedBy,
}: {
  orgSlug: string;
  documentId: string;
  linkId: string;
  filename: string;
  blocked: boolean;
  describedBy: string;
}) {
  const [state, formAction, pending] = useActionState(
    removeLinkAction,
    EMPTY_FORM_STATE,
  );
  const router = useRouter();
  useEffect(() => {
    if (state.message) router.refresh();
  }, [state.message, router]);

  if (blocked) {
    return (
      <Button type="button" variant="quiet" disabled aria-describedby={describedBy}>
        <span aria-hidden="true">Detach</span>
        <span className="sr-only">Detach {filename}</span>
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="parentTable" value="documents" />
      <input type="hidden" name="parentId" value={documentId} />
      <input type="hidden" name="linkId" value={linkId} />
      <Button type="submit" variant="quiet" pending={pending} pendingLabel="Detaching…">
        <span aria-hidden="true">Detach</span>
        <span className="sr-only">Detach {filename}</span>
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

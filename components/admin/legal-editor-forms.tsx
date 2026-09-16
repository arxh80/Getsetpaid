"use client";

import { useActionState } from "react";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import {
  createLegalDraftAction,
  publishLegalDocumentAction,
  recordCounselReviewAction,
  saveLegalDraftAction,
} from "@/lib/legal/admin-actions";
import { Field, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The four legal-editor forms. Uncontrolled, echoing submitted values back on
// failure (lib/forms.ts' React 19 reset note), each carrying the slug and --
// where it acts on a version -- the document id as hidden fields. Neither is
// trusted: every action re-derives authority from the session, and every RPC
// re-checks the id against the row's actual status.

export function CreateDraftForm({ slug }: { slug: string }) {
  const [state, formAction, pending] = useActionState(createLegalDraftAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <input type="hidden" name="slug" value={slug} />
      <p className="text-sm text-ink-muted">
        Starts the next version as a private draft, copied from the current
        public text. Nothing public changes until you publish it.
      </p>
      <div>
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Creating…">
          Start a new draft
        </Button>
      </div>
    </form>
  );
}

export function DraftEditForm({
  slug,
  documentId,
  title,
  body,
  effectiveDate,
}: {
  slug: string;
  documentId: string;
  title: string;
  body: string;
  effectiveDate: string;
}) {
  const [state, formAction, pending] = useActionState(saveLegalDraftAction, EMPTY_FORM_STATE);
  const values = state.values;
  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="documentId" value={documentId} />

      <Field
        label="Title"
        name="title"
        required
        maxLength={200}
        defaultValue={values?.title ?? title}
        error={state.fieldErrors?.title}
        hint="The page heading readers see."
      />
      <Field
        label="Effective date"
        name="effectiveDate"
        type="date"
        required
        defaultValue={values?.effectiveDate ?? effectiveDate}
        error={state.fieldErrors?.effectiveDate}
        hint="Shown under the title. Counsel may want it to be the day this version is published."
      />
      <TextAreaField
        label="Text"
        name="body"
        required
        rows={24}
        spellCheck
        className="font-mono"
        defaultValue={values?.body ?? body}
        error={state.fieldErrors?.body}
        hint={
          <>
            ## for a section heading, ### for a sub-heading, - for a list item,
            **bold**, and [link text](https://…) — links may start with
            https://, mailto: or a single / for a page on this site. HTML is
            not allowed. Placeholders: {"{{support_email}}"} (the configured
            contact address), and on a line of their own{" "}
            {"{{subprocessors}}"} and {"{{storage_inventory}}"}. Saving a
            reviewed draft with changed text clears its counsel review.
          </>
        }
      />
      <div>
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…">
          Save draft
        </Button>
      </div>
    </form>
  );
}

export function PublishDraftForm({
  slug,
  documentId,
  version,
  reviewed,
}: {
  slug: string;
  documentId: string;
  version: number;
  reviewed: boolean;
}) {
  const [state, formAction, pending] = useActionState(publishLegalDocumentAction, EMPTY_FORM_STATE);
  const confirmId = `publish-confirm-${documentId}`;
  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="documentId" value={documentId} />
      <p className="text-sm text-ink">
        Publishing makes version <span className="tabular-nums">{version}</span> the
        public page immediately. It cannot be edited or withdrawn afterwards —
        a correction is a new version.{" "}
        {reviewed ? (
          "Counsel's review of this draft is recorded, so it will publish without the draft notice."
        ) : (
          <strong className="font-semibold">
            Counsel has not reviewed this draft, so the public page will show the
            “draft pending legal review” notice.
          </strong>
        )}
      </p>
      <label htmlFor={confirmId} className="flex items-start gap-2 text-sm text-ink">
        <input
          id={confirmId}
          type="checkbox"
          name="confirm"
          value="yes"
          required
          aria-describedby={state.fieldErrors?.confirm ? `${confirmId}-error` : undefined}
          className="mt-1 h-4 w-4"
        />
        <span>Make version {version} the public version.</span>
      </label>
      {state.fieldErrors?.confirm ? (
        <p id={`${confirmId}-error`} className="text-sm text-danger">
          {state.fieldErrors.confirm}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Publishing…">
          Publish version {version}
        </Button>
      </div>
    </form>
  );
}

export function RecordReviewForm({
  slug,
  documentId,
  version,
  which,
}: {
  slug: string;
  documentId: string;
  version: number;
  /** "draft" or "current" -- only changes the wording. */
  which: "draft" | "current";
}) {
  const [state, formAction, pending] = useActionState(recordCounselReviewAction, EMPTY_FORM_STATE);
  const confirmId = `review-confirm-${documentId}`;
  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="documentId" value={documentId} />
      <Field
        label={`Reviewed by (version ${version})`}
        name="reviewer"
        required
        maxLength={200}
        defaultValue={state.values?.reviewer ?? ""}
        error={state.fieldErrors?.reviewer}
        hint="The firm or person who reviewed this exact text. Kept with the version for the operator; not shown publicly and not copied into the audit log."
      />
      <label htmlFor={confirmId} className="flex items-start gap-2 text-sm text-ink">
        <input
          id={confirmId}
          type="checkbox"
          name="confirm"
          value="yes"
          required
          className="mt-1 h-4 w-4"
        />
        <span>
          I hold counsel’s sign-off for the text of this {which === "draft" ? "draft" : "public version"},
          exactly as it stands. This removes the draft notice
          {which === "draft" ? " once it is published" : " from the public page now"}, and cannot be undone.
        </span>
      </label>
      {state.fieldErrors?.confirm ? (
        <p className="text-sm text-danger">{state.fieldErrors.confirm}</p>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Recording…">
          Record counsel’s review
        </Button>
      </div>
    </form>
  );
}

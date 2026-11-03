"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { submitFeedbackAction } from "@/lib/feedback/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_MESSAGE_MAX,
  SCREENSHOT_WARNING,
} from "@/lib/feedback/contract";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { SelectField, TextAreaField } from "@/components/ui/field";

// The in-app feedback control: a "Feedback" trigger in the site header and a
// modal form. CLAUDE.md § In-app feedback.
//
// ===========================================================================
// REACHABLE FROM ANYWHERE, AND IT CAPTURES WHERE THE USER WAS
// ===========================================================================
// Mounted in app/(app)/layout.tsx's header, so every signed-in screen -- a
// record page, /invites, /super/* -- carries it. It is a MODAL over the page
// rather than a page of its own, and that is what makes "current page/route"
// mean where the user WAS: a server action POSTs to the URL of the page it was
// rendered on, so lib/feedback/actions.ts reads the route off the request and
// the user never types (or sees a field for) their own URL.
//
// ===========================================================================
// A NATIVE <dialog>, OPENED WITH showModal()
// ===========================================================================
// The platform gives the modal contract for free and correctly: focus moves
// into the dialog on open, is trapped inside it, Escape closes it, and focus
// returns to the trigger on close. A <div role="dialog"> would re-implement
// all four and get at least one wrong. It is styled to DESIGN.md § Shape's
// modal rule -- a 1px --ink border on --surface over the --scrim backdrop,
// square, no shadow -- through the tokens.
//
// The trigger is a <button>, and the dialog is JavaScript-only: there is no
// no-JS path to OPEN it, the same as the command palette. The form inside it
// is an ordinary uncontrolled <form action> like every other in the product.
//
// ===========================================================================
// THE WARNING IS BEFORE THE FILE PICKER, IN THE DOM AND ON THE SCREEN
// ===========================================================================
// "The submit UI must warn the user before upload that the screenshot may
// include on-screen data" -- and this is the one deliberate exception to the
// no-direct-tenant-data rule, so the sentence is a product requirement. It
// renders as its own paragraph ABOVE the file input (not as a hint below it),
// is wired to the input by aria-describedby so a screen reader hears it on
// reaching the control, and tests/e2e/feedback.spec.ts asserts the DOM order.

export function FeedbackDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    submitFeedbackAction,
    EMPTY_FORM_STATE,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const warningId = "feedback-screenshot-warning";
  const screenshotErrorId = "feedback-screenshot-error";
  const screenshotError = state.fieldErrors?.screenshot;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-primary underline underline-offset-4 hover:text-ink"
      >
        Feedback
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        aria-labelledby="feedback-dialog-title"
        className="m-auto w-[min(40rem,calc(100%-2rem))] border border-ink bg-surface p-0 text-ink backdrop:bg-scrim"
      >
        <form
          // Remount to empty after a successful submit; a failed one keeps
          // what was typed through `values` (lib/forms.ts).
          key={state.message ?? "feedback-form"}
          action={formAction}
          className="flex flex-col gap-4 p-6"
        >
          <div className="flex items-start justify-between gap-4">
            <h2
              id="feedback-dialog-title"
              className="tracking-display text-2xl font-extrabold text-ink"
            >
              Send feedback
            </h2>
            <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
          <p className="max-w-prose text-base text-ink-muted">
            A bug, an idea, or anything else. It goes to the GetSetPaid
            operator with your name, your workspace and the page you are on.
          </p>

          {state.error ? <Alert tone="error">{state.error}</Alert> : null}
          {state.message ? <Alert tone="success">{state.message}</Alert> : null}

          <SelectField
            label="Category"
            name="category"
            required
            defaultValue={state.values?.category ?? ""}
            error={state.fieldErrors?.category}
          >
            <option value="" disabled>
              Choose…
            </option>
            {FEEDBACK_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {FEEDBACK_CATEGORY_LABELS[category]}
              </option>
            ))}
          </SelectField>

          <TextAreaField
            label="Message"
            name="message"
            required
            rows={6}
            maxLength={FEEDBACK_MESSAGE_MAX}
            defaultValue={state.values?.message ?? ""}
            error={state.fieldErrors?.message}
          />

          {/* THE WARNING, BEFORE THE PICKER. See the header. */}
          <p
            id={warningId}
            className="max-w-prose border border-rule-strong bg-surface px-3 py-3 text-sm text-ink"
          >
            <span className="font-semibold">Before you attach a screenshot.</span>{" "}
            {SCREENSHOT_WARNING}
          </p>

          <div className="flex flex-col gap-2">
            <label htmlFor="feedback-screenshot" className="text-sm font-semibold text-ink">
              Screenshot
              <span className="ml-2 font-normal text-ink-muted">Optional</span>
            </label>
            <input
              key={`shot:${state.error ?? ""}:${screenshotError ?? ""}`}
              id="feedback-screenshot"
              type="file"
              name="screenshot"
              accept=".png,.jpg,.jpeg,.webp,.gif"
              aria-describedby={
                screenshotError ? `${warningId} ${screenshotErrorId}` : warningId
              }
              aria-invalid={screenshotError ? true : undefined}
              className={
                "w-full min-w-0 border bg-surface px-3 py-2 text-base text-ink " +
                "file:mr-3 file:border file:border-rule file:bg-shell file:px-3 file:py-1 " +
                "file:text-sm file:font-semibold file:text-ink " +
                "transition-colors duration-[var(--dur-fast)] ease-brand " +
                (screenshotError
                  ? "border-danger"
                  : "border-rule hover:border-ink focus:border-accent")
              }
            />
            {screenshotError ? (
              <p id={screenshotErrorId} role="alert" className="text-sm font-semibold text-danger">
                {screenshotError}
              </p>
            ) : null}
            <p className="text-sm text-ink-muted">
              One image, up to 5&nbsp;MiB — PNG, JPEG, WebP or GIF. It is
              scanned before anyone can open it.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button type="submit" pending={pending} pendingLabel="Sending…">
              Send feedback
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}

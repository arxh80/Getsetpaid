"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { unstable_rethrow } from "next/navigation";
import type { FormState } from "@/lib/forms";
import { Alert } from "@/components/ui/alert";

// WHERE THE LEGAL EDITOR SAYS WHAT HAPPENED (Phase 8 Task 1, fix round 1, I1).
//
// Each editor form used to render its own `useActionState` message. Every
// successful action then re-renders the page (revalidatePath) into a tree that
// no longer contains that form: "Start a new draft" is replaced by the draft,
// the draft form is keyed on its `updatedAt` and remounts, the publish form
// leaves with the draft, and the review form is replaced by the "recorded"
// paragraph. So every confirmation was thrown away by the render that should
// have shown it, and the operator never read "Published."
//
// The outcome now lives HERE, in a provider rendered ABOVE the conditional
// parts of the editor (app/(app)/super/legal/page.tsx), so the swap below it
// cannot unmount it. Each form reports its action's result as the action
// resolves; the provider keeps the latest one. Errors travel the same way, so
// an error is not lost either if the page changes underneath the form (a
// draft published from another tab, say). Field-level errors stay beside
// their fields, in the form.
//
// Two PERSISTENT live regions, present (empty) from the first render, because
// a live region inserted together with its content is not reliably announced:
// `role="status"` (polite) for a success, `role="alert"` (assertive) for a
// failure. The Alert inside each is rendered without a role of its own so the
// message is not announced twice.
//
// Keyed on the document slug by the page, so moving to another document
// starts with an empty region rather than the last document's news.
//
// FIX ROUND 2:
//   * EVERY OUTCOME IS A FRESH ANNOUNCEMENT. Two identical outcomes in a row
//     ("Draft saved." twice) used to replace a text node with the same text,
//     which some screen readers do not announce again. Each outcome now
//     carries a sequence number and the Alert is keyed on it, so React
//     removes the old node and inserts a new one -- an addition inside the
//     live region, announced once (the Alert still has no role of its own).
//   * A THROWN ACTION NO LONGER LEAVES THE PREVIOUS MESSAGE UP. A Server
//     Action can reject instead of returning: a network failure, or Next.js's
//     own redirect / not-found signal. The first becomes a generic error in
//     the region (and the form keeps its previous state, so nothing typed is
//     lost); the second clears the region and is re-thrown, so Next.js still
//     performs the navigation.

export type Outcome = {
  readonly seq: number;
  readonly tone: "success" | "error";
  readonly text: string;
} | null;

/** What the region shows after an action resolved with `state`. Pure. */
export function nextOutcome(previous: Outcome, state: FormState): Outcome {
  const seq = (previous?.seq ?? 0) + 1;
  if (state.error) return { seq, tone: "error", text: state.error };
  if (state.message) return { seq, tone: "success", text: state.message };
  return null;
}

/** The region's sentence when an action rejects rather than returning. */
// It cannot say whether the change was made: a request can reach the server
// and lose its response. So it says so, and points at the page's own state.
export const ACTION_FAILED_MESSAGE =
  "That request did not finish, so this page cannot tell whether it took effect. Reload the page to see the current state before trying again.";

type Report = (state: FormState) => void;

/**
 * Run `action` and report its outcome -- the part of useReportedAction that
 * needs no React, exported for tests/unit/legal/editor-outcome.test.ts.
 *
 * `rethrow` is Next.js's `unstable_rethrow`: it throws the error again if it
 * is one of Next's control-flow signals (a redirect, notFound, ...) and
 * returns otherwise.
 */
export async function runReported(
  action: (prev: FormState, formData: FormData) => Promise<FormState>,
  report: Report,
  rethrow: (error: unknown) => void,
  prev: FormState,
  formData: FormData,
): Promise<FormState> {
  let next: FormState;
  try {
    next = await action(prev, formData);
  } catch (error) {
    // Clear first: whatever happens next, the old message is stale.
    report({});
    rethrow(error);
    report({ error: ACTION_FAILED_MESSAGE });
    return prev;
  }
  report(next);
  return next;
}

const OutcomeContext = createContext<Report | null>(null);

export function LegalEditorOutcome({ children }: { children: ReactNode }) {
  const [latest, setLatest] = useState<Outcome>(null);

  const report = useCallback<Report>((state) => {
    setLatest((previous) => nextOutcome(previous, state));
  }, []);

  return (
    <OutcomeContext.Provider value={report}>
      <div className="flex flex-col gap-2" data-testid="legal-editor-outcome">
        <div role="status">
          {latest?.tone === "success" ? (
            <Alert key={latest.seq} tone="success" live={false}>
              {latest.text}
            </Alert>
          ) : null}
        </div>
        <div role="alert">
          {latest?.tone === "error" ? (
            <Alert key={latest.seq} tone="error" live={false}>
              {latest.text}
            </Alert>
          ) : null}
        </div>
      </div>
      {children}
    </OutcomeContext.Provider>
  );
}

/**
 * Wraps a Server Action so its result is reported to the surviving region
 * before it is handed back to the form's own `useActionState`.
 */
export function useReportedAction(
  action: (prev: FormState, formData: FormData) => Promise<FormState>,
): (prev: FormState, formData: FormData) => Promise<FormState> {
  const report = useContext(OutcomeContext);
  if (report === null) {
    throw new Error(
      "legal editor forms must be rendered inside <LegalEditorOutcome>",
    );
  }
  return useCallback(
    (prev: FormState, formData: FormData) =>
      runReported(action, report, unstable_rethrow, prev, formData),
    [action, report],
  );
}

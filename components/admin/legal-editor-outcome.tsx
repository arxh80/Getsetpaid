"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
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

type Report = (state: FormState) => void;

const OutcomeContext = createContext<Report | null>(null);

export function LegalEditorOutcome({ children }: { children: ReactNode }) {
  const [latest, setLatest] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const report = useCallback<Report>((state) => {
    if (state.error) setLatest({ tone: "error", text: state.error });
    else if (state.message) setLatest({ tone: "success", text: state.message });
    else setLatest(null);
  }, []);

  return (
    <OutcomeContext.Provider value={report}>
      <div className="flex flex-col gap-2" data-testid="legal-editor-outcome">
        <div role="status">
          {latest?.tone === "success" ? (
            <Alert tone="success" live={false}>
              {latest.text}
            </Alert>
          ) : null}
        </div>
        <div role="alert">
          {latest?.tone === "error" ? (
            <Alert tone="error" live={false}>
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
    async (prev: FormState, formData: FormData) => {
      const next = await action(prev, formData);
      report(next);
      return next;
    },
    [action, report],
  );
}

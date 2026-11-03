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

// WHERE A PAGE SAYS WHAT AN ACTION DID -- IN A REGION THE ACTION'S OWN
// RE-RENDER CANNOT UNMOUNT.
//
// THIS BUG HAS SHIPPED THREE TIMES IN ONE PHASE, which is why it is a shared
// component now and not a pattern to remember:
//
//   * Phase 8 Task 1, I1 -- every legal-editor confirmation ("Published.") was
//     rendered by the form that submitted it, and the revalidated page no
//     longer held that form.
//   * Phase 8 Task 3, the requester's side -- "Your request has been
//     withdrawn." lived in a component rendered only while the request was
//     open, and a successful withdrawal closes it.
//   * Phase 8 Task 3, the operator's side (review finding I6) -- "Marked
//     Refused." and "Marked Answered." were never seen by anybody: in the
//     default open-only queue the row unmounts, and in the show-closed view the
//     component took an early return ABOVE its own live region. Refusing a
//     statutory request, after a step-up prompt, answered with a row vanishing.
//
// THE SHAPE OF IT: a Server Action that calls revalidatePath() re-renders the
// page into a tree that may no longer contain the component whose
// useActionState holds the result. So the outcome does not live in that
// component. It lives HERE, in a provider the page renders ABOVE everything an
// action on it can add, remove, re-key or re-order. Each form wraps its action
// in useReportedAction(), which hands the result to the provider as the action
// resolves; the provider keeps the latest one. Errors travel the same way, so
// an error is not lost either if the page changes underneath the form.
// Field-level errors stay beside their fields, in the form.
//
// Two PERSISTENT live regions, present (empty) from the first render, because
// a live region inserted together with its content is not reliably announced:
// `role="status"` (polite) for a success, `role="alert"` (assertive) for a
// failure. The Alert inside each is rendered without a role of its own so the
// message is not announced twice.
//
//   * EVERY OUTCOME IS A FRESH ANNOUNCEMENT. Two identical outcomes in a row
//     ("Draft saved." twice) would replace a text node with the same text,
//     which some screen readers do not announce again. Each outcome carries a
//     sequence number and the Alert is keyed on it, so React removes the old
//     node and inserts a new one -- an addition inside the live region.
//   * A THROWN ACTION NEVER LEAVES THE PREVIOUS MESSAGE UP. A Server Action can
//     reject instead of returning: a network failure, or Next.js's own
//     redirect / not-found signal. The first becomes a generic error in the
//     region (and the form keeps its previous state, so nothing typed is
//     lost); the second clears the region and is re-thrown, so Next.js still
//     performs the navigation.
//
// tests/unit/forms/action-outcome-census.test.ts holds the surfaces that have
// had this bug to the rule: every useActionState on them takes a reported
// action, and none renders its own `state.message`.

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

export function ActionOutcome({
  children,
  testId = "action-outcome",
}: {
  children: ReactNode;
  /** The region's data-testid: a page with its own e2e history keeps its name. */
  testId?: string;
}) {
  const [latest, setLatest] = useState<Outcome>(null);

  const report = useCallback<Report>((state) => {
    setLatest((previous) => nextOutcome(previous, state));
  }, []);

  return (
    <OutcomeContext.Provider value={report}>
      <div className="flex flex-col gap-2" data-testid={testId}>
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
      "a form that reports its outcome must be rendered inside <ActionOutcome>",
    );
  }
  return useCallback(
    (prev: FormState, formData: FormData) =>
      runReported(action, report, unstable_rethrow, prev, formData),
    [action, report],
  );
}
